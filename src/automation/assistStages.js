/**
 * The assist run as a state machine (audit A14).
 *
 * `assistApply` was one 1,000-line function: state load, duplicate guard,
 * ownership check, browser launch, then a loop that opened, filled, uploaded,
 * validated and advanced pages, each exit written out by hand. Here each of
 * those is a named STATE: a function of the run (`r`) that returns the name of
 * the next state or DONE. The order is data (TRANSITIONS), the driver walks it,
 * and `deps.onState` reports every state entered, so a test (or a person
 * reading a log) can see exactly the path a run took.
 *
 *   begin -> launch -> openApplication -> stepStart -> fill -> upload
 *     -> validate -> decide -> advance -> stepStart ... | exhausted
 *
 * Any state may also end the run (DONE) with the result already written.
 *
 * THE SUBMIT GATE IS NOT HERE. This module cannot submit: the only path is
 * `r.tryAutoSubmit`, injected by applyRunner.js, where the per-run opt-in and
 * every other gate live (and where `npm run verify` checks them). A dry run
 * (audit N2) also stops in `decide`, before any click.
 */
import {
  BROWSER_UNAVAILABLE_CODE, BROWSER_UNAVAILABLE_MESSAGE, isBrowserMissingError, stripPlaywrightBanner,
  inspectCurrentPage,
} from './browser.js';
import { fillFields, requiredFieldsSatisfied, verifyFilledFields } from './fieldResolver.js';
import { fillRepeatedSections } from './repeatedSections.js';
import {
  scanFields, resolveFormScope, detectValidationErrors, unfilledRequiredControls, applicationFields,
  shadowFormControlCount,
} from './domScanner.js';
import { fillScannedFields } from './fieldFiller.js';
import { findAdvanceControl, findSubmitControl, clickAndSettle, APPLY_START_RE } from './navigator.js';
import { uploadFiles } from './uploadRunner.js';
import { assertTruthfulSponsorship, isInvertedSponsorshipQuestion } from '../apply/screeningQA.js';
import {
  APPLICATION_PHASE,
  applicationStatePreventsReopen,
  assertApplicationStateMatchesPacket,
  createApplicationState,
  resolveApplicationStateStore,
  transitionApplicationState,
} from '../apply/applicationState.js';
import { packetOwnershipCheck } from '../apply/applicationPacket.js';
import { LIFECYCLE } from '../lifecycle.js';
import {
  SUBMIT_CONFIRMATION_RE, currentUrlOf, isBrowserClosedError, safeCount, shouldWatchForHumanSubmit,
  stepFingerprint, submitBaseline, unsafeResumeUrl, visibleText, waitForFormOrWayIn, wallBlockerLine, wallWaitMs,
  waitOutWall, watchForHumanSubmission,
} from './assistSupport.js';

/**
 * Most re-scans of one page after the first fill (audit A7): each pass fills
 * what the previous answers revealed. Five levels of questions deep is more
 * than any real form asks; the cap is what stops one that never ends.
 */
export const MAX_RESCANS = 4;

/** Returned by a state when the run is over and `r.result` is final. */
export const DONE = 'done';

/** Every state, and the states each may hand over to (besides DONE). */
export const TRANSITIONS = Object.freeze({
  begin: ['launch'],
  launch: ['openApplication'],
  openApplication: ['stepStart'],
  stepStart: ['fill'],
  fill: ['upload'],
  upload: ['validate'],
  validate: ['decide'],
  decide: ['advance'],
  advance: ['stepStart', 'exhausted'],
  exhausted: [],
});

/**
 * A run stopped by the person at a safe checkpoint (shared by every place the
 * run notices a cancel request).
 */
async function cancelRun(r, stepNumber = r.applicationState.currentStep) {
  const { result, checkpoint, page, url } = r;
  result.status = LIFECYCLE.CANCELLED;
  result.note = 'Application run cancelled at a safe checkpoint. Resume to continue from the saved URL.';
  await checkpoint(APPLICATION_PHASE.CANCELLED, {
    currentStep: stepNumber,
    lastUrl: currentUrlOf(page) ?? r.applicationState.lastUrl ?? url,
    blockers: [],
  }, 'user requested cancellation');
  return DONE;
}

/**
 * On a wall, wait for the person to clear it when the run was told it may
 * (audit A2), then hand back the page's CURRENT state: the caller's normal
 * guard check decides what happens next, so waiting can never skip a guard.
 * @returns {Promise<{nav: object, waitedMs: number, cancelled: boolean}>}
 */
async function settleWall(r, nav, resumeUrl) {
  const waitMs = wallWaitMs({ options: r.options, config: r.config, headless: r.headless });
  if (!nav?.guard?.blocked || !waitMs) return { nav, waitedMs: 0, cancelled: false };
  await r.checkpoint(APPLICATION_PHASE.BLOCKED, {
    currentStep: r.applicationState.currentStep,
    lastUrl: nav.url ?? resumeUrl,
    blockers: [wallBlockerLine(nav.guard)],
    lastUrlUnsafe: true,
  }, `waiting up to ${Math.round(waitMs / 1000)}s for you to clear the ${nav.guard.kind} page`);
  return waitOutWall({
    nav, inspectPage: r.inspectPage, page: r.page, url: resumeUrl, waitMs, shouldCancel: r.deps.shouldCancel,
  });
}

