/**
 * Apply runner — browser-assisted application filling (the orchestrator).
 *
 * Given a prepared+approved packet, this opens the application page, runs the
 * safety guards, fills known fields, uploads the resume/cover letter, applies
 * config-backed screening answers, and advances through safe multi-step
 * navigation (Next / Continue / Review). By DEFAULT it stops before the final
 * submit — a human reviews the filled form and clicks Submit themselves.
 *
 * Final submission is opt-in PER RUN: when the human explicitly enables
 * options.autoSubmit, the runner clicks the final Submit — but only on a
 * completely clean form (zero blockers, all required fields filled, truthful
 * sponsorship answers, a unique confidently-identified submit control) and
 * only under the configured daily application cap. Anything risky (CAPTCHA /
 * login / MFA / bot wall / unknown required question) still ends the run as
 * `assist_blocked` with the browser left open for the human — auto-submit
 * never overrides a guard or fabricates an answer.
 *
 * Truthfulness rule for "submitted": clicking Submit is NOT proof the
 * application went through (client-side validation, a post-submit CAPTCHA, or
 * a no-op button all swallow the click). After the click the runner re-inspects
 * the page and only reports `submitted: true` when it can VERIFY the submission
 * (a confirmation message, or the URL changed and the form is gone). An
 * unverified click ends as `submit_unverified` — surfaced to the human to
 * confirm via the ATS email — and is never recorded as applied.
 *
 * All browser interaction is injectable (`deps.createSession`) so the core flow
 * is unit-testable with a fake page and exercisable with real Playwright against
 * local fixture forms.
 */

import { readApprovedAnswers, withApprovedAnswers } from '../apply/approvedAnswers.js';
import { createBrowserSession, openApplicationPage, inspectCurrentPage } from './browser.js';
import { unfilledRequiredControls } from './domScanner.js';
import { clickAndSettle } from './navigator.js';
import { APPLICATION_PHASE, transitionApplicationState } from '../apply/applicationState.js';
import { LIFECYCLE } from '../lifecycle.js';
import { join } from 'node:path';
import {
  browserProfileDirName, currentUrlOf, submitBaseline, unreviewedSensitiveAnswers, verifySubmission,
} from './assistSupport.js';
import { runAssist } from './assistStages.js';

// The helpers moved to assistSupport.js (audit A14); this file keeps the public names.
export {
  watchForHumanSubmission, browserProfileDirName, unreviewedSensitiveAnswers, SUBMIT_CONFIRMATION_RE,
  POST_SUBMIT_PAGES, postSubmitDestination, visibleText, submissionFailureSignal, isBrowserClosedError,
} from './assistSupport.js';

/**
 * @param {object} args
 * @param {object} args.packet application packet (built by buildApplicationPacket)
 * @param {object} args.config loadConfig bundle
 * @param {string} args.mode resolved run mode
 * @param {object} [args.approval] approval_queue row for this packet's job
 * @param {number} [args.dailyCount=0] applications submitted today
 * @param {object} [args.options]
 * @param {boolean} [args.options.headless]
 * @param {boolean} [args.options.dryRun=false] read the form and report what WOULD be done: nothing is
 *   typed, chosen, attached or clicked, no application state is saved, and the run stops on the first
 *   page with `status: 'dry_run'` and `wouldClick` (audit N2)
 * @param {object} [args.deps]
 * @param {Function} [args.deps.createSession] -> { page, close }
 * @param {Function} [args.deps.openPage] override openApplicationPage
 * @returns {Promise<object>} assist result (see fields assembled below)
 */
