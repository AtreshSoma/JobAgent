/**
 * Helpers for the assist run (audit A14): page reading, the post-submit check,
 * the hand-over to the human. Split out of applyRunner.js so the states in
 * assistStages.js and the submit gate in applyRunner.js can share them.
 */
import { inspectCurrentPage } from './browser.js';
import { resolveFormScope, scanFields, applicationFields, detectValidationErrors } from './domScanner.js';
import { findAdvanceControl, findSubmitControl } from './navigator.js';
import { detectBlocker, visibleText } from './guards.js';
import { isSensitiveChoiceLabel } from './fieldFiller.js';
import { isSponsorshipTopic } from '../apply/screeningQA.js';
import { LIFECYCLE } from '../lifecycle.js';

/** Should the runner watch a handed-over window for the human's submission? */
export function shouldWatchForHumanSubmit(result, options, page) {
  if (options.watchHumanSubmit === false || result.submitted) return false;
  if (![LIFECYCLE.READY_FOR_SUBMIT, LIFECYCLE.ASSIST_BLOCKED].includes(result.status)) return false;
  return Boolean(page) && typeof page.on === 'function';
}

/** Default: stop watching a handed-over window after 45 minutes. */
const HUMAN_SUBMIT_WATCH_MS = 45 * 60 * 1000;

/**
 * Watch a page the human is finishing for the ATS's confirmation page.
 *
 * Evidence is the SAME as for an auto-submit (`verifySubmission`), but only
 * its strongest signal counts here: a visible confirmation message. "The URL
 * changed and the form is gone" is what a human browsing away looks like, so
 * it is not accepted. A confirmation phrase already visible when watching
 * starts (a sidebar "Thanks for applying to other roles") only counts after
 * the page has navigated. Stops on the first match, when the page closes, or
 * after `timeoutMs`.
 *
 * @param {object} args
 * @param {object} args.page Playwright page
 * @param {string} args.url application URL (fallback for inspection)
 * @param {Function} args.inspectPage inspectCurrentPage-compatible
 * @param {(verification: object) => Promise<void>|void} args.onConfirmed
 * @param {number} [args.pollMs=1500]
 * @param {number} [args.timeoutMs]
 * @returns {{ stop: () => void, readonly stopped: boolean, ready: Promise<void> }}
 */
export function watchForHumanSubmission({
  page, url, inspectPage = inspectCurrentPage, onConfirmed, pollMs = 1500, timeoutMs = HUMAN_SUBMIT_WATCH_MS,
} = {}) {
  let stopped = false;
  let checking = false;
  let navigated = false;
  let baselineHit = false;
  const timers = [];
  const trail = [];
  const remember = (u) => { if (u && trail.at(-1) !== u) trail.push(u); if (trail.length > 50) trail.shift(); };
  try { remember(page.url?.()); } catch { /* fakes */ }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const t of timers) { clearInterval(t); clearTimeout(t); }
    try { page.off?.('framenavigated', onNavigate); } catch { /* ignore */ }
    try { page.off?.('close', stop); } catch { /* ignore */ }
  };

  const check = async () => {
    if (stopped || checking) return;
    checking = true;
    try {
      if (page.isClosed?.()) { stop(); return; }
      let here = null;
      try { here = page.url?.() ?? null; } catch { here = null; }
      const destination = postSubmitDestination(trail, here);
      remember(here);
      if (destination) {
        stop();
        await onConfirmed?.({ verified: true, signals: [`post-submit page: ${destination}`], lastUrl: here });
        return;
      }
      if (baselineHit && !navigated) return;
      const verification = await verifySubmission({ page, url, beforeUrl: null, inspectPage });
      if (!stopped && verification.verified && verification.signals.includes('confirmation message')) {
        stop();
        await onConfirmed?.(verification);
      }
    } catch { /* a page mid-navigation is checked again on the next tick */ } finally {
      checking = false;
    }
  };

  function onNavigate(frame) {
    // Only the PAGE navigating is evidence the human moved on. An ad, analytics
    // or chat-widget iframe loading used to set `navigated` too — and that flag
    // is what lets a confirmation phrase already on screen ("Thanks for
    // applying to other roles" in a sidebar) count as this job's submission.
    try {
      if (frame && typeof page.mainFrame === 'function' && frame !== page.mainFrame()) return;
    } catch { return; }
    navigated = true;
    try { remember(frame?.url?.() ?? page.url?.()); } catch { /* ignore */ }
    // Give the new document a moment to render its confirmation text.
    const t = setTimeout(check, 250);
    t.unref?.();
    timers.push(t);
  }

  page.on('framenavigated', onNavigate);
  page.on('close', stop);
  const ready = (async () => {
    try {
      const html = await page.content();
      baselineHit = SUBMIT_CONFIRMATION_RE.test(visibleText(html));
    } catch { baselineHit = false; }
    if (stopped) return;
    const poll = setInterval(check, Math.max(50, Number(pollMs) || 1500));
    poll.unref?.();
    timers.push(poll);
    const deadline = setTimeout(stop, Math.max(1000, Number(timeoutMs) || HUMAN_SUBMIT_WATCH_MS));
    deadline.unref?.();
    timers.push(deadline);
  })();

  return { stop, get stopped() { return stopped; }, ready };
}