/** Setup states: open resources, check the packet. */
async function begin(r) {
  const { result, packet, config, options, deps, url, dryRun, checkpoint, phaseEvent, clock } = r;
  try {
    r.stateStore = dryRun ? null : resolveApplicationStateStore({
      packet,
      root: config?.root,
      statePath: options.statePath,
      store: deps.stateStore,
      // Checkpoints are per search profile: see applicationStatePath.
      profileId: config?.profile?.id ?? null,
    });
    result.applicationStatePath = r.stateStore?.path ?? (typeof options.statePath === 'string' ? options.statePath : null);
    const loaded = r.stateStore ? await r.stateStore.load?.() : null;
    if (loaded) {
      try {
        assertApplicationStateMatchesPacket(loaded, packet);
        r.applicationState = loaded;
        result.resumed = true;
      } catch (err) {
        // A user may replace a stale/aggregator URL with the direct employer
        // application URL. That is still the SAME tracked job, but the old
        // page/step checkpoint is unsafe to resume. Start a fresh checkpoint
        // for the new URL; keep failing closed for a different job id.
        if (!/state URL does not match/i.test(err.message)) throw err;
        r.applicationState = createApplicationState(packet, { now: clock });
        result.checkpointReset = true;
        phaseEvent(APPLICATION_PHASE.QUEUED, 'application URL changed; starting from the new link');
        if (r.stateStore) await r.stateStore.save?.(r.applicationState);
      }
    } else {
      r.applicationState = createApplicationState(packet, { now: clock });
      phaseEvent(APPLICATION_PHASE.QUEUED);
      if (r.stateStore) await r.stateStore.save?.(r.applicationState);
    }
    result.applicationState = r.applicationState;
  } catch (err) {
    result.status = LIFECYCLE.FAILED;
    result.blockers.push(`application state could not be loaded: ${err.message}`);
    return DONE;
  }

  // A reported submission is a write-once duplicate guard. Until verification
  // exists, the safe action is human review — never re-open and possibly apply
  // a second time.
  if (applicationStatePreventsReopen(r.applicationState)) {
    result.duplicatePrevented = true;
    result.status = r.applicationState.phase === APPLICATION_PHASE.VERIFIED
      ? LIFECYCLE.SUBMITTED
      : LIFECYCLE.SUBMIT_UNVERIFIED;
    result.note = r.applicationState.phase === APPLICATION_PHASE.VERIFIED
      ? 'Application is already verified; browser assist was not reopened.'
      : 'Application was already reported submitted and awaits verification; browser assist was not reopened to prevent a duplicate.';
    return DONE;
  }

  if (!url) {
    result.status = LIFECYCLE.FAILED;
    result.blockers.push('packet has no application URL');
    try {
      await checkpoint(APPLICATION_PHASE.BLOCKED, { blockers: result.blockers }, 'packet has no application URL');
    } catch { /* the primary error is already actionable */ }
    return DONE;
  }

  // WHOSE APPLICATION IS THIS? The dashboard and CLI each asked before reusing
  // a stored packet, but every one of those checks lived in a caller, and a
  // caller that forgot (or a new one) filled a packet built for somebody else.
  // The runner is the one path every fill goes through, so the check lives
  // here too — before a browser opens, before anything is typed.
  const owned = (deps.ownershipCheck ?? packetOwnershipCheck)(packet, config ?? {});
  if (!owned.ok) {
    result.status = LIFECYCLE.ASSIST_BLOCKED;
    result.blockers.push(
      `packet_not_owned: this packet is not the active candidate's — ${owned.reason}. `
      + 'Prepare it again so the documents and answers describe whoever is applying.',
    );
    try {
      await checkpoint(APPLICATION_PHASE.BLOCKED, { blockers: result.blockers }, 'packet belongs to another candidate');
    } catch { /* the ownership refusal is the actionable error */ }
    return DONE;
  }

  // Sponsorship truthfulness is checked from the packet (no browser needed).
  try {
    await checkpoint(APPLICATION_PHASE.PRECHECK, {
      blockers: result.blockers,
      unresolvedQuestions: packet?.screeningPlan?.needsUser ?? [],
      resumeCount: r.applicationState.resumeCount + (result.resumed ? 1 : 0),
    });
  } catch (err) {
    result.status = LIFECYCLE.FAILED;
    result.blockers.push(err.message);
    return DONE;
  }
  // Packet-level truthfulness. Plan entries carry their question `label`, so
  // this also catches an affirmative answer to an INVERTED sponsorship question
  // (a bare "Yes" whose text looks innocent but whose meaning is false).
  // Judged against the candidate's OWN requirement: the same sentence is a lie
  // for one person and the truth for another, and the packet is built from a
  // profile that states which.
  const truthCheck = assertTruthfulSponsorship(packet?.screeningPlan?.answered ?? [], {
    requiresSponsorship: config?.candidate?.workAuthorization?.requiresSponsorship
      ?? config?.candidate?.sponsorshipRequired,
  });
  result.sponsorshipTruthful = truthCheck.truthful;
  if (!truthCheck.truthful) {
    result.blockers.push(`sponsorship answer not truthful: ${truthCheck.violations.join('; ')}`);
  }

  return 'launch';
}

async function launch(r) {
  const { result, deps, url, headless, channel, slowMo, userDataDir, checkpoint, createSession } = r;
  try {
    r.session = await createSession({ headless, slowMo, channel, userDataDir, deps });
  } catch (err) {
    // A missing browser binary is an ENVIRONMENT problem, not a failed
    // application: nothing about the job or packet is wrong, and "failed"
    // sent users to the RCA panel to read Playwright's 10-line ASCII banner.
    // It is recorded as blocked with a stable `browser_unavailable:` code the
    // dashboard classifies, and one line that says what to run.
    if (isBrowserMissingError(err)) {
      result.status = LIFECYCLE.ASSIST_BLOCKED;
      result.statusReason = `${BROWSER_UNAVAILABLE_CODE}: ${BROWSER_UNAVAILABLE_MESSAGE}`;
      result.blockers.push(result.statusReason);
      try {
        await checkpoint(APPLICATION_PHASE.BLOCKED, {
          currentStep: r.applicationState.currentStep,
          lastUrl: r.applicationState.lastUrl ?? url,
          blockers: result.blockers,
        }, 'browser not installed');
      } catch { /* the missing browser is the actionable error */ }
      return DONE;
    }
    result.status = LIFECYCLE.FAILED;
    // The most common cause when reusing a real browser profile is that the
    // browser is still running and holding a lock on the profile directory.
    const hint = channel
      ? ` — if you set BROWSER_USER_DATA_DIR, close every ${channel === 'msedge' ? 'Microsoft Edge' : channel} window first (a profile can only be opened by one process at a time)`
      : '';
    result.blockers.push(`could not start browser: ${stripPlaywrightBanner(err.message)}${hint}`);
    try {
      await checkpoint(APPLICATION_PHASE.BLOCKED, {
        currentStep: r.applicationState.currentStep,
        lastUrl: r.applicationState.lastUrl ?? url,
        blockers: result.blockers,
      }, 'browser r.session could not start');
    } catch { /* preserve the browser startup error */ }
    return DONE;
  }
  r.page = r.session.page;

  return 'openApplication';
}