export async function assistApply({
  // `mode` and `approval` stay in the documented call shape (callers pass
  // them), but nothing in this function reads them.
  packet, config, mode: _mode, approval: _approval, dailyCount = 0, options = {}, deps = {},
} = {}) {
  const url = packet?.job?.url;
  const result = {
    jobId: packet?.job?.id ?? null,
    url: url ?? null,
    status: LIFECYCLE.ASSIST_STARTED,
    guard: { blocked: false },
    filled: [],
    unresolved: [],
    // Every question this run could not answer, deduplicated across steps and
    // carrying the live form's own metadata (required? what choices?). The
    // dashboard feeds these into the screening-answer queue so answering one by
    // hand covers every future application that asks the same thing.
    needsUser: [],
    uploads: { uploaded: [], blockers: [], skipped: [] },
    blockers: [...(packet?.blockers ?? [])],
    submitSelector: null,
    submitSelectorConfident: false,
    sponsorshipTruthful: true,
    requiredFieldsFilled: false,
    submitted: false,
    sessionLeftOpen: false,
    // Resumable-workflow trail: every phase transition with a timestamp, so the
    // human (and the audit log) can see exactly where a run got to —
    // Queued -> Precheck -> Opening -> Filling -> Validating -> Advancing ->
    // Blocked / ReadyForReview / Submitted / SubmitUnverified.
    phases: [],
    resumed: false,
    duplicatePrevented: false,
    applicationState: null,
    applicationStatePath: null,
    // Every screening answer actually committed on the live form, with the
    // option text the employer will read — the packet only records what we
    // PLANNED to say. Auto-submit compares the two (see tryAutoSubmit).
    liveAnswers: [],
  };
  const clock = deps.now ?? (() => new Date());
  const nowIso = () => {
    const value = typeof clock === 'function' ? clock() : clock;
    return (value instanceof Date ? value : new Date(value)).toISOString();
  };
  const phaseEvent = (name, detail = null) => {
    result.phases.push({ phase: name, at: nowIso(), ...(detail ? { detail } : {}) });
  };

  // A DRY RUN HAS NO SIDE EFFECTS (audit N2). It used to gate only the static
  // plan and uploads: the dynamic fill, the conditional fill and every
  // Next/Continue click ignored it, so a "dry run" typed into and advanced a
  // live application. Now: no typing, choosing, attaching or clicking, no
  // saved application state, and it stops on the first page.
  const dryRun = options.dryRun === true;
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
  //
  // PER SEARCH PROFILE. One shared `.browser-profile` meant the second
  // candidate inherited the first one's ATS sessions, autofill and saved
  // logins — a Workday account signed in as somebody else. With an active
  // profile id the folder is `.browser-profile-<profileId>[-<channel>]`.
  // MIGRATION: installs with no profile id keep the historical
  // `.browser-profile[-<channel>]` folder, so nobody is signed out by this
  // change; after creating a profile, sign in once more in its own browser
  // (or copy the old folder to the new name to carry the cookies over).
  let userDataDir = options.userDataDir ?? config?.runtime?.browserUserDataDir ?? null;
  if (userDataDir === null && config?.root) {
    userDataDir = join(config.root, browserProfileDirName({ channel, profileId: config?.profile?.id }));
  }
  if (userDataDir === false) userDataDir = null;
  // LIVE_ASSIST walks multi-step forms, clicking only safe forward controls
  // (Next/Continue/Review) — never a final Submit. Cap the number of pages.
  const maxSteps = Math.max(1, Number(options.maxSteps ?? config?.runtime?.assistMaxSteps ?? 8));
  const candidate = config?.candidate ?? {};
  // Answers the person approved for THIS job (audit A4) join the saved screening
  // answers for this run only. packet.approvedAnswers overrides the store (tests).
  const screeningAnswers = withApprovedAnswers(
    config?.screeningAnswers ?? {},
    packet?.approvedAnswers ?? readApprovedAnswers(config?.root, packet?.job?.id),
  );
  const inspectPage = deps.inspectPage ?? inspectCurrentPage;

  // The run: everything the states in assistStages.js read and change. State a
  // later state needs lives here; page-local values live in `r.step`.
  const r = {
    result, packet, config, options, deps, url, clock, nowIso, phaseEvent, dryRun, headless, channel, slowMo,
    userDataDir, createSession, openPage, maxSteps, candidate, screeningAnswers, inspectPage,
    applicationState: null, stateStore: null, session: null, page: null, nav: null,
    dynamicNeedsUser: [], staticUnresolved: [], step: {}, runStep: 0, nextStep: 1,
  };

  const checkpoint = async (name, patch = {}, detail = null) => {
    phaseEvent(name, detail);
    r.applicationState = transitionApplicationState(r.applicationState, name, patch, { now: clock, detail });
    try {
      if (r.stateStore) await r.stateStore.save?.(r.applicationState);
    } catch (err) {
      const wrapped = new Error(`application state checkpoint failed: ${err.message}`);
      wrapped.applicationStatePersistence = true;
      throw wrapped;
    }
    result.applicationState = r.applicationState;
    result.currentStep = r.applicationState.currentStep;
    return r.applicationState;
  };
  r.checkpoint = checkpoint;

  const autoSubmit = options.autoSubmit === true;
  const dailyCap = Math.max(1, Number(config?.runtime?.maxApplicationsPerDay ?? 15) || 15);
  const tryAutoSubmit = async (scope) => {
    if (!autoSubmit) return false;
    if (dryRun) return false; // a dry run never submits (N2)
    const { page } = r;
    if (result.blockers.length > 0) return false;
    if (!result.sponsorshipTruthful || !result.requiredFieldsFilled) return false;
    if (!result.submitSelector || !result.submitSelectorConfident) return false;
    // A legal / immigration / demographic answer chosen LIVE that the human
    // never reviewed in the packet is not covered by their approval: they
    // approved "Yes, I require sponsorship", not whichever option a live
    // widget ended up showing, and not an answer to a question the packet
    // did not know about.
    const unreviewed = unreviewedSensitiveAnswers(result.liveAnswers, packet?.screeningPlan?.answered ?? []);
    if (unreviewed.length) {
      result.autoSubmitWithheld = unreviewed.map((a) => `live answer to "${a.label}" ("${a.value}") was not in the reviewed packet`);
      result.note = `auto-submit withheld — ${result.autoSubmitWithheld[0]}; review it and submit yourself`;
      return false;
    }
    // Ask the live DOM, not the static plan, whether anything required is
    // still blank. `null` means the scope cannot be inspected (a unit-test
    // double); a real Playwright page always can.
    const blankRequired = await unfilledRequiredControls(scope);
    if (Array.isArray(blankRequired) && blankRequired.length) {
      result.requiredFieldsFilled = false;
      result.autoSubmitWithheld = blankRequired.map((l) => `required field is empty: ${l}`);
      result.note = `auto-submit withheld — ${blankRequired.length} required field(s) still empty (${blankRequired.slice(0, 3).join(', ')})`;
      return false;
    }
    if ((dailyCount ?? 0) >= dailyCap) {
      result.note = `daily application cap reached (${dailyCap}) — filled but left for you to submit`;
      return false;
    }
    const beforeUrl = currentUrlOf(page) ?? url;
    // What the page said BEFORE the click. A confirmation phrase that was
    // already on screen ("Once your application is submitted, you cannot
    // edit it") is not evidence that this click submitted anything.
    const baseline = await submitBaseline(page, scope);
    // Write-ahead duplicate guard: if the process dies after the click but
    // before confirmation inspection, a future run must not click Submit a
    // second time. `submitting` means the attempt is write-ahead protected;
    // it is intentionally not `verified` yet.
    await checkpoint(APPLICATION_PHASE.SUBMITTING, {
      currentStep: result.currentStep,
      lastUrl: beforeUrl,
      blockers: [],
      submissionEvidence: ['explicit per-run auto-submit authorization', 'submit attempt initiated'],
    }, 'final submit attempt initiated; verification required');
    // selectorOnly: click ONLY the selector we just verified resolves to
    // exactly one control. No accessible-name fallback on the submit path.
    const clicked = await clickAndSettle(
      scope, { selector: result.submitSelector, text: 'Submit' }, deps, { selectorOnly: true },
    );
    if (!clicked) {
      await checkpoint(APPLICATION_PHASE.VERIFYING, {
        currentStep: result.currentStep,
        lastUrl: currentUrlOf(page) ?? beforeUrl,
        blockers: ['submit control could not be confirmed after the attempt'],
        submissionEvidence: ['explicit per-run auto-submit authorization', 'submit attempt initiated'],
      }, 'submit attempt could not be confirmed; manual verification required');
      result.submitted = false;
      result.status = LIFECYCLE.SUBMIT_UNVERIFIED;
      result.note = 'The final submit attempt could not be confirmed. Automatic retry is disabled to prevent a duplicate; review the ATS and confirmation email manually.';
      return true;
    }
    // A click is not a submission. Verify before reporting `submitted` —
    // an unverified click is surfaced to the human, never recorded as applied.
    await checkpoint(APPLICATION_PHASE.VERIFYING, {
      currentStep: result.currentStep,
      lastUrl: currentUrlOf(page) ?? beforeUrl,
      blockers: [],
      submissionEvidence: ['explicit per-run auto-submit authorization', 'submit control clicked'],
    }, 'submit control clicked; checking confirmation evidence');
    const verification = await verifySubmission({ page, url, beforeUrl, inspectPage, baseline, strict: true });
    result.submitVerification = verification;
    if (verification.verified) {
      result.submitted = true;
      result.status = LIFECYCLE.SUBMITTED;
      result.note = `auto-submitted — submission confirmed (${verification.signals.join(', ')})`;
      await checkpoint(APPLICATION_PHASE.VERIFIED, {
        currentStep: result.currentStep,
        lastUrl: verification.lastUrl ?? currentUrlOf(page) ?? beforeUrl,
        blockers: [],
        verificationEvidence: verification.signals,
      }, 'submission confirmation detected');
    } else {
      result.submitted = false;
      result.status = LIFECYCLE.SUBMIT_UNVERIFIED;
      result.note = 'Submit was clicked but no confirmation page could be detected — check the open '
        + 'browser tab and your email for an ATS confirmation. If it went through, use "Mark submitted"; '
        + 'otherwise finish the application manually. NOT recorded as submitted.';
    }
    return true;
  };
  r.tryAutoSubmit = tryAutoSubmit;

  return runAssist(r);
}
