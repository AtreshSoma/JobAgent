/**
 * Apply runner — browser-assisted application filling (the orchestrator).
 *
 * Given a prepared+approved packet, this opens the application page, runs the
 * safety guards, fills known fields, uploads the resume/cover letter, applies
 * config-backed screening answers, and advances through safe multi-step
 * navigation (Next / Continue / Review). It ALWAYS stops before the final
 * submit — a human reviews the filled form and clicks Submit themselves. This
 * assistant never clicks a final Submit/Apply/Finish/Complete control and has
 * no auto-submit path. Anything risky (CAPTCHA / login / MFA / bot wall /
 * unknown required question) ends the run as `assist_blocked` with the browser
 * left open for the human.
 *
 * All browser interaction is injectable (`deps.createSession`) so the core flow
 * is unit-testable with a fake page and exercisable with real Playwright against
 * local fixture forms.
 */

import { createBrowserSession, openApplicationPage, inspectCurrentPage } from './browser.js';
import { fillFields, requiredFieldsSatisfied } from './fieldResolver.js';
import { scanFields, resolveFormScope } from './domScanner.js';
import { fillScannedFields } from './fieldFiller.js';
import { findAdvanceControl, findSubmitControl, clickAndSettle } from './navigator.js';
import { uploadFiles } from './uploadRunner.js';
import { assertTruthfulSponsorship } from '../apply/screeningQA.js';
import { LIFECYCLE } from '../lifecycle.js';
import { join } from 'node:path';

/**
 * @param {object} args
 * @param {object} args.packet application packet (built by buildApplicationPacket)
 * @param {object} args.config loadConfig bundle
 * @param {string} args.mode resolved run mode
 * @param {object} [args.approval] approval_queue row for this packet's job
 * @param {number} [args.dailyCount=0] applications submitted today
 * @param {object} [args.options]
 * @param {boolean} [args.options.headless]
 * @param {boolean} [args.options.dryRun=false] fill/upload resolve-only (no typing/attaching)
 * @param {object} [args.deps]
 * @param {Function} [args.deps.createSession] -> { page, close }
 * @param {Function} [args.deps.openPage] override openApplicationPage
 * @returns {Promise<object>} assist result (see fields assembled below)
 */