async function openApplication(r) {
  const { result, url, headless, checkpoint, openPage, page } = r;
  // Blockers that persist across every step (packet-level + sponsorship).
  const baseBlockers = [...result.blockers];
  // Cumulative state across multi-step pages.
  const uploadedTypes = new Set(
    (r.applicationState.uploadVerification ?? []).filter((u) => u.verified === true).map((u) => u.type),
  );
  const fieldResultKeys = new Set();
  const uploadResultKeys = new Set();
  const addFilledResult = (field, step) => {
    const key = `${step}|${field.selector ?? field.field ?? field.label ?? ''}`;
    if (fieldResultKeys.has(key)) return;
    fieldResultKeys.add(key);
    result.filled.push({ ...field, step });
  };
  const needsUserKeys = new Set();
  const addNeedsUser = (item, step, source) => {
    const label = String(item?.label ?? item ?? '').trim();
    if (!label) return;
    const key = label.toLowerCase();
    if (needsUserKeys.has(key)) return;
    needsUserKeys.add(key);
    result.needsUser.push({
      label,
      required: item?.required === true,
      kind: item?.kind ?? null,
      options: Array.isArray(item?.options) ? item.options : [],
      source,
      step,
    });
  };
  const addUploadResult = (upload, step) => {
    const key = `${step}|${upload.type ?? ''}|${upload.selector ?? ''}`;
    if (uploadResultKeys.has(key)) return;
    uploadResultKeys.add(key);
    result.uploads.uploaded.push({ ...upload, step });
  };
  // 1. Open + guard. Never proceed past a protected page.
  // Resume at the saved step — unless that URL was a wall. Reopening a
  // CAPTCHA/login page "where we left off" only ever hits the same wall (or
  // an expired SSO callback); the job's own URL is the safe restart.
  const resumeUrl = result.resumed && r.applicationState.lastUrl && !unsafeResumeUrl(r.applicationState)
    ? r.applicationState.lastUrl : url;
  await checkpoint(APPLICATION_PHASE.OPENING, {
    currentStep: r.applicationState.currentStep,
    lastUrl: resumeUrl,
    blockers: baseBlockers,
  }, result.resumed ? 'resuming last checkpoint URL' : 'opening application URL');
  r.nav = await openPage(page, resumeUrl);
  const openWait = await settleWall(r, r.nav, resumeUrl);
  if (openWait.cancelled) return cancelRun(r);
  r.nav = openWait.nav;
  result.guard = r.nav.guard;
  if (r.nav.guard?.blocked) {
    result.status = LIFECYCLE.ASSIST_BLOCKED;
    result.blockers = [...baseBlockers, wallBlockerLine(r.nav.guard, openWait.waitedMs)];
    result.sessionLeftOpen = !headless;
    await checkpoint(APPLICATION_PHASE.BLOCKED, {
      currentStep: r.applicationState.currentStep,
      lastUrl: r.nav.url ?? resumeUrl,
      blockers: result.blockers,
      lastUrlUnsafe: true,
    }, `page blocked (${r.nav.guard.kind})`);
    return DONE;
  }

  result.steps = 0;
  r.nextStep = Math.max(1, Number(r.applicationState.currentStep) || 1);
  r.runStep = 0;
  Object.assign(r, { baseBlockers, uploadedTypes, addFilledResult, addNeedsUser, addUploadResult, resumeUrl });

  return 'stepStart';
}

/** One page of the application. */
async function stepStart(r) {
  const runStep = r.runStep;
  const { result, deps, headless, checkpoint, inspectPage, baseBlockers, resumeUrl, page } = r;
  r.step = {};
  if (deps.shouldCancel?.()) return cancelRun(r);
  const stepNumber = r.nextStep;
  result.steps = runStep + 1;
  result.currentStep = stepNumber;
  // Re-inspect + re-guard on every step after the first (we navigated via a
  // "Next"/"Continue" click, so the DOM/URL may have changed entirely).
  if (runStep > 0) {
    r.nav = await inspectPage(page, resumeUrl);
    const stepWait = await settleWall(r, r.nav, resumeUrl);
    if (stepWait.cancelled) return cancelRun(r, stepNumber);
    r.nav = stepWait.nav;
    result.guard = r.nav.guard;
    if (r.nav.guard?.blocked) {
      result.status = LIFECYCLE.ASSIST_BLOCKED;
      result.blockers = [...baseBlockers, wallBlockerLine(r.nav.guard, stepWait.waitedMs)];
      result.sessionLeftOpen = !headless;
      await checkpoint(APPLICATION_PHASE.BLOCKED, {
        currentStep: stepNumber,
        lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
        blockers: result.blockers,
        lastUrlUnsafe: true,
      }, `page blocked (${r.nav.guard.kind})`);
      return DONE;
    }
  }
  const stepBlockers = [];
  // The form may be EMBEDDED in an ATS iframe (e.g. dropbox.com / samsara.com
  // hosting a Greenhouse form). Resolve the frame that actually holds the
  // fields and run every fill/scan/upload/navigate against it; falls back to
  // the page when the form is top-level (or for unit-test fakes).
  const scope = await resolveFormScope(page);
  // A page with neither application fields nor a way forward is still
  // drawing (Oracle's cookie banner can render and hold still before the
  // posting and its "Apply Now" exist). Look again for a bounded while
  // instead of deciding on a half-drawn page.
  await waitForFormOrWayIn(scope, deps.formWaitMs ?? 10000);
  await checkpoint(APPLICATION_PHASE.FILLING, {
    currentStep: stepNumber,
    lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
    blockers: baseBlockers,
  }, `step ${stepNumber}`);
  Object.assign(r.step, { stepNumber, stepBlockers, scope });
  return 'fill';
}