/**
 * Folder name of the persistent browser profile for a search profile/channel.
 * @param {{channel?: string|null, profileId?: string|null}} args
 * @returns {string}
 */
export function browserProfileDirName({ channel = null, profileId = null } = {}) {
  const profile = String(profileId ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return ['.browser-profile', profile, channel].filter(Boolean).join('-');
}

/** Lower-case, punctuation-free comparison form of a label or answer. */
function normAnswer(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Live answers to sensitive questions (sponsorship, authorization, legal,
 * EEO) that the reviewed packet does not contain with the same meaning.
 *
 * A live answer is "reviewed" when the packet planned an answer for the same
 * question and the committed text is that answer, or starts with the same
 * yes/no. Exported for tests.
 *
 * @param {Array<{label: string, value: string}>} live result.liveAnswers
 * @param {Array<{label?: string, answer?: string, value?: string}>} reviewed packet.screeningPlan.answered
 * @returns {Array<{label: string, value: string}>}
 */
export function unreviewedSensitiveAnswers(live = [], reviewed = []) {
  const planned = new Map(reviewed
    .filter((r) => r?.label)
    .map((r) => [normAnswer(r.label), normAnswer(r.answer ?? r.value)]));
  const lead = (t) => (/^(yes|y)\b/.test(t) ? 'yes' : /^(no|n)\b/.test(t) ? 'no' : null);
  return live.filter((a) => {
    const label = String(a?.label ?? '');
    if (!isSensitiveChoiceLabel(label) && !isSponsorshipTopic(label)) return false;
    const want = planned.get(normAnswer(label));
    if (want === undefined) return true;
    const got = normAnswer(a.value);
    if (!got) return true;
    if (got === want || want.startsWith(got) || got.startsWith(want)) return false;
    return !(lead(got) && lead(got) === lead(want));
  });
}

/** Was the checkpoint's last URL a wall (flagged, or a login-shaped URL)? */
export function unsafeResumeUrl(state) {
  if (state?.lastUrlUnsafe === true) return true;
  return detectBlocker({ url: String(state?.lastUrl ?? '') }).blocked;
}

/** Count selector matches (0 on error / missing selector). */
export async function safeCount(page, selector) {
  if (!selector) return 0;
  try { return await page.locator(selector).count(); } catch { return 0; }
}

/**
 * Phrases that ATSes render after a REAL submission. Deliberately conservative:
 * a miss only downgrades to `submit_unverified` (human verifies), while a false
 * positive would fabricate a submission — so nothing ambiguous belongs here.
 */
export const SUBMIT_CONFIRMATION_RE = new RegExp([
  'thank you for applying',
  'thanks for applying',
  'thank you for your (?:job )?application',
  'application (?:was |has been )?successfully (?:submitted|received|sent)',
  'you(?:\'|’)?ve successfully applied',
  'you have successfully applied',
  'application (?:was |has been |is )?(?:received|submitted|complete|sent)',
  'successfully (?:submitted|applied)',
  'submission (?:was |has been )?(?:received|complete|successful)',
  "we(?:'|’)?ve received your application",
  'your application has been sent',
].join('|'), 'i');

/**
 * Where an ATS sends you AFTER a successful submit, when it shows no "thank
 * you" text. Oracle Recruiting Cloud is the case that went unrecorded
 * (2026-11-12): Submit on /job/<id>/apply/section/N lands on /my-profile,
 * "My Applications", with no confirmation phrase, so the hand-off watcher —
 * which only trusted that phrase — never noticed the human had applied.
 *
 * `from` must have been seen in THIS window before `to`: arriving at "My
 * Applications" from the application form is the evidence, not the page on
 * its own. It is still recorded only as "submitted — please confirm".
 */
export const POST_SUBMIT_PAGES = Object.freeze([
  {
    name: 'Oracle Recruiting "My Applications"',
    from: /\/CandidateExperience\/.*\/job\/[^/?#]+\/apply\/(?!email\b)/i,
    to: /\/CandidateExperience\/[^?#]*\/my-profile\b/i,
  },
  {
    name: 'Greenhouse confirmation',
    from: /greenhouse\.io\/[^?#]*\/jobs\/\d+(?![^?#]*\/confirmation)/i,
    to: /greenhouse\.io\/[^?#]*\/jobs\/\d+\/confirmation\b/i,
  },
  {
    name: 'Lever thank-you page',
    from: /jobs\.lever\.co\/[^/]+\/[^/?#]+\/apply\b/i,
    to: /jobs\.lever\.co\/[^/]+\/[^/?#]+\/thanks\b/i,
  },
]);

/**
 * The post-submit page this window reached from its application form, if any.
 * @param {string[]} trail main-frame URLs seen, oldest first
 * @param {string} current the URL now
 * @returns {string|null} the page's name
 */
export function postSubmitDestination(trail = [], current = '') {
  for (const rule of POST_SUBMIT_PAGES) {
    if (!rule.to.test(current ?? '')) continue;
    if (trail.some((u) => u !== current && rule.from.test(u ?? ''))) return rule.name;
  }
  return null;
}

/** Current page URL, or null when the page object cannot report one. */
export function currentUrlOf(page) {
  try { return typeof page?.url === 'function' ? (page.url() || null) : null; } catch { return null; }
}

/**
 * Text an ERROR page shows. Matched against the page's visible text and title,
 * never the raw HTML — every large site ships these same strings inside its
 * JavaScript bundles as templates for errors that have not happened.
 */
const SUBMIT_FAILURE_RE = new RegExp([
  '\\b[45]\\d{2}\\b[^.]{0,20}\\b(error|forbidden|not found|unavailable|bad gateway|timeout)',
  '\\binternal server error\\b',
  '\\bservice (?:is )?(?:temporarily )?unavailable\\b',
  '\\bbad gateway\\b',
  '\\bgateway time-?out\\b',
  '\\bpage (?:not found|cannot be found|is unavailable)\\b',
  '\\bsomething went wrong\\b',
  '\\ban? (?:unexpected |unknown )?error (?:has )?occurred\\b',
  '\\bwe(?:\'|’)?re having (?:some )?(?:technical )?(?:trouble|difficulties)\\b',
  '\\byour session (?:has )?expired\\b',
  '\\bapplication error\\b',
  '\\brequest (?:has )?failed\\b',
].join('|'), 'i');

/** Re-exported: the page guard and submit verification share one definition. */
export { visibleText };

/**
 * Does this page say the request FAILED?
 *
 * Verification treated "the URL changed and the form is gone" as proof of
 * submission, and both of those are equally true of a redirect to an error
 * page. Reproduced against a mock: a redirect to an HTTP 500 page returned
 * `status: "submitted", submitted: true`, on the evidence "page navigated,
 * form gone" — and because the tracker then counts the job as applied, the
 * duplicate guard discourages the retry that would have actually submitted it.
 *
 * So the absence of a form is no longer read as success on its own. An error
 * page vetoes verification outright, including over a confirmation phrase: a
 * page showing both is ambiguous, and the cost of being wrong here is a human
 * checking their email, against an application the user believes they sent and
 * did not.
 *
 * @param {{status?: number|null, html?: string}} page
 * @returns {string|null} the reason, or null when nothing says failure
 */
export function submissionFailureSignal({ status = null, html = '' } = {}) {
  if (Number.isFinite(status) && status >= 400) return `server responded ${status}`;
  const text = visibleText(html);
  const title = (String(html ?? '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) ?? [])[1] ?? '';
  const hit = SUBMIT_FAILURE_RE.exec(title) ?? SUBMIT_FAILURE_RE.exec(text.slice(0, 4000));
  return hit ? `error page (${hit[0].trim().slice(0, 60)})` : null;
}

/**
 * Verify that a clicked Submit actually submitted.
 *
 * Evidence accepted (guard must not be blocked — a post-submit CAPTCHA is not
 * a confirmation):
 *   - a known confirmation message on the page (or inside the ATS iframe), OR
 *   - the URL changed AND the form fields are gone (classic redirect-to-
 *     thank-you flow with nothing left to fill).
 *
 * @returns {Promise<{ verified: boolean, signals: string[] }>}
 */
export async function verifySubmission({ page, url, beforeUrl, inspectPage, baseline = null, strict = false }) {
  let after;
  try { after = await inspectPage(page, url); } catch { after = null; }
  if (!after) return { verified: false, signals: ['post-submit inspection failed'], lastUrl: currentUrlOf(page) ?? beforeUrl };
  if (after.guard?.blocked) {
    return { verified: false, signals: [`post-submit wall (${after.guard.kind})`], lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl };
  }

  const signals = [];
  let html = after.html ?? '';
  let formGone;
  try {
    // The confirmation (and any leftover form) may live inside an embedded ATS
    // iframe — include its content and its field count.
    const scope = await resolveFormScope(page, { timeoutMs: 500 });
    if (scope && scope !== page && typeof scope.content === 'function') {
      html += await scope.content();
    }
    // A confirmation page with a site search box still has "no form left".
    const fields = applicationFields(await scanFields(scope));
    formGone = Array.isArray(fields) && fields.length === 0;
  } catch { formGone = false; }

  // NEGATIVE EVIDENCE FIRST. A failed submission looks exactly like a
  // successful one to the two weaker signals below — it navigates somewhere new
  // and it has no form on it. See `submissionFailureSignal`.
  const failure = submissionFailureSignal({ status: after.status ?? null, html });
  if (failure) {
    return {
      verified: false,
      signals: [failure],
      lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl,
    };
  }

  // Matched against visible text, not raw HTML: "thank you for applying" ships
  // inside the JavaScript bundle of many ATSes as the template for a page the
  // applicant has not reached yet.
  const phrase = SUBMIT_CONFIRMATION_RE.test(visibleText(html));
  if (phrase && !(strict && baseline?.confirmation)) signals.push('confirmation message');
  const urlChanged = Boolean(after.url && beforeUrl && after.url !== beforeUrl);
  if (urlChanged) signals.push('page navigated');
  if (formGone) signals.push('form gone');
  const destination = strict && after.url ? postSubmitDestination([beforeUrl].filter(Boolean), after.url) : null;
  if (destination) signals.push(`post-submit page: ${destination}`);

  if (!strict) {
    const verified = signals.includes('confirmation message') || (urlChanged && formGone);
    return { verified, signals, lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl };
  }
  // STRICT (the auto-submit click). A phrase alone is not proof: it must be
  // new, and the page must have moved on (form gone or URL changed). Errors the
  // form shows after the click veto everything.
  let formErrors;
  try { formErrors = await detectValidationErrors(await resolveFormScope(page, { timeoutMs: 500 })); } catch { formErrors = []; }
  if (formErrors.length) {
    return { verified: false, signals: [...signals, `form errors after submit: ${formErrors.slice(0, 2).join('; ')}`], lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl };
  }
  const verified = Boolean(destination)
    || (signals.includes('confirmation message') && (formGone || urlChanged))
    || (urlChanged && formGone);
  return { verified, signals, lastUrl: after.url ?? currentUrlOf(page) ?? beforeUrl };
}

/**
 * What the page shows before a click that might submit: whether a
 * confirmation phrase is already visible. `confirmation: false` when the page
 * cannot be read (unit doubles), which keeps the old behaviour there.
 */
export async function submitBaseline(page, scope) {
  let html;
  try { html = typeof page?.content === 'function' ? await page.content() : ''; } catch { html = ''; }
  try {
    if (scope && scope !== page && typeof scope.content === 'function') html += await scope.content();
  } catch { /* the page alone is enough */ }
  return { confirmation: SUBMIT_CONFIRMATION_RE.test(visibleText(html)) };
}

/**
 * A short fingerprint of the step a form is on: URL, headings and the labels
 * of its application fields. Equal before and after an advance click means
 * the click changed nothing. Null when the page cannot be read.
 */
export async function stepFingerprint(page, scope) {
  if (!scope || typeof scope.evaluate !== 'function') return null;
  try {
    const shape = await scope.evaluate(() => {
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const st = window.getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden';
      };
      const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, legend, [role="heading"]'))
        .filter(visible).map(text).filter(Boolean).slice(0, 12).join('|');
      // A start dialog opening over the posting is progress even though the
      // URL, headings and fields behind it did not change.
      const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
        .filter(visible).map((d) => text(d).slice(0, 200)).join('|');
      const controls = Array.from(document.querySelectorAll('button, [role="button"], a[href], input:not([type="hidden"]), select, textarea'))
        .filter(visible).length;
      return `fp:${headings}\n${dialogs}\n${controls}`;
    });
    // Page doubles answer evaluate() with something else: unobservable.
    if (typeof shape !== 'string' || !shape.startsWith('fp:')) return null;
    const fields = applicationFields(await scanFields(scope)).map((f) => `${f.kind}:${f.label}`).join('|');
    return `${currentUrlOf(page) ?? ''}\n${shape}\n${fields}`;
  } catch {
    return null;
  }
}

/** True when an assist error means the HUMAN closed the browser/tab/window. */
export function isBrowserClosedError(err) {
  return /target (page|context|browser).*(closed|crashed)|browser has been closed|page.*has been closed|context.*has been closed|target closed/i
    .test(String(err?.message ?? err ?? ''));
}


/**
 * Wait (bounded) until a page shows application fields, a control that
 * moves forward, or its final Submit. Returns at once when either is already there, and on fakes
 * that cannot evaluate.
 * @param {object} scope Playwright page or frame
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true when something to act on appeared
 */
export async function waitForFormOrWayIn(scope, timeoutMs) {
  if (!scope || typeof scope.evaluate !== 'function' || !(timeoutMs > 0)) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (applicationFields(await scanFields(scope)).length > 0) return true;
    if (await findAdvanceControl(scope, { allowApplyStart: true })) return true;
    // A final page may hold only its Submit (never clicked here) — it is drawn.
    if (await findSubmitControl(scope)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/** The longest a run will wait on a wall, whatever the setting (15 minutes). */
export const MAX_WALL_WAIT_MS = 15 * 60_000;

/**
 * How long this run may wait on a sign-in / CAPTCHA wall (audit A2), in ms.
 * Off (0) by default. `options.waitForWallMs` wins (a test or a one-off); the
 * runtime setting `assistWaitForWallSeconds` applies to a HEADED run only,
 * because nobody can solve a wall in a window that is not there.
 */
export function wallWaitMs({ options = {}, config = {}, headless = false } = {}) {
  const fromOptions = Number(options.waitForWallMs);
  const fromConfig = headless ? 0 : Number(config?.runtime?.assistWaitForWallSeconds) * 1000;
  const ms = Number.isFinite(fromOptions) && options.waitForWallMs != null ? fromOptions : fromConfig;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_WALL_WAIT_MS) : 0;
}

/**
 * Stay on a walled page and look again until the wall is gone (audit A2).
 *
 * This never decides the page is fine: it inspects the page again, and the
 * caller's normal guard check runs on what that inspection returns. A wall
 * that does not clear within `waitMs` comes back still blocked, with how long
 * it waited. A cancel request ends the wait at once.
 *
 * @returns {Promise<{nav: object, waitedMs: number, cancelled: boolean}>}
 */
export async function waitOutWall({ nav, inspectPage, page, url, waitMs, shouldCancel, pollMs = 500 }) {
  const started = Date.now();
  let current = nav;
  if (!(waitMs > 0) || !current?.guard?.blocked) return { nav: current, waitedMs: 0, cancelled: false };
  while (current.guard?.blocked) {
    if (shouldCancel?.()) return { nav: current, waitedMs: Date.now() - started, cancelled: true };
    if (Date.now() - started >= waitMs) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = await inspectPage(page, url);
  }
  return { nav: current, waitedMs: Date.now() - started, cancelled: false };
}

/** The blocker line for a wall, saying how long the run waited when it did. */
export function wallBlockerLine(guard, waitedMs = 0, label = 'page blocked') {
  const waited = waitedMs >= 1000 ? ` — waited ${Math.round(waitedMs / 1000)}s for it to clear` : '';
  return `${label} (${guard.kind}): ${guard.reason}${waited}`;
}