export async function assistApply({
  packet, config, mode, approval = {}, dailyCount = 0, options = {}, deps = {},
} = {}) {
  const url = packet?.job?.url;
  const result = {
    jobId: packet?.job?.id ?? null,
    url: url ?? null,
    status: LIFECYCLE.ASSIST_STARTED,
    guard: { blocked: false },
    filled: [],
    unresolved: [],
    uploads: { uploaded: [], blockers: [], skipped: [] },
    blockers: [...(packet?.blockers ?? [])],
    submitSelector: null,
    submitSelectorConfident: false,
    sponsorshipTruthful: true,
    requiredFieldsFilled: false,
    submitted: false,
    sessionLeftOpen: false,
  };

  if (!url) {
    result.status = LIFECYCLE.FAILED;
    result.blockers.push('packet has no application URL');
    return result;
  }

  // Sponsorship truthfulness is checked from the packet (no browser needed).
  const truthCheck = assertTruthfulSponsorship(packet?.screeningPlan?.answered ?? []);
  result.sponsorshipTruthful = truthCheck.truthful;
  if (!truthCheck.truthful) {
    result.blockers.push(`sponsorship answer not truthful: ${truthCheck.violations.join('; ')}`);
  }

  const createSession = deps.createSession ?? createBrowserSession;
  const openPage = deps.openPage ?? openApplicationPage;
  const headless = options.headless ?? config?.runtime?.headless ?? false;
  const channel = options.channel ?? config?.runtime?.browserChannel ?? null;
  // Slow each action down so the human can watch the bot type/click/upload.
  const slowMo = options.slowMo ?? config?.runtime?.browserSlowMo ?? 0;
  // Persist the browser profile across runs so you sign in ONCE (Indeed, ATS
  // SSO, etc.) and the saved cookies are reused next time — no repeated logins.
  // An explicit BROWSER_USER_DATA_DIR wins; otherwise default to a dedicated,
  // project-local profile folder. The folder is channel-specific so a real
  // Edge/Chrome profile never clashes with bundled Chromium's profile version,
  // AND it is SEPARATE from your everyday browser's profile so launching it
  // never conflicts with an already-running browser (which would otherwise
  // forward the command to the live instance and leave a dead about:blank tab).
  // Pass userDataDir:false to force isolation.
  let userDataDir = options.userDataDir ?? config?.runtime?.browserUserDataDir ?? null;
  if (userDataDir === null && config?.root) {
    const dirName = channel ? `.browser-profile-${channel}` : '.browser-profile';
    userDataDir = join(config.root, dirName);
  }
  if (userDataDir === false) userDataDir = null;

  let session;
  try {
    session = await createSession({ headless, slowMo, channel, userDataDir, deps });
  } catch (err) {
    result.status = LIFECYCLE.FAILED;
    // The most common cause when reusing a real browser profile is that the
    // browser is still running and holding a lock on the profile directory.
    const hint = channel
      ? ` — if you set BROWSER_USER_DATA_DIR, close every ${channel === 'msedge' ? 'Microsoft Edge' : channel} window first (a profile can only be opened by one process at a time)`
      : '';
    result.blockers.push(`could not start browser: ${err.message}${hint}`);
    return result;
  }

  try {
    const { page } = session;
    const dryRun = options.dryRun === true;
    // LIVE_ASSIST walks multi-step forms, clicking only safe forward controls
    // (Next/Continue/Review) — never a final Submit. Cap the number of pages.
    const maxSteps = Math.max(1, Number(options.maxSteps ?? config?.runtime?.assistMaxSteps ?? 8));
    const candidate = config?.candidate ?? {};
    const screeningAnswers = config?.screeningAnswers ?? {};
    const inspectPage = deps.inspectPage ?? inspectCurrentPage;

    // Blockers that persist across every step (packet-level + sponsorship).
    const baseBlockers = [...result.blockers];
    // Cumulative state across multi-step pages.
    const filledByKey = new Set();
    const uploadedTypes = new Set();
    let dynamicNeedsUser = [];
    let staticUnresolved = [];
    let step0UploadBlockers = [];

    // 1. Open + guard. Never proceed past a protected page.
    let nav = await openPage(page, url);
    result.guard = nav.guard;
    if (nav.guard?.blocked) {
      result.status = LIFECYCLE.ASSIST_BLOCKED;
      result.blockers = [...baseBlockers, `page blocked (${nav.guard.kind}): ${nav.guard.reason}`];
      result.sessionLeftOpen = !headless;
      return result;
    }

    result.steps = 0;
    for (let step = 0; step < maxSteps; step++) {
      result.steps = step + 1;

      // Re-inspect + re-guard on every step after the first (we navigated via a
      // "Next"/"Continue" click, so the DOM/URL may have changed entirely).
      if (step > 0) {
        nav = await inspectPage(page, url);
        result.guard = nav.guard;
        if (nav.guard?.blocked) {
          result.status = LIFECYCLE.ASSIST_BLOCKED;
          result.blockers = [...baseBlockers, `page blocked (${nav.guard.kind}): ${nav.guard.reason}`];
          result.sessionLeftOpen = !headless;
          return result;
        }
      }

      const stepBlockers = [];

      // The form may be EMBEDDED in an ATS iframe (e.g. dropbox.com / samsara.com
      // hosting a Greenhouse form). Resolve the frame that actually holds the
      // fields and run every fill/scan/upload/navigate against it; falls back to
      // the page when the form is top-level (or for unit-test fakes).
      const scope = await resolveFormScope(page);

      // 2a. Static plan fill (first page only — its selectors are page-1 specific).
      if (step === 0) {
        const fill = await fillFields(scope, packet.fillPlan, { dryRun });
        for (const f of fill.filled) {
          if (f.selector) filledByKey.add(f.selector);
          result.filled.push(f);
        }
        staticUnresolved = fill.unresolved ?? [];
        for (const err of fill.errors ?? []) stepBlockers.push(`field ${err.field}: ${err.error}`);
      }

      // 2b. Dynamic, type-aware fill of whatever is actually on the page now.
      const scanned = await scanFields(scope);
      const dyn = await fillScannedFields(scope, scanned, { candidate, screeningAnswers, alreadyFilled: filledByKey });
      for (const f of dyn.filled) result.filled.push(f);
      if (dyn.needsUser?.length) dynamicNeedsUser = dyn.needsUser;
      for (const err of dyn.errors ?? []) stepBlockers.push(`field ${err.label ?? err.field}: ${err.error}`);
      result.unresolved = staticUnresolved;

      // A dynamic form field we cannot answer blocks the run ONLY when the live
      // form marks it required. Optional unknowns (middle name, address line 2,
      // "decline to answer" EEO selects, …) are recorded and left blank so we
      // can still advance through the step.
      const requiredDynamicNeedsUser = dynamicNeedsUser.filter((nu) => nu.required === true);
      const optionalDynamicNeedsUser = dynamicNeedsUser.filter((nu) => nu.required !== true);
      result.optionalSkipped = optionalDynamicNeedsUser.map((nu) => nu.label ?? String(nu));

      // 3. Unknown screening questions (from the packet) + REQUIRED unknown form
      //    fields pause the run — we never fabricate answers.
      for (const nu of packet?.screeningPlan?.needsUser ?? []) stepBlockers.push(`screening needs user: ${nu.label}`);
      for (const nu of requiredDynamicNeedsUser) stepBlockers.push(`required field needs user: ${nu.label ?? nu}`);

      // 4. Upload resume (+ cover letter). Only treat "not found" as a blocker on
      //    the first page; later steps simply attach if the input appears.
      const up = await uploadFiles(scope, packet.fillPlan, { dryRun });
      for (const u of up.uploaded ?? []) { result.uploads.uploaded.push(u); if (u.type) uploadedTypes.add(u.type); }
      for (const s of up.skipped ?? []) result.uploads.skipped.push(s);
      if (step === 0) { step0UploadBlockers = up.blockers ?? []; result.uploads.blockers = up.blockers ?? []; }
      stepBlockers.push(...step0UploadBlockers.filter((b) => !uploadedTypes.has('resume') || !/resume/i.test(b)));

      // 5. Required fields satisfied?
      const req = requiredFieldsSatisfied(result.filled, packet.fillPlan);
      result.requiredFieldsFilled = req.ok;
      if (!req.ok) stepBlockers.push(`required fields missing: ${req.missing.join(', ')}`);

      // 6. Identify the FINAL submit control (for awareness only — we never click
      //    it). Prefer the packet's; otherwise discover one on the current page.
      let submitSelector = packet?.fillPlan?.submitSelector ?? null;
      let submitCount = submitSelector ? await safeCount(scope, submitSelector) : 0;
      if (submitCount !== 1) {
        const discovered = await findSubmitControl(scope);
        if (discovered?.selector && (await safeCount(scope, discovered.selector)) === 1) {
          submitSelector = discovered.selector;
          submitCount = 1;
        }
      }
      result.submitSelector = submitSelector;
      result.submitSelectorConfident = Boolean(submitSelector) && submitCount === 1;

      result.blockers = [...baseBlockers, ...stepBlockers];

      // Hard stops (advancing cannot fix these): a page wall, an untruthful
      // sponsorship answer, or an unknown question that needs a human.
      const hardStop = result.guard?.blocked
        || result.sponsorshipTruthful === false
        || (packet?.screeningPlan?.needsUser?.length ?? 0) > 0
        || requiredDynamicNeedsUser.length > 0;
      if (hardStop) {
        result.status = LIFECYCLE.ASSIST_BLOCKED;
        result.sessionLeftOpen = !headless;
        return result;
      }

      // Outstanding blockers we can't auto-resolve (e.g. a missing required field
      // or a resume that wouldn't upload) stop the run for the human.
      if (result.blockers.length > 0) {
        result.status = LIFECYCLE.ASSIST_BLOCKED;
        result.sessionLeftOpen = !headless;
        return result;
      }

      // Look for a safe forward control. If none exists, this is the final page:
      // everything is filled and ready — the human reviews and clicks Submit.
      const advance = await findAdvanceControl(scope);
      if (!advance || step === maxSteps - 1) {
        result.status = LIFECYCLE.READY_FOR_SUBMIT;
        result.sessionLeftOpen = !headless;
        return result;
      }

      const clicked = await clickAndSettle(scope, advance, deps);
      if (!clicked) {
        result.status = LIFECYCLE.READY_FOR_SUBMIT;
        result.sessionLeftOpen = !headless;
        return result;
      }
      result.advancedSteps = (result.advancedSteps ?? 0) + 1;
      // loop continues to the next step
    }

    // Exhausted the step budget — leave it filled and ready for the human.
    result.status = result.blockers.length > 0 ? LIFECYCLE.ASSIST_BLOCKED : LIFECYCLE.READY_FOR_SUBMIT;
    result.sessionLeftOpen = !headless;
    return result;
  } catch (err) {
    result.status = LIFECYCLE.FAILED;
    result.blockers.push(`assist error: ${err.message}`);
    return result;
  } finally {
    // Close only when we are NOT intentionally leaving the browser open for the
    // human (headed + stopped before submit). In headless/CI, always close.
    if (!result.sessionLeftOpen) {
      await session.close?.();
    }
  }
}

/** Count selector matches (0 on error / missing selector). */
async function safeCount(page, selector) {
  if (!selector) return 0;
  try { return await page.locator(selector).count(); } catch { return 0; }
}