async function fill(r) {
  const { result, packet, dryRun, candidate, screeningAnswers, addFilledResult, addNeedsUser } = r;
  const { stepNumber, stepBlockers, scope } = r.step;
  const stepFilledKeys = new Set();
  const completedThisStep = [];

  // 2a. Re-resolve the static plan on every page. Normally it only matches
  // page one; on a resumed same-URL SPA this safely restores deterministic
  // fields instead of trusting that a previous browser process retained
  // them.
  const fill = await fillFields(scope, packet.fillPlan, { dryRun });
  for (const f of fill.filled) {
    if (f.selector) stepFilledKeys.add(f.selector);
    completedThisStep.push(f);
    addFilledResult(f, stepNumber);
  }
  r.staticUnresolved = fill.unresolved ?? [];
  for (const err of fill.errors ?? []) stepBlockers.push(`field ${err.field}: ${err.error}`);

  // 2a'. Work history and education (audit A3): an "Add" per job and degree,
  // each filled from the profile and read back. Before the generic pass, so the
  // new entries' boxes already hold their values when it looks at the page.
  const history = await fillRepeatedSections(scope, { candidate, dryRun });
  if (history.sections.some((s) => s.wanted > 0)) {
    result.repeatedSections = [...(result.repeatedSections ?? []), ...history.sections.map((s) => ({ ...s, step: stepNumber }))];
  }
  for (const f of history.filled) {
    if (f.selector) stepFilledKeys.add(f.selector);
    completedThisStep.push(f);
    addFilledResult(f, stepNumber);
  }
  for (const err of history.errors) stepBlockers.push(`work history / education: ${err}`);

  // 2b. Dynamic, type-aware fill of whatever is actually on the page now.
  // Only the application's own controls: a header search box or a
  // newsletter signup is neither filled nor counted as "this page has a
  // form" (see applicationFields / allowApplyStart below).
  const scanned = applicationFields(await scanFields(scope));
  const dyn = await fillScannedFields(scope, scanned, { candidate, screeningAnswers, alreadyFilled: stepFilledKeys, dryRun });
  for (const f of dyn.filled ?? []) {
    completedThisStep.push(f);
    addFilledResult(f, stepNumber);
  }
  r.dynamicNeedsUser = dyn.needsUser ?? [];
  for (const err of dyn.errors ?? []) stepBlockers.push(`field ${err.label ?? err.field}: ${err.error}`);

  // A checkbox/radio/select can reveal a conditional question, and that
  // question's answer can reveal another (audit A7). Re-scan after each pass
  // and fill only newly visible controls (stepFilledKeys prevents duplicate
  // actions), until a pass fills nothing new or MAX_RESCANS passes are spent,
  // so a form that keeps revealing fields cannot hold the run forever.
  const conditional = { filled: [], needsUser: [], errors: [] };
  for (let pass = 0; pass < MAX_RESCANS; pass += 1) {
    const conditionalScan = applicationFields(await scanFields(scope));
    const more = await fillScannedFields(scope, conditionalScan, {
      candidate, screeningAnswers, alreadyFilled: stepFilledKeys, dryRun,
    });
    conditional.filled.push(...(more.filled ?? []));
    conditional.needsUser.push(...(more.needsUser ?? []));
    conditional.errors.push(...(more.errors ?? []));
    for (const f of more.filled ?? []) {
      completedThisStep.push(f);
      addFilledResult(f, stepNumber);
    }
    if (!(more.filled ?? []).length) break;
  }
  const needsUserByKey = new Map(
    [...r.dynamicNeedsUser, ...(conditional.needsUser ?? [])]
      .map((item) => [`${item.selector ?? ''}|${item.label ?? ''}`, item]),
  );
  r.dynamicNeedsUser = [...needsUserByKey.values()];
  for (const f of [...(dyn.filled ?? []), ...(conditional.filled ?? [])]) {
    if (f.source !== 'screening') continue;
    result.liveAnswers.push({
      label: f.label ?? null, value: f.value ?? null, kind: f.kind ?? null, step: stepNumber,
    });
  }
  for (const err of conditional.errors ?? []) stepBlockers.push(`field ${err.label ?? err.field}: ${err.error}`);
  result.unresolved = r.staticUnresolved;

  // Invariant: the screening matcher must never answer an INVERTED
  // sponsorship question ("…work WITHOUT sponsorship?"). It refuses by
  // design, so reaching here means a config/matcher regression — treat it
  // as a hard blocker rather than submit a false immigration claim.
  for (const f of completedThisStep) {
    if (f.source === 'screening' && isInvertedSponsorshipQuestion(f.label)) {
      stepBlockers.push(
        `refusing to auto-answer an inverted sponsorship question: "${f.label}" — answer it yourself`,
      );
    }
  }

  // A dynamic form field we cannot answer blocks the run ONLY when the live
  // form marks it required. Optional unknowns (middle name, address line 2,
  // "decline to answer" EEO selects, …) are recorded and left blank so we
  // can still advance through the step.
  const requiredDynamicNeedsUser = r.dynamicNeedsUser.filter((nu) => nu.required === true);
  const optionalDynamicNeedsUser = r.dynamicNeedsUser.filter((nu) => nu.required !== true);
  result.optionalSkipped = optionalDynamicNeedsUser.map((nu) => nu.label ?? String(nu));

  // 3. Unknown screening questions (from the packet) + REQUIRED unknown form
  //    fields pause the run — we never fabricate answers.
  for (const nu of packet?.screeningPlan?.needsUser ?? []) {
    stepBlockers.push(`screening needs user: ${nu.label}`);
    addNeedsUser({ ...nu, required: true }, stepNumber, 'packet');
  }
  for (const nu of requiredDynamicNeedsUser) stepBlockers.push(`required field needs user: ${nu.label ?? nu}`);
  // Optional unknowns are captured too. They do not block the run, but they
  // are still fields left blank on a real application — worth answering once
  // rather than never learning they were skipped.
  for (const nu of r.dynamicNeedsUser) addNeedsUser(nu, stepNumber, 'form');

  Object.assign(r.step, { stepFilledKeys, completedThisStep, scanned, requiredDynamicNeedsUser });
  return 'upload';
}

async function upload(r) {
  const { result, packet, dryRun, uploadedTypes, addUploadResult } = r;
  const { stepNumber, stepBlockers, scope } = r.step;
  // 4. Upload resume (+ optional cover letter). An upload input commonly
  //    appears only AFTER the public landing page or a profile/contact step.
  //    Hold "not found" errors until we know there is no safe forward
  //    control; otherwise the old flow blocked before clicking Workday's
  //    "Apply" button and never reached the actual upload step.
  const verifiedBeforeThisStep = new Set(uploadedTypes);
  const pendingUploadBlockers = [];
  const up = await uploadFiles(scope, packet.fillPlan, { dryRun });
  for (const u of up.uploaded ?? []) {
    addUploadResult(u, stepNumber);
    // A unit-test page double cannot inspect FileList (`verified: null`),
    // but a positive failure is never treated as success. Live Playwright
    // sessions always provide explicit true/false verification.
    if (u.type && u.verified !== false) uploadedTypes.add(u.type);
  }
  for (const s of up.skipped ?? []) result.uploads.skipped.push(s);
  for (const blocker of up.blockers ?? []) {
    const type = String(blocker).split(':', 1)[0];
    const alreadyVerified = verifiedBeforeThisStep.has(type);
    const merelyAbsentOnLaterStep = /(?:input not found|no upload selector resolved)/i.test(blocker);
    if (alreadyVerified && merelyAbsentOnLaterStep) continue;
    if (merelyAbsentOnLaterStep) {
      pendingUploadBlockers.push(blocker);
      continue;
    }
    stepBlockers.push(blocker);
    if (!result.uploads.blockers.includes(blocker)) result.uploads.blockers.push(blocker);
  }
  Object.assign(r.step, { pendingUploadBlockers, up });
  return 'validate';
}

async function validate(r) {
  const { result, packet, checkpoint, baseBlockers, resumeUrl, page } = r;
  const { stepNumber, stepBlockers, scope, completedThisStep, up } = r.step;
  // 5. Required fields satisfied?
  const unresolvedQuestions = [
    ...(packet?.screeningPlan?.needsUser ?? []),
    ...r.dynamicNeedsUser,
  ];
  await checkpoint(APPLICATION_PHASE.VALIDATING, {
    currentStep: stepNumber,
    lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
    completedFields: completedThisStep,
    unresolvedQuestions,
    uploadVerification: up.uploaded ?? [],
    blockers: [...baseBlockers, ...stepBlockers],
  }, `step ${stepNumber}`);
  // Field-level errors visible right after OUR fill (a rejected date
  // format, a file the widget refused) — surfaced as blockers so the human
  // fixes them in the open browser instead of submitting a broken form.
  const fillErrors = await detectValidationErrors(scope);
  for (const e of fillErrors) stepBlockers.push(`form validation: ${e}`);
  const fieldVerification = await verifyFilledFields(scope, completedThisStep);
  result.fieldVerification ??= { accepted: [], rejected: [], unobservable: [] };
  for (const key of ['accepted', 'rejected', 'unobservable']) {
    result.fieldVerification[key].push(...(fieldVerification[key] ?? []).map((f) => ({ ...f, step: stepNumber })));
  }
  for (const rejected of fieldVerification.rejected ?? []) {
    stepBlockers.push(`field ${rejected.label ?? rejected.field ?? 'unknown'} was not accepted: ${rejected.reason}`);
  }
  const req = requiredFieldsSatisfied(result.filled, packet.fillPlan);
  // The auto-submit gate uses the STRICT form, which is not vacuously
  // satisfied by an empty static plan (see requiredFieldsSatisfied).
  result.requiredFieldsFilled = req.ok
    && requiredFieldsSatisfied(result.filled, packet.fillPlan, undefined, { strict: true }).ok;
  const pendingRequiredBlocker = req.ok ? null : `required fields missing: ${req.missing.join(', ')}`;

  // Rewrite the validating checkpoint with live acceptance results and the
  // final blocker set. The state contains only field identifiers/status —
  // never the values that were typed.
  const acceptedBySelector = new Map((fieldVerification.accepted ?? []).map((f) => [f.selector, f]));
  const rejectedBySelector = new Map((fieldVerification.rejected ?? []).map((f) => [f.selector, f]));
  const checkpointFields = completedThisStep.map((field) => {
    const accepted = acceptedBySelector.get(field.selector);
    const rejected = rejectedBySelector.get(field.selector);
    return {
      ...field,
      accepted: Boolean(accepted),
      verification: accepted ? 'live DOM retained an accepted value'
        : rejected?.reason ?? 'live value inspection unavailable',
    };
  });
  await checkpoint(APPLICATION_PHASE.VALIDATING, {
    currentStep: stepNumber,
    lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
    completedFields: checkpointFields,
    unresolvedQuestions,
    uploadVerification: up.uploaded ?? [],
    blockers: [...baseBlockers, ...stepBlockers],
  }, `step ${stepNumber} validation complete`);

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
  Object.assign(r.step, { unresolvedQuestions, checkpointFields, pendingRequiredBlocker });
  return 'decide';
}

async function decide(r) {
  const runStep = r.runStep;
  const { result, packet, dryRun, headless, checkpoint, maxSteps, baseBlockers, uploadedTypes, resumeUrl, page, tryAutoSubmit } = r;
  const { stepNumber, stepBlockers, scope, scanned, requiredDynamicNeedsUser, pendingUploadBlockers, up, unresolvedQuestions, checkpointFields, pendingRequiredBlocker } = r.step;
  // Resolve the forward control BEFORE deciding that a planned input is
  // missing. Landing pages and early wizard steps are expected not to have
  // the eventual resume/contact controls yet. We may safely advance through
  // Apply/Start/Next/Continue, then re-scan the new DOM. A final Submit is
  // still excluded by findAdvanceControl and remains human-gated.
  // `scanned` already excludes search boxes, consent banners and signup
  // forms: a JD landing page with a header search box is still fieldless.
  const advance = await findAdvanceControl(scope, {
    allowApplyStart: scanned.length === 0 && result.filled.length === 0,
  });
  // A dry run reads one page and stops before any click (N2).
  if (dryRun) {
    result.dryRun = true;
    result.status = 'dry_run';
    result.wouldClick = advance ? (advance.text ?? advance.selector ?? 'Next') : null;
    result.blockers = [...baseBlockers, ...stepBlockers];
    result.sessionLeftOpen = false;
    return DONE;
  }
  // A page with nothing of the application on it and no way forward is
  // reported as exactly that further down ("no application form found",
  // "sign-in required"). Reporting the resume input missing first sent
  // people looking for a broken upload on what was the job description.
  const nothingHere = scanned.length === 0 && result.filled.length === 0 && uploadedTypes.size === 0;
  if (!advance && !nothingHere) {
    if (pendingRequiredBlocker) stepBlockers.push(pendingRequiredBlocker);
    for (const blocker of pendingUploadBlockers) {
      stepBlockers.push(blocker);
      if (!result.uploads.blockers.includes(blocker)) result.uploads.blockers.push(blocker);
    }
  }

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
    await checkpoint(APPLICATION_PHASE.BLOCKED, {
      currentStep: stepNumber,
      lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
      completedFields: checkpointFields,
      unresolvedQuestions,
      uploadVerification: up.uploaded ?? [],
      blockers: result.blockers,
    }, 'needs the human (wall, sponsorship, or unknown required question)');
    return DONE;
  }

  // Outstanding blockers we can't auto-resolve (e.g. a missing required field
  // or a resume that wouldn't upload) stop the run for the human.
  if (result.blockers.length > 0) {
    result.status = LIFECYCLE.ASSIST_BLOCKED;
    result.sessionLeftOpen = !headless;
    await checkpoint(APPLICATION_PHASE.BLOCKED, {
      currentStep: stepNumber,
      lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
      completedFields: checkpointFields,
      unresolvedQuestions,
      uploadVerification: up.uploaded ?? [],
      blockers: result.blockers,
    }, result.blockers[0]);
    return DONE;
  }

  // Look for a safe forward control. If none exists, this is the final page:
  // everything is filled and ready — submit automatically ONLY if the human
  // opted in for this run AND the form is completely clean; otherwise stop
  // for the human to review and click Submit.
  // "Apply now"/"Start application" counts as an advance ONLY on a
  // fieldless landing page — on a filled quick-apply form that button IS
  // the submit, and clicking it would bypass the submit gate.
  // The step budget ran out with a way forward still on the page: more
  // pages remain. That is not "filled and ready", and it is never a final
  // page the submit gate may act on.
  if (advance && runStep === maxSteps - 1) {
    result.status = LIFECYCLE.ASSIST_BLOCKED;
    result.blockers = [...baseBlockers, `step limit reached: ${maxSteps} pages filled and the form continues ("${advance.text ?? 'Next'}"). Finish the remaining pages in the open window`];
    result.sessionLeftOpen = !headless;
    await checkpoint(APPLICATION_PHASE.BLOCKED, {
      currentStep: stepNumber,
      lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
      completedFields: checkpointFields,
      unresolvedQuestions,
      uploadVerification: up.uploaded ?? [],
      blockers: result.blockers,
    }, 'step budget exhausted with pages remaining');
    return DONE;
  }
  if (!advance) {
    // Never call a page "filled and ready" when no application form was
    // ever found: that told the user to review and Submit a form the run
    // had not reached (Workday's start dialog, a posting with no Apply).
    if (scanned.length === 0 && result.filled.length === 0 && uploadedTypes.size === 0) {
      result.status = LIFECYCLE.ASSIST_BLOCKED;
      const pageWords = visibleText(r.nav?.html ?? '');
      const signIn = /\b(sign\s*in|log\s*in|create\s+(?:an\s+)?account)\b/i.test(pageWords);
      const hidden = await shadowFormControlCount(scope);
      result.blockers = [...baseBlockers, hidden > 0
        ? `form not readable: ${hidden} field(s) on this page sit inside components the assistant cannot read. Fill this application yourself in the open window`
        : signIn
          ? 'sign-in required: this site asks you to sign in or create an account before the application form. Do that in the open window, then retry auto-fill'
          : 'no application form found: open the posting, continue to the application form, then retry auto-fill'];
      result.sessionLeftOpen = !headless;
      await checkpoint(APPLICATION_PHASE.BLOCKED, {
        currentStep: stepNumber,
        lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
        completedFields: checkpointFields,
        unresolvedQuestions,
        uploadVerification: up.uploaded ?? [],
        blockers: result.blockers,
      }, 'no application form found');
      return DONE;
    }
    if (await tryAutoSubmit(scope)) {
      result.sessionLeftOpen = !headless; // leave the confirmation page visible
      return DONE;
    }
    // "Ready" means every required control the live form shows is filled,
    // checked the same way the auto-submit gate checks it.
    const blankRequired = await unfilledRequiredControls(scope);
    if (Array.isArray(blankRequired) && blankRequired.length) {
      result.status = LIFECYCLE.ASSIST_BLOCKED;
      result.requiredFieldsFilled = false;
      result.blockers = [...baseBlockers, ...blankRequired.map((l) => `required field is empty: ${l}`)];
      result.sessionLeftOpen = !headless;
      await checkpoint(APPLICATION_PHASE.BLOCKED, {
        currentStep: stepNumber,
        lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
        completedFields: checkpointFields,
        unresolvedQuestions,
        uploadVerification: up.uploaded ?? [],
        blockers: result.blockers,
      }, `${blankRequired.length} required field(s) still empty`);
      return DONE;
    }
    result.status = LIFECYCLE.READY_FOR_SUBMIT;
    result.sessionLeftOpen = !headless;
    await checkpoint(APPLICATION_PHASE.READY_FOR_REVIEW, {
      currentStep: stepNumber,
      lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
      completedFields: checkpointFields,
      unresolvedQuestions,
      uploadVerification: up.uploaded ?? [],
      blockers: [],
    }, 'filled — waiting for YOUR review and Submit');
    return DONE;
  }
  Object.assign(r.step, { advance });
  return 'advance';
}

async function advance(r) {
  const { result, deps, headless, checkpoint, inspectPage, baseBlockers, resumeUrl, page, tryAutoSubmit } = r;
  const { stepNumber, scope, advance, up, unresolvedQuestions, checkpointFields } = r.step;
  await checkpoint(APPLICATION_PHASE.ADVANCING, {
    currentStep: stepNumber,
    lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
    completedFields: checkpointFields,
    unresolvedQuestions,
    uploadVerification: up.uploaded ?? [],
    blockers: [],
  }, `step ${stepNumber}: ${advance.text ?? advance.selector ?? 'next'}`);
  const beforeStep = await stepFingerprint(page, scope);
  const confirmationBefore = await submitBaseline(page, scope);
  const clicked = await clickAndSettle(scope, advance, deps);
  if (!clicked) {
    if (await tryAutoSubmit(scope)) {
      result.sessionLeftOpen = !headless;
      return DONE;
    }
    result.status = LIFECYCLE.READY_FOR_SUBMIT;
    result.sessionLeftOpen = !headless;
    await checkpoint(APPLICATION_PHASE.READY_FOR_REVIEW, {
      currentStep: stepNumber,
      lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
      completedFields: checkpointFields,
      unresolvedQuestions,
      uploadVerification: up.uploaded ?? [],
      blockers: [],
    }, 'advance control could not be activated — waiting for YOUR review');
    return DONE;
  }

  // Validate immediately after navigation. ATSes commonly keep the same URL
  // and render inline errors when a step was rejected; a resolved click is
  // therefore not proof that advancing succeeded.
  const advanced = await inspectPage(page, resumeUrl);
  const advanceWait = await settleWall(r, advanced, resumeUrl);
  if (advanceWait.cancelled) return cancelRun(r, stepNumber);
  const afterAdvance = advanceWait.nav;
  result.guard = afterAdvance.guard;
  if (afterAdvance.guard?.blocked) {
    result.status = LIFECYCLE.ASSIST_BLOCKED;
    result.blockers = [...baseBlockers, wallBlockerLine(afterAdvance.guard, advanceWait.waitedMs)];
    result.sessionLeftOpen = !headless;
    await checkpoint(APPLICATION_PHASE.BLOCKED, {
      currentStep: stepNumber,
      lastUrl: afterAdvance.url ?? currentUrlOf(page) ?? resumeUrl,
      blockers: result.blockers,
      lastUrlUnsafe: true,
    }, `page blocked after advancing (${afterAdvance.guard.kind})`);
    return DONE;
  }
  const afterScope = await resolveFormScope(page);
  const navigationErrors = await detectValidationErrors(afterScope);
  if (navigationErrors.length) {
    result.status = LIFECYCLE.ASSIST_BLOCKED;
    result.blockers = [...baseBlockers, ...navigationErrors.map((e) => `form validation: ${e}`)];
    result.sessionLeftOpen = !headless;
    await checkpoint(APPLICATION_PHASE.BLOCKED, {
      currentStep: stepNumber,
      lastUrl: afterAdvance.url ?? currentUrlOf(page) ?? resumeUrl,
      completedFields: checkpointFields,
      unresolvedQuestions,
      uploadVerification: up.uploaded ?? [],
      blockers: result.blockers,
    }, 'validation errors after advancing');
    return DONE;
  }
  // An "Apply now" that the run took for the way IN may have been the
  // final submit of a quick-apply form it could not read. If a thank-you
  // message appeared that was not there before, say so and stop: the job
  // may have been submitted, and only the human can tell.
  if (APPLY_START_RE.test(advance.text ?? '') && !confirmationBefore.confirmation
    && SUBMIT_CONFIRMATION_RE.test(visibleText(afterAdvance.html ?? ''))) {
    result.status = LIFECYCLE.SUBMIT_UNVERIFIED;
    result.submitted = false;
    result.blockers = [...baseBlockers];
    result.note = `Clicking "${advance.text}" showed a confirmation message, so this may already have been submitted. `
      + 'Check the open window and your email, then record it. NOT recorded as submitted.';
    result.sessionLeftOpen = !headless;
    return DONE;
  }
  // A click that changed nothing did not advance. ATSes that reject a step
  // with markup this run does not recognise look exactly like this, and
  // treating it as progress re-filled the same page and reported it ready.
  const afterStep = await stepFingerprint(page, afterScope);
  if (beforeStep && afterStep && beforeStep === afterStep) {
    result.status = LIFECYCLE.ASSIST_BLOCKED;
    result.blockers = [...baseBlockers, `could not advance: the page did not change after clicking "${advance.text ?? 'Next'}". Check the open window for a message on this step`];
    result.sessionLeftOpen = !headless;
    await checkpoint(APPLICATION_PHASE.BLOCKED, {
      currentStep: stepNumber,
      lastUrl: afterAdvance.url ?? currentUrlOf(page) ?? resumeUrl,
      completedFields: checkpointFields,
      unresolvedQuestions,
      uploadVerification: up.uploaded ?? [],
      blockers: result.blockers,
    }, 'advance click did not change the page');
    return DONE;
  }
  result.advancedSteps = (result.advancedSteps ?? 0) + 1;
  r.nextStep = stepNumber + 1;
  r.nav = afterAdvance;
  await checkpoint(APPLICATION_PHASE.ADVANCING, {
    currentStep: r.nextStep,
    lastUrl: afterAdvance.url ?? currentUrlOf(page) ?? resumeUrl,
    completedFields: checkpointFields,
    unresolvedQuestions: [],
    uploadVerification: up.uploaded ?? [],
    blockers: [],
  }, `step ${stepNumber} accepted; checkpointed step ${r.nextStep}`);
  r.runStep += 1;

  return r.runStep < r.maxSteps ? 'stepStart' : 'exhausted';
}

async function exhausted(r) {
  const { result, headless, checkpoint, resumeUrl, page } = r;
  result.status = result.blockers.length > 0 ? LIFECYCLE.ASSIST_BLOCKED : LIFECYCLE.READY_FOR_SUBMIT;
  result.sessionLeftOpen = !headless;
  await checkpoint(result.blockers.length > 0 ? APPLICATION_PHASE.BLOCKED : APPLICATION_PHASE.READY_FOR_REVIEW, {
    currentStep: r.nextStep,
    lastUrl: r.nav.url ?? currentUrlOf(page) ?? resumeUrl,
    blockers: result.blockers,
  }, 'assist step budget exhausted');
  return DONE;

}

const STATES = { begin, launch, openApplication, stepStart, fill, upload, validate, decide, advance, exhausted };

async function enter(r, name) {
  r.deps.onState?.(name);
  const next = await STATES[name](r);
  if (next !== DONE && !TRANSITIONS[name].includes(next)) {
    throw new Error(`assist state machine: ${name} may not hand over to ${next}`);
  }
  return next;
}

/**
 * Walk the states until one returns DONE, then settle the browser.
 * Errors before a browser exists reject, as before; once it is open, an error
 * becomes a result, and the window is closed or handed to the human.
 *
 * @param {object} r the run (see assistApply)
 * @returns {Promise<object>} r.result
 */
export async function runAssist(r) {
  const { result, options, deps } = r;
  const { url, clock, nowIso, checkpoint } = r;
  let state = 'begin';
  while (state !== DONE && state !== 'openApplication') state = await enter(r, state);
  if (state === DONE) return result;
  try {
    while (state !== DONE) state = await enter(r, state);
    return result;
  } catch (err) {
    // The human closing the assist browser window is a normal, deliberate act
    // (they finished the application by hand, or decided "not now") — NOT a
    // failure and NOT a wall. Report it as ready_for_submit so the dashboard
    // prompts "did you submit it?" instead of scaring them with "blocked".
    if (isBrowserClosedError(err)) {
      const submitMayHaveStarted = [
        APPLICATION_PHASE.SUBMITTING, APPLICATION_PHASE.VERIFYING,
        APPLICATION_PHASE.USER_SUBMITTED,
      ].includes(r.applicationState.phase);
      result.status = submitMayHaveStarted ? LIFECYCLE.SUBMIT_UNVERIFIED : LIFECYCLE.READY_FOR_SUBMIT;
      result.browserClosedByUser = true;
      result.note = submitMayHaveStarted
        ? 'Browser closed during the final submit attempt. Automatic retry is disabled; verify the ATS or confirmation email manually.'
        : 'Browser was closed during assist — if you finished and submitted the application yourself, mark it Submitted; otherwise resume the application.';
      if (!submitMayHaveStarted) {
        try {
          await checkpoint(APPLICATION_PHASE.READY_FOR_REVIEW, {
            currentStep: result.currentStep ?? r.applicationState.currentStep,
            lastUrl: currentUrlOf(r.session?.page) ?? r.applicationState.lastUrl ?? url,
            blockers: [],
          }, 'browser closed by user');
        } catch { /* state persistence error is surfaced on the next resume */ }
      }
      return result;
    }
    result.status = LIFECYCLE.FAILED;
    result.blockers.push(`assist error: ${err.message}`);
    if (!err.applicationStatePersistence && !applicationStatePreventsReopen(r.applicationState)) {
      try {
        await checkpoint(APPLICATION_PHASE.FAILED, {
          currentStep: result.currentStep ?? r.applicationState.currentStep,
          lastUrl: currentUrlOf(r.session?.page) ?? r.applicationState.lastUrl ?? url,
          blockers: result.blockers,
        }, 'unexpected assist error');
      } catch { /* preserve the original assist error */ }
    }
    return result;
  } finally {
    // Close only when we are NOT intentionally leaving the browser open for the
    // human (headed + stopped before submit). In headless/CI, always close.
    if (!result.sessionLeftOpen) {
      await r.session.close?.();
    } else if (shouldWatchForHumanSubmit(result, options, r.session?.page)) {
      // The human has the window now. If they submit and the ATS shows its
      // confirmation page, record that as a human submission PENDING their
      // confirmation — it used to go unrecorded until they remembered to press
      // "Mark submitted", while the job still read "ready to submit" and a
      // re-run could reopen it.
      result.watchingForHumanSubmit = true;
      const inspect = deps.inspectPage ?? inspectCurrentPage;
      result.humanSubmitWatch = watchForHumanSubmission({
        page: r.session.page,
        url,
        inspectPage: inspect,
        pollMs: options.humanSubmitPollMs,
        timeoutMs: options.humanSubmitWatchMs,
        onConfirmed: async (verification) => {
          const evidence = [
            'confirmation page seen after hand-off to the human',
            ...verification.signals,
          ];
          try {
            const next = transitionApplicationState(r.applicationState, APPLICATION_PHASE.USER_SUBMITTED, {
              lastUrl: verification.lastUrl ?? url,
              submissionEvidence: evidence,
              blockers: [],
            }, { now: clock, detail: 'confirmation page detected after the human took over' });
            r.applicationState = next;
            if (r.stateStore) await r.stateStore.save?.(next);
          } catch { /* the DB record below is still made */ }
          const update = {
            jobId: result.jobId,
            status: LIFECYCLE.SUBMIT_UNVERIFIED,
            submitted: false,
            filled: result.filled,
            blockers: [],
            humanSubmissionDetected: {
              at: nowIso(),
              url: verification.lastUrl ?? null,
              signals: verification.signals,
            },
            phases: [{ phase: APPLICATION_PHASE.USER_SUBMITTED, at: nowIso(), detail: 'confirmation page detected' }],
          };
          try { await deps.onHumanSubmitted?.(update); } catch { /* recording is best-effort here */ }
        },
      });
    }
  }
}
