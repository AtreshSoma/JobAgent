/**
 * Dashboard data layer.
 *
 * Pure query/aggregation functions over the local SQLite store — no HTTP, no
 * DOM — so the entire dashboard contract is unit-testable. The server is a
 * thin JSON shell around these functions.
 *
 * Key concepts:
 *   - appStatus: ONE derived, human-meaningful status per job that merges the
 *     pipeline status, the approval queue, and the user's own triage decision
 *     (shortlist/reject/archive). Truthfulness rule: a job only ever reads
 *     "submitted" (jobs.applied = 1) when the human submitted it, or when the
 *     human-opted-in auto-submit VERIFIED the submission (confirmation page).
 *     An auto-submit click without confirmation reads "submit_unverified" and
 *     needs the human to confirm — it never counts as submitted on its own.
 *   - fitBucket: strong / medium / weak / no_fit, derived from the scoring tier.
 *   - whyFit: the stored score explanation + matched/missing keywords, so the
 *     UI can show exactly WHY a job ranked where it did.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { APPROVAL_STATUS, approve, reject, latestApprovalsByJob } from '../apply/approvalQueue.js';
import { jsonList } from '../utils/json.js';
import { isWithinLast24Hours, isWithinLastHours, formatPostedRelative } from '../utils/dates.js';
import { EMPLOYMENT_LABELS } from '../scoring/employmentClassifier.js';
import { applicationStatePath } from '../apply/applicationState.js';
import { isSponsorshipGated, configureGateThreshold, gateThreshold } from '../scoring/explainScore.js';
import { extractDocxText } from '../resume/docxText.js';
import { usLocationSignal, US_STATE_COUNT } from '../utils/usGeography.js';

/** Derived application statuses shown on the board (ordered by precedence). */
export const APP_STATUS = Object.freeze({
  SUBMITTED: 'submitted',          // human submitted it, or auto-submit verified it (applied = 1)
  ARCHIVED: 'archived',            // user archived it
  REJECTED: 'rejected',            // user rejected it (or rejected the packet)
  SKIPPED: 'skipped',              // user skipped it during assisted apply
  BLOCKED: 'blocked',              // assist hit login/captcha/unknown fields
  FAILED: 'failed',                // unexpected assist/component error; retry after RCA
  CANCELLED: 'cancelled',          // user cancelled at a safe resumable checkpoint
  SUBMIT_UNVERIFIED: 'submit_unverified', // auto-submit clicked; no confirmation detected — verify!
  READY_FOR_SUBMIT: 'ready_for_submit', // form filled; awaiting the human's click
  APPROVED: 'approved',            // packet approved; ready for assisted fill
  NEEDS_REVIEW: 'needs_review',    // packet prepared; awaiting human approval
  SHORTLISTED: 'shortlisted',      // user shortlisted; not yet prepared/approved
  DATE_UNCONFIRMED: 'date_unconfirmed', // no parseable posting date; flagged for review
  DISCARDED: 'discarded',          // pipeline hard-excluded or below threshold
  SCORED: 'scored',                // scored, no action yet
  DISCOVERED: 'discovered',        // found, not yet scored
});

/** User decisions accepted by applyDecision(). */
export const USER_DECISIONS = Object.freeze(['shortlisted', 'rejected', 'archived', 'clear']);

/**
 * Derive the single board status for a job + its latest approval row.
 * Precedence: actual submission > user archive/reject > assist outcomes >
 * approval state > user shortlist > pipeline state.
 *
 * @param {object} job jobs-table row
 * @param {object|null} approval latest approval_queue row
 * @returns {string} an APP_STATUS value
 */
export function deriveAppStatus(job = {}, approval = null) {
  if (Number(job.applied) === 1) return APP_STATUS.SUBMITTED;
  if (job.user_decision === 'archived') return APP_STATUS.ARCHIVED;
  if (job.user_decision === 'rejected') return APP_STATUS.REJECTED;
  if (job.status === 'skipped') return APP_STATUS.SKIPPED;
  if (job.status === 'assist_blocked') return APP_STATUS.BLOCKED;
  if (job.status === 'failed') return APP_STATUS.FAILED;
  if (job.status === 'cancelled') return APP_STATUS.CANCELLED;
  if (job.status === 'submit_unverified') return APP_STATUS.SUBMIT_UNVERIFIED;
  if (job.status === 'ready_for_submit') return APP_STATUS.READY_FOR_SUBMIT;
  if (approval?.approval_status === APPROVAL_STATUS.REJECTED) return APP_STATUS.REJECTED;
  if (approval?.approval_status === APPROVAL_STATUS.APPROVED) return APP_STATUS.APPROVED;
  if (approval?.approval_status === APPROVAL_STATUS.PENDING) return APP_STATUS.NEEDS_REVIEW;
  if (job.user_decision === 'shortlisted') return APP_STATUS.SHORTLISTED;
  if (job.status === 'unknown_date_review') return APP_STATUS.DATE_UNCONFIRMED;
  if (job.status === 'discarded') return APP_STATUS.DISCARDED;
  if (typeof job.score === 'number' || job.tier) return APP_STATUS.SCORED;
  return APP_STATUS.DISCOVERED;
}

// The sponsorship gate is a SCORING concept; it lives in scoring/explainScore.js
// next to the rule that creates it. Re-exported here (alongside a real local
// import, since `export … from` alone would not bind it for use below) so every
// existing dashboard consumer and its tests keep one import site.
export { isSponsorshipGated, configureGateThreshold, gateThreshold };

/**
 * Map a scoring tier to a fit bucket.
 *
 * FIT measures how well the ROLE matches the candidate; sponsorship
 * feasibility is reported separately. A 75+ job the sponsorship gate parked
 * in Queue is therefore still a STRONG fit (with sponsorshipGated: true and a
 * "verify sponsorship" action) — hiding those as "medium" made 10k-job sources
 * read as producing zero strong matches.
 *
 * @param {string|null} tier
 * @param {number|null} [score] pass the job's score to classify gated rows
 * @returns {'strong'|'medium'|'weak'|'no_fit'|'unscored'}
 */
export function fitBucket(tier, score = null) {
  if (tier === 'Priority' || tier === 'Apply') return 'strong';
  if (tier === 'Queue') return isSponsorshipGated({ tier, score }) ? 'strong' : 'medium';
  if (tier === 'Near miss') return 'weak';
  if (tier === 'Discard') return 'no_fit';
  return 'unscored';
}

/**
 * Letter grade for a 0-100 score — a compact, career-ops-style signal of how
 * worth-your-time a role is. The system is a FILTER, not spray-and-pray: grades
 * D/F are de-emphasized in the UI so you focus on the few A/B roles.
 *
 * @param {number|null} score
 * @returns {{ letter: string, label: string, recommend: boolean }|null}
 */
export function gradeFromScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return null;
  if (score >= 85) return { letter: 'A', label: 'Excellent fit', recommend: true };
  if (score >= 75) return { letter: 'B', label: 'Strong fit', recommend: true };
  if (score >= 65) return { letter: 'C', label: 'Possible fit', recommend: true };
  if (score >= 50) return { letter: 'D', label: 'Weak fit', recommend: false };
  return { letter: 'F', label: 'Poor fit', recommend: false };
}

/**
 * Confidence in a job's posting date. Aggregator feeds often omit or mangle the
 * date; those are flagged so a stale role is never mistaken for a fresh one.
 * @param {object} job
 * @returns {'confirmed'|'unconfirmed'}
 */
export function postedConfidence(job = {}) {
  if (job.status === 'unknown_date_review') return 'unconfirmed';
  return job.posted_at ? 'confirmed' : 'unconfirmed';
}

/**
 * Resume packet readiness for a job, for an at-a-glance column.
 * @param {object} job
 * @returns {'tailored'|'prepared'|'none'}
 */
export function resumeStatusOf(job = {}) {
  if (job.resume_pdf_path || job.resume_docx_path || job.resume_path) return 'tailored';
  if (job.application_packet_path) return 'prepared';
  return 'none';
}

/**
 * The happy-path pipeline a job advances through, plus terminal off-ramps. Used
 * to draw a progress bar so you can see at a glance where each job stands and
 * where the bottlenecks are.
 */
export const PROGRESS_STAGES = Object.freeze([
  'discovered', 'scored', 'shortlisted', 'prepared', 'approved', 'ready_for_submit', 'submitted',
]);

/** Off-ramp statuses that are not points on the linear pipeline. */
const OFFRAMP_STAGE = Object.freeze({
  [APP_STATUS.BLOCKED]: 'blocked',
  [APP_STATUS.FAILED]: 'failed',
  [APP_STATUS.CANCELLED]: 'cancelled',
  [APP_STATUS.SKIPPED]: 'skipped',
  [APP_STATUS.REJECTED]: 'rejected',
  [APP_STATUS.ARCHIVED]: 'archived',
  [APP_STATUS.DISCARDED]: 'discarded',
  [APP_STATUS.DATE_UNCONFIRMED]: 'date_unconfirmed',
  [APP_STATUS.SUBMIT_UNVERIFIED]: 'submit_unverified',
});

/**
 * Map a board appStatus to a progress position.
 *
 * @param {string} appStatus an APP_STATUS value
 * @returns {{ stage: string, index: number, total: number, offRamp: boolean, percent: number }}
 */
export function progressFor(appStatus) {
  const total = PROGRESS_STAGES.length;
  if (OFFRAMP_STAGE[appStatus]) {
    return { stage: OFFRAMP_STAGE[appStatus], index: -1, total, offRamp: true, percent: 0 };
  }
  // needs_review sits at the "prepared" position (packet built, awaiting approval).
  const normalized = appStatus === APP_STATUS.NEEDS_REVIEW ? 'prepared' : appStatus;
  const index = PROGRESS_STAGES.indexOf(normalized);
  const i = index < 0 ? 0 : index;
  return { stage: PROGRESS_STAGES[i], index: i, total, offRamp: false, percent: Math.round((i / (total - 1)) * 100) };
}

/**
 * Best-effort "last thing that happened" timestamp + human label for a job, so
 * the board can show recency of action rather than just discovery time.
 * @param {object} job
 * @param {string} appStatus
 * @returns {{ at: string|null, label: string }}
 */
export function lastActionFor(job = {}, appStatus = '') {
  if (Number(job.applied) === 1 && job.applied_at) return { at: job.applied_at, label: 'submitted' };
  if (job.decided_at && job.user_decision) return { at: job.decided_at, label: job.user_decision };
  if (job.updated_at && job.updated_at !== job.created_at) return { at: job.updated_at, label: appStatus || 'updated' };
  return { at: job.created_at ?? null, label: 'discovered' };
}

/**
 * Plain-language explanation of WHY a job sits in its current status — the
 * answer to "why is this blocked / rejected / discarded?". Honest about the
 * common case where an older assisted-fill attempt stopped at a wall but did
 * not record the specific reason.
 *
 * @param {object} job jobs-table row
 * @param {string} appStatus derived board status
 * @param {object|null} approval latest approval row
 * @returns {string|null} a human reason, or null when none applies
 */
export function explainStatus(job = {}, appStatus = '', approval = null) {
  const blockers = jsonList(job.assist_blockers);
  switch (appStatus) {
    case APP_STATUS.SUBMIT_UNVERIFIED:
      return 'Auto-submit clicked Submit, but no confirmation page could be detected. Check your email '
        + '(or the ATS) for a confirmation: if the application went through, use "Mark submitted"; if not, '
        + 'open the posting and finish it manually. It is NOT counted as submitted until you confirm.';
    case APP_STATUS.BLOCKED:
      if (blockers.length) return `Assisted fill stopped: ${blockers.join('; ')}`;
      return 'An assisted-fill attempt stopped at an application wall (login, CAPTCHA, an account step, '
        + 'or a question it will not guess). The specific reason was not recorded — open the posting to finish '
        + 'manually, or re-run assisted fill to capture the current blocker.';
    case APP_STATUS.FAILED:
      return blockers.length
        ? `The last fill failed: ${blockers.join('; ')}`
        : 'The last fill failed unexpectedly. Review the Activity/RCA details, then Retry or Resume.';
    case APP_STATUS.CANCELLED:
      return 'You cancelled the fill at a safe checkpoint. Resume continues from the saved application URL.';
    case APP_STATUS.REJECTED:
      if (job.user_decision === 'rejected') return 'You rejected this job.';
      if (approval?.approval_status === APPROVAL_STATUS.REJECTED) return 'Its prepared packet was rejected, so it will not be applied to.';
      return 'Rejected.';
    case APP_STATUS.DISCARDED:
      return job.discard_reason
        ? `Filtered out during scoring: ${job.discard_reason}`
        : 'Filtered out during scoring (below threshold or an exclusion rule matched).';
    case APP_STATUS.DATE_UNCONFIRMED:
      return 'No reliable posting date was found, so its freshness cannot be trusted — verify before relying on "posted" age.';
    case APP_STATUS.SKIPPED:
      return 'You skipped this during an assisted-apply pass.';
    case APP_STATUS.ARCHIVED:
      return 'You archived this job.';
    default:
      return null;
  }
}

/**
 * Turn the overloaded technical `assist_blocked` state into the action the
 * person actually needs to take. This is presentation metadata only: it does
 * not weaken any automation guard or guess an answer.
 */
export function classifyAttention(job = {}, appStatus = '') {
  if (![APP_STATUS.BLOCKED, APP_STATUS.FAILED, APP_STATUS.CANCELLED].includes(appStatus)) return null;
  const reason = jsonList(job.assist_blockers).join(' ').toLowerCase();
  let aggregator = false;
  try { aggregator = /(^|\.)(linkedin|indeed|glassdoor|dice|ziprecruiter|simplyhired|monster)\./i.test(new URL(job.url).hostname); }
  catch { /* invalid URL is classified below */ }
  if (appStatus === APP_STATUS.CANCELLED) return {
    kind: 'paused', label: 'Paused safely', summary: 'Resume Auto-fill when you are ready.', retryable: true,
  };
  if (/captcha|verification challenge|human verification/.test(reason)) return {
    kind: 'verification', label: 'Needs verification', summary: 'Complete the site verification in the open browser, then retry Auto-fill.', retryable: true,
  };
  if (/login|sign[ -]?in|account required|authenticate|\bmfa\b/.test(reason)) return {
    kind: 'sign_in', label: 'Needs sign-in', summary: 'Sign in on the employer site, then retry Auto-fill.', retryable: true,
  };
  if (/upload input not found|no upload selector resolved/.test(reason)) return {
    kind: 'form_step', label: 'Continue to form', summary: 'The resume field was not on the current page. Continue to the application form and retry Auto-fill.', retryable: true,
  };
  if (/could not start browser|profile.*lock|target.*closed/.test(reason)) return {
    kind: 'browser_session', label: 'Browser needs attention', summary: 'The browser session could not start. Retry with the dedicated Job Agent session.', retryable: true,
  };
  if (/404|not found|\bgone\b|posting.*closed/.test(reason)) return {
    kind: 'dead_link', label: 'Check posting link', summary: 'The saved posting may be closed or stale. Check it or replace it with the direct employer URL.', retryable: false,
  };
  if (/403|forbidden|access denied/.test(reason) || aggregator) return {
    kind: aggregator ? 'aggregator' : 'restricted_link', label: 'Open manually',
    summary: aggregator ? 'Use the employer Apply link, then save that direct URL here.' : 'The site restricts automated access; opening it manually may still work.',
    retryable: false,
  };
  if (appStatus === APP_STATUS.FAILED) return {
    kind: 'retry', label: 'Retry needed', summary: 'Review the recorded error, then retry Auto-fill.', retryable: true,
  };
  return {
    kind: 'needs_help', label: 'Needs your help', summary: 'Open the application to complete the step the assistant could not safely answer.', retryable: true,
  };
}

/** An Error carrying the HTTP status the server should reply with. */
function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/** Latest approval row per job id (shared precedence with every consumer). */
const approvalsByJob = latestApprovalsByJob;

/*
 * Decoration cache.
 *
 * Every dashboard endpoint decorates the FULL jobs table per request; at tens
 * of thousands of rows that is ~1s of blocked event loop each, and the page's
 * initial burst (stats + sections + jobs + status) queues them back-to-back —
 * the UI reads as frozen. Cache the expensive computations, keyed by:
 *   - SQLite total_changes() for this connection — any write (upsert, decision,
 *     approval, note) bumps it, so mutations invalidate instantly, and
 *   - a 30s time bucket — `now`-derived fields (postedLabel, last-24h flags)
 *     refresh on their own even with no writes.
 * Per-Database WeakMap so tests with separate in-memory DBs never collide.
 */
const _memo = new WeakMap();
function cached(db, kind, now, compute) {
  let changes = -1;
  try { changes = db.db.prepare('SELECT total_changes() AS c').get().c; }
  catch { return compute(); /* exotic db stub (tests) — skip caching */ }
  const at = typeof now?.getTime === 'function' ? now.getTime() : Date.now();
  const key = `${changes}:${Math.floor(at / 30_000)}`;
  let slot = _memo.get(db);
  if (!slot) { slot = {}; _memo.set(db, slot); }
  if (slot[kind]?.key === key) return slot[kind].val;
  const val = compute();
  slot[kind] = { key, val };
  return val;
}

/** All jobs decorated as board rows (cached — see above). */
function allBoardRows(db, now) {
  return cached(db, 'rows', now, () => {
    const approvals = approvalsByJob(db);
    return listSummaryRows(db).map((job) => boardRow(job, approvals.get(job.id) ?? null, now));
  });
}

/**
 * All jobs without jd_text (board rows never render it; detail loads it via
 * getJob). Falls back to listJobs for test stubs that only implement that.
 */
function listSummaryRows(db) {
  return typeof db.listJobsSummary === 'function' ? db.listJobsSummary() : db.listJobs({});
}

/** ISO date prefix (YYYY-MM-DD) of a date. */
function dayOf(value) {
  return String(value ?? '').slice(0, 10);
}

/**
 * Was this row dropped purely because its posting date was unreadable?
 *
 * Matches both the current honest reason and the historical "stale: unknown
 * posting date" label, so counts stay correct on databases written before the
 * mislabeling was fixed (and whether or not the relabel migration has run).
 * @param {object} job jobs-table row
 */
export function isUndatedDrop(job = {}) {
  return /unknown posting date/i.test(String(job.discard_reason ?? ''));
}

/** Statuses considered "closed" — hidden from the default board. */
export const CLOSED_STATUSES = Object.freeze([
  APP_STATUS.ARCHIVED, APP_STATUS.REJECTED, APP_STATUS.DISCARDED,
]);
const CLOSED_SET = new Set(CLOSED_STATUSES);

/**
 * When was this job's packet prepared? Prefers the true prepared_at stamp;
 * legacy rows (prepared before the column existed) fall back to updated_at
 * ONLY while the row still sits in `prepared` (any later action bumps
 * updated_at and would otherwise re-count an old packet as "prepared today").
 * @param {object} job jobs-table row
 * @returns {string|null} ISO timestamp
 */
function preparedAtOf(job) {
  if (!job.application_packet_path) return null;
  if (job.prepared_at) return job.prepared_at;
  return job.status === 'prepared' ? (job.updated_at ?? null) : null;
}

/**
 * The single source of truth for the section tabs. Each view is a predicate
 * over a decorated board row. Because the SAME predicates drive both the tab
 * COUNTS and the board FILTER, a tab's badge always equals the number of rows
 * shown when you click it (fixing the old "Ready to submit: 19" badge over a
 * board of 0 rows).
 */
export const BOARD_VIEWS = Object.freeze({
  all: (r) => !CLOSED_SET.has(r.appStatus),
  today: (r) => [
    APP_STATUS.READY_FOR_SUBMIT, APP_STATUS.SUBMIT_UNVERIFIED,
    APP_STATUS.BLOCKED, APP_STATUS.FAILED, APP_STATUS.CANCELLED, APP_STATUS.NEEDS_REVIEW,
  ].includes(r.appStatus)
    || (r.postedLast24h && r.fit === 'strong'
      && [APP_STATUS.SCORED, APP_STATUS.DISCOVERED].includes(r.appStatus))
    || (r.sponsorshipGated && !CLOSED_SET.has(r.appStatus)),
  // "Best matches" = strong, recommended jobs still awaiting your triage. Once
  // you shortlist/prepare them they move to their stage tab, so this list never
  // overlaps the other tabs — it is purely "new strong opportunities to act on".
  best: (r) => r.fit === 'strong' && r.grade?.recommend === true
    && (r.appStatus === APP_STATUS.SCORED || r.appStatus === APP_STATUS.DISCOVERED),
  shortlisted: (r) => r.appStatus === APP_STATUS.SHORTLISTED,
  needs_review: (r) => r.appStatus === APP_STATUS.NEEDS_REVIEW,
  // "Ready to apply": packet approved (ready to auto-fill) OR already filled and
  // waiting for your manual submit. Both need a human action next.
  ready_apply: (r) => r.appStatus === APP_STATUS.APPROVED || r.appStatus === APP_STATUS.READY_FOR_SUBMIT,
  blocked: (r) => [APP_STATUS.BLOCKED, APP_STATUS.FAILED, APP_STATUS.CANCELLED].includes(r.appStatus),
  submitted: (r) => r.appStatus === APP_STATUS.SUBMITTED,
});

/** Count rows per board view (each equals what clicking that tab shows). */
export function countViews(rows = []) {
  const counts = {};
  for (const key of Object.keys(BOARD_VIEWS)) counts[key] = 0;
  for (const r of rows) {
    for (const [key, pred] of Object.entries(BOARD_VIEWS)) {
      if (pred(r)) counts[key] += 1;
    }
  }
  return counts;
}

/** Decorate one db row with all derived board fields. */
function boardRow(job, approval, now) {
  const matched = jsonList(job.matched_keywords);
  const missing = jsonList(job.missing_keywords);
  const appStatus = deriveAppStatus(job, approval);
  const score = typeof job.score === 'number' ? job.score : null;
  const haystack = `${job.location ?? ''} ${job.employment_type ?? ''} ${job.title ?? ''}`.toLowerCase();
  return {
    id: job.id,
    company: job.company,
    // Historical provider rows can be incomplete. Never render a blank role
    // name (which also produces unusable checkbox/button accessible names).
    title: String(job.title ?? '').trim() || 'Title not identified',
    location: job.location,
    url: job.url,
    source: job.source || 'unknown',
    score,
    grade: gradeFromScore(score),
    tier: job.tier ?? null,
    fit: fitBucket(job.tier, score),
    sponsorshipGated: isSponsorshipGated(job),
    sponsorship: job.sponsorship ?? null,
    employmentType: job.employment_type ?? null,
    employmentCategory: job.employment_category ?? null,
    employmentLabel: EMPLOYMENT_LABELS[job.employment_category] ?? null,
    compensation: job.compensation_text ?? null,
    remote: /\bremote\b/.test(haystack),
    postedAt: job.posted_at ?? null,
    postedLabel: formatPostedRelative(job.posted_at, now),
    postedLast24h: isWithinLast24Hours(job.posted_at, now),
    postedConfidence: postedConfidence(job),
    undatedDrop: isUndatedDrop(job),
    appStatus,
    progress: progressFor(appStatus),
    statusReason: explainStatus(job, appStatus, approval),
    attention: classifyAttention(job, appStatus),
    lastAction: lastActionFor(job, appStatus),
    userDecision: job.user_decision ?? null,
    atsPlatform: job.ats_platform ?? null,
    resumeStatus: resumeStatusOf(job),
    atsScore: job.ats_score == null || job.ats_score === '' ? null : Number(job.ats_score),
    atsBand: job.ats_band ?? null,
    explanation: job.explanation ?? null,
    discardReason: job.discard_reason ?? null,
    matchedKeywords: matched,
    missingKeywords: missing,
    assistFilledCount: typeof job.assist_filled_count === 'number' ? job.assist_filled_count : null,
    assistBlockers: jsonList(job.assist_blockers),
    approvalId: approval?.id ?? null,
    approvalStatus: approval?.approval_status ?? null,
    packetPath: job.application_packet_path ?? null,
    resumePath: job.resume_path ?? null,
    resumeDocxPath: job.resume_docx_path ?? job.resume_path ?? null,
    resumePdfPath: job.resume_pdf_path ?? null,
    coverLetterPath: job.cover_letter_path ?? null,
    notes: job.notes ?? null,
    submittedConfirmation: job.submitted_confirmation ?? null,
    appliedAt: job.applied_at ?? null,
    createdAt: job.created_at ?? null,
    updatedAt: job.updated_at ?? null,
  };
}

/**
 * Headline stats for the dashboard tiles + source/status breakdowns.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {object}
 */
export function dashboardStats(db, { now = new Date() } = {}) {
  return cached(db, 'stats', now, () => computeDashboardStats(db, now));
}

function computeDashboardStats(db, now) {
  const jobs = listSummaryRows(db);
  const approvals = approvalsByJob(db);
  const today = dayOf(now.toISOString());

  // Last 7 calendar days (oldest first) for the daily-progress strip.
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    days.push(dayOf(new Date(now.getTime() - i * 86_400_000).toISOString()));
  }
  const daily = new Map(days.map((d) => [d, { day: d, discovered: 0, prepared: 0, submitted: 0 }]));

  const stats = {
    generatedAt: now.toISOString(),
    totals: {
      jobsTracked: jobs.length,
      discoveredToday: 0,
      discoveredLast24h: 0,
      postedLast24h: 0,
      strongFit: 0,
      mediumFit: 0,
      weakFit: 0,
      shortlisted: 0,
      rejected: 0,
      skipped: 0,
      dateUnconfirmed: 0,
      // Rows the freshness gate dropped ONLY because the source gave no
      // parseable posting date. These are not stale and not judged on fit —
      // they are unreviewed. Counted separately (and including closed rows,
      // since that is exactly where they land) so the volume is never hidden.
      undatedDropped: 0,
      preparedToday: 0,
      submittedToday: 0,
      submittedThisWeek: 0,
      qualifiedToday: 0,
      needsSponsorshipCheck: 0,
      pendingReview: 0,
      blocked: 0,
      readyForSubmit: 0,
      submitUnverified: 0,
      submittedTotal: 0,
    },
    // ISO timestamp of the most recent discovery (max created_at) so the UI can
    // show "last discovery Nh ago" — this explains a legitimate "0 discovered
    // today" when discovery simply has not run yet today.
    lastDiscoveryAt: null,
    bySource: {},
    byStatus: {},
    // sponsorship status -> { count, strong } so feasibility is visible at a glance
    bySponsorship: {},
    // USPS code -> { count, strong }. Makes nationwide coverage VERIFIABLE
    // rather than assumed: the searches say "United States", and this says
    // which states actually came back. A gap here is a real coverage gap.
    byState: {},
    daily: [],
    nextActions: [],
    // Section-tab counts — derived from the SAME predicates the board filters by,
    // so each tab badge equals exactly what clicking it shows.
    views: Object.fromEntries(Object.keys(BOARD_VIEWS).map((k) => [k, 0])),
  };

  for (const job of jobs) {
    const approval = approvals.get(job.id) ?? null;
    const status = deriveAppStatus(job, approval);
    const fit = fitBucket(job.tier, typeof job.score === 'number' ? job.score : null);
    const source = job.source || 'unknown';

    if (dayOf(job.created_at) === today) stats.totals.discoveredToday += 1;
    if (isWithinLast24Hours(job.created_at, now)) stats.totals.discoveredLast24h += 1;
    if (job.created_at && (!stats.lastDiscoveryAt || job.created_at > stats.lastDiscoveryAt)) {
      stats.lastDiscoveryAt = job.created_at;
    }
    // Posted-in-last-24h counts ACTIONABLE jobs only (not discarded/closed) so
    // the header chip always reconciles with what the board's "last 24h"
    // filter shows — a big raw count over a mostly-hidden board reads as a bug.
    if (isWithinLast24Hours(job.posted_at, now) && !CLOSED_SET.has(status)) stats.totals.postedLast24h += 1;
    // Fit tiles count ACTIONABLE jobs only (not archived/rejected/discarded) so
    // clicking a tile shows exactly as many rows as the tile promised — the
    // default board hides closed jobs.
    if (!CLOSED_SET.has(status)) {
      if (fit === 'strong') stats.totals.strongFit += 1;
      if (fit === 'medium') stats.totals.mediumFit += 1;
      if (fit === 'weak') stats.totals.weakFit += 1;
      // Strong-fit roles parked by the sponsorship gate: the next action is to
      // verify the employer's sponsorship posture, not to discard the job.
      if (isSponsorshipGated(job)) stats.totals.needsSponsorshipCheck += 1;
    }
    if (job.user_decision === 'shortlisted') stats.totals.shortlisted += 1;
    if (status === APP_STATUS.REJECTED) stats.totals.rejected += 1;
    if (status === APP_STATUS.SKIPPED) stats.totals.skipped += 1;
    if (status === APP_STATUS.DATE_UNCONFIRMED) stats.totals.dateUnconfirmed += 1;
    if (isUndatedDrop(job)) stats.totals.undatedDropped += 1;
    if (dayOf(preparedAtOf(job)) === today && Number(job.applied) !== 1) stats.totals.preparedToday += 1;
    if (Number(job.applied) === 1 && dayOf(job.applied_at) === today) stats.totals.submittedToday += 1;
    if (Number(job.applied) === 1 && job.applied_at
        && (now.getTime() - new Date(job.applied_at).getTime()) < 7 * 86_400_000) {
      stats.totals.submittedThisWeek += 1;
    }
    // "New qualified" means the POSTING is genuinely fresh, not merely that
    // an older job happened to enter our database today.
    if (fit === 'strong' && isWithinLast24Hours(job.posted_at, now)
        && !CLOSED_SET.has(status)) {
      stats.totals.qualifiedToday += 1;
    }
    if (status === APP_STATUS.NEEDS_REVIEW) stats.totals.pendingReview += 1;
    if ([APP_STATUS.BLOCKED, APP_STATUS.FAILED, APP_STATUS.CANCELLED].includes(status)) stats.totals.blocked += 1;
    if (status === APP_STATUS.READY_FOR_SUBMIT) stats.totals.readyForSubmit += 1;
    if (status === APP_STATUS.SUBMIT_UNVERIFIED) stats.totals.submitUnverified += 1;
    if (Number(job.applied) === 1) stats.totals.submittedTotal += 1;

    if (!stats.bySource[source]) {
      stats.bySource[source] = { found: 0, strong: 0, prepared: 0, submitted: 0 };
    }
    stats.bySource[source].found += 1;
    if (fit === 'strong') stats.bySource[source].strong += 1;
    if (job.application_packet_path) stats.bySource[source].prepared += 1;
    if (Number(job.applied) === 1) stats.bySource[source].submitted += 1;

    stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;

    // Section-tab counts via the shared board-view predicates.
    const viewRow = {
      appStatus: status,
      fit,
      grade: gradeFromScore(typeof job.score === 'number' ? job.score : null),
      postedLast24h: isWithinLast24Hours(job.posted_at, now),
      sponsorshipGated: isSponsorshipGated(job),
    };
    for (const [key, pred] of Object.entries(BOARD_VIEWS)) {
      if (pred(viewRow)) stats.views[key] += 1;
    }

    const spon = job.sponsorship ?? 'Unclassified';
    if (!stats.bySponsorship[spon]) stats.bySponsorship[spon] = { count: 0, strong: 0 };
    stats.bySponsorship[spon].count += 1;
    if (fit === 'strong') stats.bySponsorship[spon].strong += 1;

    // Where the jobs actually are. Remote-only and unnamed locations carry no
    // state, and are counted as such rather than guessed at.
    if (!CLOSED_SET.has(status)) {
      const signal = usLocationSignal(job.location);
      const key = signal.state ?? (signal.isUs ? 'US' : 'unknown');
      if (!stats.byState[key]) {
        stats.byState[key] = { count: 0, strong: 0, name: signal.stateName ?? (key === 'US' ? 'Nationwide / remote' : 'Not stated') };
      }
      stats.byState[key].count += 1;
      if (fit === 'strong') stats.byState[key].strong += 1;
    }

    // Daily progress strip.
    const created = dayOf(job.created_at);
    if (daily.has(created)) daily.get(created).discovered += 1;
    const preparedDay = dayOf(preparedAtOf(job));
    if (preparedDay && daily.has(preparedDay)) daily.get(preparedDay).prepared += 1;
    if (Number(job.applied) === 1) {
      const submitted = dayOf(job.applied_at);
      if (daily.has(submitted)) daily.get(submitted).submitted += 1;
    }
  }

  stats.daily = [...daily.values()];
  // "Are we really searching the whole country?" answered with data, not a
  // promise: how many distinct states the open board actually covers.
  const statesSeen = Object.keys(stats.byState).filter((key) => key !== 'US' && key !== 'unknown');
  stats.coverage = {
    statesCovered: statesSeen.length,
    statesPossible: US_STATE_COUNT,
    nationwide: stats.byState.US?.count ?? 0,
    unstated: stats.byState.unknown?.count ?? 0,
  };
  // The untriaged-strong action opens the Best matches view, so it must be
  // COUNTED by that view's predicate. Keeping a second, slightly different
  // predicate here is how the sentence and the board came to disagree.
  stats.nextActions = buildNextActions(stats.totals, stats.views.best);
  return stats;
}

/**
 * Concrete "do this next" guidance, ordered by impact. Each action carries the
 * board filter that shows exactly those jobs.
 * @returns {Array<{ text: string, filter: object|null }>}
 */
export function buildNextActions(totals, strongUntriaged = 0) {
  const actions = [];
  // Unverified auto-submits come first: until confirmed, the job is neither
  // safely "submitted" nor safe to re-fill — only the human can resolve it.
  if (totals.submitUnverified > 0) {
    actions.push({
      text: `${totals.submitUnverified} auto-submit(s) could not be confirmed — check your email for the ATS `
        + 'confirmation, then Mark submitted (or finish manually)',
      filter: { appStatus: APP_STATUS.SUBMIT_UNVERIFIED },
    });
  }
  if (totals.readyForSubmit > 0) {
    actions.push({
      text: `${totals.readyForSubmit} application(s) are filled and waiting — review each browser tab and click Submit yourself`,
      filter: { appStatus: APP_STATUS.READY_FOR_SUBMIT },
    });
  }
  if (totals.pendingReview > 0) {
    actions.push({
      text: `${totals.pendingReview} prepared packet(s) await your approval`,
      filter: { appStatus: APP_STATUS.NEEDS_REVIEW },
    });
  }
  if (totals.blocked > 0) {
    actions.push({
      text: `${totals.blocked} application(s) are blocked (login / CAPTCHA / unanswered questions) and need you`,
      // totals.blocked counts blocked + failed + cancelled, so this must open
      // the "Needs you" VIEW. Filtering on appStatus: blocked alone showed
      // fewer rows than the sentence promised.
      filter: { view: 'blocked' },
    });
  }
  if (strongUntriaged > 0) {
    actions.push({
      text: `${strongUntriaged} strong-fit job(s) have no decision yet — shortlist or reject them`,
      // "No decision yet" is exactly the Best matches view. The old
      // { fit: 'strong' } filter also showed every strong job already
      // shortlisted, prepared, or submitted, so the board returned far more
      // rows than the count.
      filter: { view: 'best' },
    });
  }
  if (totals.needsSponsorshipCheck > 0) {
    actions.push({
      text: `${totals.needsSponsorshipCheck} strong-fit job(s) only need a sponsorship check — verify the employer `
        + 'sponsors H-1B (their careers page, past filings), then shortlist and prepare',
      // The count is isSponsorshipGated(); the board has a filter for exactly
      // that. Matching on sponsorship: 'Unconfirmed' both missed gated rows
      // classified differently and included ungated ones.
      filter: { sponsorshipGated: true },
    });
  }
  if (totals.dateUnconfirmed > 0) {
    actions.push({
      text: `${totals.dateUnconfirmed} job(s) have no confirmed posting date — review them manually`,
      filter: { appStatus: APP_STATUS.DATE_UNCONFIRMED },
    });
  }
  // Only nudge to re-run discovery when nothing has been found in the last 24h.
  // A plain "0 discovered today" right after midnight is normal and not worth a
  // warning (this avoids the confusing "0 discovered today" vs "many posted
  // last 24h" mismatch users saw).
  if ((totals.discoveredLast24h ?? totals.discoveredToday) === 0) {
    actions.push({
      text: 'No new jobs found in the last 24h — run Discover (or Find & Prepare) to refresh the board',
      filter: null,
    });
  }
  return actions;
}

/** Allowed sort keys -> comparators (descending by default where sensible). */
const SORTS = {
  score: (a, b) => (b.score ?? -1) - (a.score ?? -1),
  posted: (a, b) => String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? '')),
  company: (a, b) => String(a.company ?? '').localeCompare(String(b.company ?? '')),
  updated: (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
};

/**
 * Filterable, sortable job list for the board.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [filters]
 * @param {string} [filters.q] free-text match on company/title/location
 * @param {string} [filters.fit] strong|medium|weak|no_fit|unscored
 * @param {string} [filters.appStatus] APP_STATUS value
 * @param {string} [filters.source]
 * @param {string} [filters.sponsorship]
 * @param {string} [filters.employmentType] full_time|contract|contract_to_hire|part_time|unknown
 * @param {number|string} [filters.postedWithinHours] only roles posted in the last 3, 6, or 24 hours
 * @param {boolean} [filters.last24h] legacy alias for postedWithinHours=24
 * @param {boolean} [filters.hideClosed] hide archived/rejected/discarded (default true)
 * @param {string} [filters.sort=score] score|posted|company|updated
 * @param {number} [filters.limit=200]
 * @param {Date} [filters.now]
 * @returns {object[]} decorated board rows
 */
export function listBoardJobs(db, filters = {}) {
  return boardPage(db, filters).jobs;
}

/**
 * Same filters as listBoardJobs, but returns the page WITH the uncapped match
 * count, so the UI can say "Showing 200 of 1,431" instead of silently
 * truncating (the tab badges count ALL matches, so the board must too).
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [filters] see listBoardJobs
 * @returns {{ jobs: object[], total: number, limit: number }}
 */
export function boardPage(db, filters = {}) {
  const now = filters.now ?? new Date();
  const hideClosed = filters.hideClosed !== false && filters.hideClosed !== 'false';

  let rows = allBoardRows(db, now);

  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    rows = rows.filter((r) => [r.company, r.title, r.location]
      .some((v) => String(v ?? '').toLowerCase().includes(q)));
  }
  // Section-tab view: a curated predicate that scopes the board to exactly the
  // jobs counted by that tab's badge. Applied before the other filters.
  if (filters.view && BOARD_VIEWS[filters.view]) {
    rows = rows.filter(BOARD_VIEWS[filters.view]);
  }
  if (filters.fit) rows = rows.filter((r) => r.fit === filters.fit);
  if (filters.appStatus) rows = rows.filter((r) => r.appStatus === filters.appStatus);
  if (filters.source) rows = rows.filter((r) => r.source === filters.source);
  if (filters.sponsorship) rows = rows.filter((r) => r.sponsorship === filters.sponsorship);
  if (filters.employmentType) rows = rows.filter((r) => (r.employmentCategory ?? 'unknown') === filters.employmentType);
  if (filters.ats) rows = rows.filter((r) => (r.atsPlatform ?? 'unknown') === filters.ats);
  if (filters.resumeStatus) rows = rows.filter((r) => r.resumeStatus === filters.resumeStatus);
  if (filters.sponsorshipGated === true || filters.sponsorshipGated === 'true') {
    rows = rows.filter((r) => r.sponsorshipGated);
  }
  // Mirrors stats.totals.qualifiedToday exactly: strong fit whose POSTING is
  // genuinely fresh (posted within the last 24h) — never an old job that
  // merely entered the database today. The default hideClosed pass below
  // supplies the same closed-set exclusion, so clicking the metric always
  // shows precisely the counted records.
  if (filters.qualifiedToday === true || filters.qualifiedToday === 'true') {
    rows = rows.filter((r) => r.fit === 'strong' && r.postedLast24h);
  }
  if (filters.submittedThisWeek === true || filters.submittedThisWeek === 'true') {
    rows = rows.filter((r) => r.appStatus === APP_STATUS.SUBMITTED && r.appliedAt
      && (now.getTime() - new Date(r.appliedAt).getTime()) < 7 * 86_400_000);
  }
  // Jobs held back only because their posting date was unreadable. Closed rows
  // are intentionally in scope: that is precisely where the freshness gate put
  // them, so the filter must reach past the default hide-closed pass.
  if (filters.undated === true || filters.undated === 'true') {
    rows = rows.filter((r) => r.undatedDrop || r.postedConfidence === 'unconfirmed');
  }
  if (filters.remote === true || filters.remote === 'true') rows = rows.filter((r) => r.remote);
  if (filters.last24h === true || filters.last24h === 'true') {
    rows = rows.filter((r) => r.postedLast24h);
  }
  if (filters.postedWithinHours !== undefined && filters.postedWithinHours !== '') {
    const hours = Number(filters.postedWithinHours);
    if ([3, 6, 24].includes(hours)) {
      rows = rows.filter((r) => isWithinLastHours(r.postedAt, hours, now));
    }
  }
  // Hide closed jobs by default — but never override an explicit status/view
  // request (e.g. the Blocked/Submitted tabs, or a "rejected" status filter).
  const undatedRequested = filters.undated === true || filters.undated === 'true';
  if (hideClosed && !filters.appStatus && !filters.view && !undatedRequested) {
    rows = rows.filter((r) => !CLOSED_SET.has(r.appStatus));
  }

  rows.sort(SORTS[filters.sort] ?? SORTS.score);
  const limit = Number(filters.limit) > 0 ? Number(filters.limit) : 200;
  const requestedOffset = Number(filters.offset);
  const requestedPage = Number(filters.page);
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0
    ? Math.floor(requestedOffset)
    : (Number.isFinite(requestedPage) && requestedPage > 1
      ? (Math.floor(requestedPage) - 1) * limit
      : 0);
  const total = rows.length;
  return {
    jobs: rows.slice(offset, offset + limit),
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

/**
 * Full detail for one job: board row + packet summary (blockers, prefill plan,
 * screening answers, uploads) read from the packet JSON when present.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {object} [deps] { readFileImpl, now }
 * @returns {object|null}
 */
export function jobDetail(db, jobId, deps = {}) {
  const job = db.getJob(jobId);
  if (!job) return null;
  const approval = db.getApprovalByJob?.(jobId) ?? null;
  const row = boardRow(job, approval, deps.now ?? new Date());

  let packet = null;
  if (job.application_packet_path) {
    const readImpl = deps.readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
    try {
      const full = JSON.parse(readImpl(job.application_packet_path));
      packet = {
        id: full.id,
        ats: full.ats ?? null,
        blockers: full.blockers ?? [],
        resumeTailored: Boolean(full.resumeTailored),
        resumeWarning: full.resumeWarning ?? null,
        resumePath: full.resumePath ?? null,
        resumePdfPath: full.resumePdfPath ?? null,
        resumePreviewWarning: full.resumePreviewWarning ?? null,
        resumeValidation: full.resumeValidation ?? null,
        tailoring: full.tailoring ?? null,
        llmRequirements: full.tailoring?.llmRequirements ?? null,
        atsReport: full.atsReport ?? null,
        prefillPlan: full.prefill?.plan ?? [],
        needsUser: full.prefill?.needsUser ?? [],
        screeningAnswered: full.screeningPlan?.answered ?? [],
        uploads: full.uploads ?? null,
        stopBeforeSubmit: full.stopBeforeSubmit !== false,
        submitReady: Boolean(full.submitReady),
      };
    } catch (err) {
      packet = { error: `packet unreadable: ${err.message}` };
    }
  }

  // Audit trail: every event the system recorded for this job (newest first).
  let events = [];
  try {
    events = (db.listEvents?.(jobId) ?? [])
      .map((e) => {
        let metadata = e.metadata ?? null;
        if (typeof metadata === 'string') {
          try { metadata = JSON.parse(metadata); } catch { /* keep the original audit text */ }
        }
        return { at: e.created_at, type: e.event_type, message: e.message, metadata };
      })
      .reverse()
      .slice(0, 30);
  } catch { /* events are best-effort */ }

  // Privacy-minimized resumable checkpoint. It contains field identifiers and
  // verification status, never typed answers or absolute upload paths.
  let applicationState = null;
  let applicationStateError = null;
  if (deps.root) {
    const statePath = applicationStatePath(deps.root, {
      id: packet?.id,
      job: { id: job.id, url: job.url },
      ats: { platform: job.ats_platform ?? packet?.ats?.platform },
    });
    const existsImpl = deps.applicationStateExistsImpl ?? existsSync;
    if (statePath && existsImpl(statePath)) {
      try {
        const readState = deps.readApplicationStateImpl ?? ((p) => readFileSync(p, 'utf8'));
        applicationState = JSON.parse(readState(statePath));
      } catch (err) {
        applicationStateError = `application state unreadable: ${err.message}`;
      }
    }
  }

  return { ...row, jdText: job.jd_text ?? null, packet, events, applicationState, applicationStateError };
}

/**
 * Apply a user triage decision from the dashboard.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {'shortlisted'|'rejected'|'archived'|'clear'} decision
 * @returns {{ id: string, userDecision: string|null, appStatus: string }}
 */
export function applyDecision(db, jobId, decision) {
  if (!USER_DECISIONS.includes(decision)) {
    throw httpError(400, `invalid decision "${decision}" (use ${USER_DECISIONS.join('/')})`);
  }
  if (!db.getJob(jobId)) throw httpError(404, `unknown job id: ${jobId}`);
  const value = decision === 'clear' ? null : decision;
  const job = db.setUserDecision(jobId, value);
  const approval = db.getApprovalByJob?.(jobId) ?? null;
  return { id: jobId, userDecision: job.user_decision ?? null, appStatus: deriveAppStatus(job, approval) };
}

/**
 * Approve a job's prepared packet for assisted filling (human action).
 * @returns {{ id: string, approvalId: string, status: string }}
 */
export function approveJobPacket(db, jobId) {
  const approval = db.getApprovalByJob?.(jobId);
  if (!approval) throw httpError(409, `no prepared packet to approve for job ${jobId} — run Prepare first`);
  const r = approve(db, approval.id);
  return { id: jobId, approvalId: approval.id, status: r.status };
}

/**
 * Reject a job's prepared packet (human action).
 * @returns {{ id: string, approvalId: string, status: string }}
 */
export function rejectJobPacket(db, jobId) {
  const approval = db.getApprovalByJob?.(jobId);
  if (!approval) throw httpError(409, `no prepared packet to reject for job ${jobId}`);
  const r = reject(db, approval.id);
  return { id: jobId, approvalId: approval.id, status: r.status };
}

/**
 * Record that the HUMAN manually submitted this application. This is the only
 * path to "submitted" — the system never sets it on its own.
 *
 * Optionally captures a submission record: the ATS confirmation number and a
 * free-text note (e.g. which email the confirmation went to). The note is
 * appended to the job's existing notes with a timestamp, never overwriting.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {object} [details]
 * @param {string} [details.confirmationNumber]
 * @param {boolean} [details.verified] human explicitly saw positive confirmation evidence
 * @param {string} [details.note]
 * @param {Date} [details.now]
 * @returns {{ id: string, appStatus: string, appliedAt: string, confirmationNumber: string|null }}
 */
export function markSubmittedByHuman(db, jobId, details = {}) {
  const job = db.getJob(jobId);
  if (!job) throw httpError(404, `unknown job id: ${jobId}`);
  const appliedAt = (details.now ?? new Date()).toISOString();
  const confirmation = String(details.confirmationNumber ?? '').trim().slice(0, 200) || null;
  const verified = details.verified === true || Boolean(confirmation);

  const patch = verified
    ? { id: jobId, applied: 1, applied_at: appliedAt, status: 'submitted' }
    : { id: jobId, applied: 0, applied_at: null, status: 'submit_unverified' };
  if (confirmation) patch.submitted_confirmation = confirmation;
  const note = String(details.note ?? '').trim().slice(0, 2000);
  if (note) {
    const stamp = appliedAt.slice(0, 16).replace('T', ' ');
    const label = verified ? 'submitted' : 'submission reported — verification pending';
    patch.notes = job.notes ? `${job.notes}\n[${label} ${stamp}] ${note}` : `[${label} ${stamp}] ${note}`;
  }
  db.upsertJob(patch);
  return {
    id: jobId,
    appStatus: verified ? APP_STATUS.SUBMITTED : APP_STATUS.SUBMIT_UNVERIFIED,
    appliedAt: verified ? appliedAt : null,
    reportedAt: appliedAt,
    verified,
    confirmationNumber: confirmation,
  };
}

/**
 * Save (or clear) a free-text note on a job — the human's own reminders that
 * travel with the row and the CSV export. Never touches pipeline state.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {string} note
 * @returns {{ id: string, notes: string }}
 */
export function setJobNote(db, jobId, note) {
  if (!db.getJob(jobId)) throw httpError(404, `unknown job id: ${jobId}`);
  const value = String(note ?? '').slice(0, 4000);
  db.upsertJob({ id: jobId, notes: value });
  return { id: jobId, notes: value };
}

/** A lightweight board row for section lists (omits heavy keyword arrays). */
function sectionRow(row) {
  return {
    id: row.id, company: row.company, title: row.title, location: row.location,
    url: row.url, source: row.source, score: row.score, grade: row.grade,
    fit: row.fit, sponsorship: row.sponsorship, appStatus: row.appStatus,
    postedLabel: row.postedLabel, postedLast24h: row.postedLast24h,
    postedConfidence: row.postedConfidence, atsPlatform: row.atsPlatform,
    resumeStatus: row.resumeStatus, progress: row.progress, remote: row.remote,
    atsScore: row.atsScore, atsBand: row.atsBand,
    compensation: row.compensation, sponsorshipGated: row.sponsorshipGated,
    employmentCategory: row.employmentCategory, employmentLabel: row.employmentLabel,
    appliedAt: row.appliedAt,
  };
}

/** Extract the human-meaningful reason a blocked job stopped. */
function blockerReason(row) {
  const first = (row.assistBlockers ?? [])[0];
  if (!first) return 'Unknown — open it to see why';
  const b = String(first).toLowerCase();
  if (b.includes('captcha')) return 'CAPTCHA / bot wall';
  if (b.includes('login') || b.includes('sign in') || b.includes('account')) return 'Login / account required';
  if (b.includes('mfa') || b.includes('verification')) return 'MFA / verification';
  if (b.includes('screening') || b.includes('needs user') || b.includes('required field')) return 'Question needs your answer';
  if (b.includes('navigation') || b.includes('could not start') || b.includes('no application url')) return 'Page / navigation problem';
  if (b.includes('resume') || b.includes('upload')) return 'Resume upload problem';
  return String(first).slice(0, 80);
}

/**
 * Curated, action-oriented sections for the redesigned command center. Each
 * section is a small, sorted list of lightweight rows the UI renders as a card.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.limit=8] max rows per list section
 * @returns {{
 *   todaysPriorities: object[], bestMatches: object[], needsReview: object[],
 *   readyForSubmit: object[], recentlySubmitted: object[],
 *   blockedByReason: Array<{reason:string,count:number,jobs:object[]}>,
 *   counts: object
 * }}
 */
export function dashboardSections(db, { now = new Date(), limit = 8 } = {}) {
  const rows = allBoardRows(db, now);
  const byScore = (a, b) => (b.score ?? -1) - (a.score ?? -1);
  const is = (r, ...statuses) => statuses.includes(r.appStatus);

  const readyForSubmit = rows.filter((r) => is(r, APP_STATUS.READY_FOR_SUBMIT, APP_STATUS.APPROVED)).sort(byScore);
  const needsReview = rows.filter((r) => is(r, APP_STATUS.NEEDS_REVIEW)).sort(byScore);
  const blocked = rows.filter((r) => is(r, APP_STATUS.BLOCKED, APP_STATUS.FAILED, APP_STATUS.CANCELLED)).sort(byScore);
  const submitUnverified = rows.filter((r) => is(r, APP_STATUS.SUBMIT_UNVERIFIED)).sort(byScore);
  const submitted = rows.filter((r) => is(r, APP_STATUS.SUBMITTED))
    .sort((a, b) => String(b.appliedAt ?? '').localeCompare(String(a.appliedAt ?? '')));

  // Today's queue follows the user's actual workflow. A strong match only
  // earns the "new" slot when the posting itself is confirmed within 24h;
  // discovering an old posting today never relabels it as new.
  const readyForUserSubmission = rows
    .filter((r) => is(r, APP_STATUS.READY_FOR_SUBMIT)).sort(byScore);
  const strongNew = rows
    .filter((r) => r.postedLast24h && r.postedConfidence === 'confirmed'
      && r.fit === 'strong' && is(r, APP_STATUS.SCORED, APP_STATUS.DISCOVERED))
    .sort(byScore);
  const sponsorshipVerification = rows
    .filter((r) => r.sponsorshipGated && !CLOSED_SET.has(r.appStatus)).sort(byScore);

  const priorityAll = [];
  const seenPriority = new Set();
  const addPriority = (items, kind) => {
    for (const row of items) {
      if (seenPriority.has(row.id)) continue;
      seenPriority.add(row.id);
      priorityAll.push({ ...sectionRow(row), priorityKind: kind });
    }
  };
  addPriority(readyForUserSubmission, 'ready_for_submission');
  addPriority(submitUnverified, 'submission_unverified');
  addPriority(blocked, 'blocked');
  addPriority(needsReview, 'prepared_review');
  addPriority(strongNew, 'strong_new');
  addPriority(sponsorshipVerification, 'verify_sponsorship');
  const todaysPriorities = priorityAll.slice(0, limit);

  // Best matches: strong, recommended, still actionable (not closed/submitted).
  const closed = [APP_STATUS.REJECTED, APP_STATUS.ARCHIVED, APP_STATUS.DISCARDED, APP_STATUS.SUBMITTED];
  const bestMatches = rows
    .filter((r) => r.fit === 'strong' && r.grade?.recommend && !closed.includes(r.appStatus))
    .sort(byScore).slice(0, limit).map(sectionRow);

  // Blocked, grouped by reason so you can fix similar walls in one pass.
  const reasonMap = new Map();
  for (const r of blocked) {
    const reason = blockerReason(r);
    if (!reasonMap.has(reason)) reasonMap.set(reason, []);
    reasonMap.get(reason).push(sectionRow(r));
  }
  const blockedByReason = [...reasonMap.entries()]
    .map(([reason, jobs]) => ({ reason, count: jobs.length, jobs: jobs.slice(0, limit) }))
    .sort((a, b) => b.count - a.count);

  return {
    todaysPriorities,
    strongNew: strongNew.slice(0, limit).map(sectionRow),
    sponsorshipVerification: sponsorshipVerification.slice(0, limit).map(sectionRow),
    bestMatches,
    needsReview: needsReview.slice(0, limit).map(sectionRow),
    readyForSubmit: readyForSubmit.slice(0, limit).map(sectionRow),
    recentlySubmitted: submitted.slice(0, limit).map(sectionRow),
    blockedByReason,
    counts: {
      todaysPriorities: priorityAll.length,
      strongNew: strongNew.length,
      sponsorshipVerification: sponsorshipVerification.length,
      bestMatches: rows.filter((r) => r.fit === 'strong' && r.grade?.recommend && !closed.includes(r.appStatus)).length,
      needsReview: needsReview.length,
      readyForSubmit: readyForSubmit.length,
      recentlySubmitted: submitted.length,
      blocked: blocked.length,
    },
  };
}

/** Columns for the rich CSV/spreadsheet export, in order. */
export const EXPORT_COLUMNS = Object.freeze([
  ['company', 'Company'], ['title', 'Role'], ['location', 'Location'],
  ['remote', 'Remote'], ['source', 'Source'], ['score', 'Score'],
  ['grade', 'Grade'], ['fit', 'Fit'], ['tier', 'Tier'],
  ['sponsorship', 'Sponsorship'], ['postedLabel', 'Posted'],
  ['postedConfidence', 'Posted confidence'], ['appStatus', 'Status'],
  ['stage', 'Pipeline stage'], ['resumeStatus', 'Resume'],
  ['atsPlatform', 'ATS'], ['matched', 'Matched skills'], ['missing', 'Missing skills'],
  ['blockers', 'Blockers'], ['notes', 'Notes'], ['url', 'URL'],
  ['appliedAt', 'Submitted at'], ['createdAt', 'Discovered at'], ['updatedAt', 'Last updated'],
]);

/**
 * Build flat export records (one per job) with every detail the user asked to
 * export: score, grade, sponsorship confidence, resume status, form-fill /
 * blocker status, submission status, and notes.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options] { now, includeClosed }
 * @returns {object[]}
 */
export function buildExportRows(db, { now = new Date(), includeClosed = true } = {}) {
  let rows = allBoardRows(db, now);
  if (!includeClosed) {
    const closed = [APP_STATUS.ARCHIVED, APP_STATUS.DISCARDED];
    rows = rows.filter((r) => !closed.includes(r.appStatus));
  }
  rows.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  return rows.map((r) => ({
    company: r.company ?? '',
    title: r.title ?? '',
    location: r.location ?? '',
    remote: r.remote ? 'yes' : 'no',
    source: r.source ?? '',
    score: r.score ?? '',
    grade: r.grade?.letter ?? '',
    fit: r.fit ?? '',
    tier: r.tier ?? '',
    sponsorship: r.sponsorship ?? '',
    postedLabel: r.postedLabel ?? '',
    postedConfidence: r.postedConfidence ?? '',
    appStatus: r.appStatus ?? '',
    stage: r.progress?.stage ?? '',
    resumeStatus: r.resumeStatus ?? '',
    atsPlatform: r.atsPlatform ?? '',
    matched: (r.matchedKeywords ?? []).join('; '),
    missing: (r.missingKeywords ?? []).join('; '),
    blockers: (r.assistBlockers ?? []).join('; '),
    notes: r.notes ?? '',
    url: r.url ?? '',
    appliedAt: r.appliedAt ?? '',
    createdAt: r.createdAt ?? '',
    updatedAt: r.updatedAt ?? '',
  }));
}

/** Escape one CSV cell (RFC-4180: quote when it contains comma/quote/newline). */
function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize export rows to a CSV string with a human-friendly header row.
 * @param {object[]} rows from buildExportRows()
 * @returns {string}
 */
export function exportRowsToCsv(rows = []) {
  const header = EXPORT_COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const body = rows.map((r) => EXPORT_COLUMNS.map(([key]) => csvCell(r[key])).join(',')).join('\r\n');
  return body ? `${header}\r\n${body}\r\n` : `${header}\r\n`;
}

/* ───────────────────────────── reports ───────────────────────────── */

/** Compact row for report lists (what a reviewer needs, nothing more). */
function reportRow(r) {
  return {
    id: r.id, company: r.company, title: r.title, url: r.url, source: r.source,
    score: r.score, grade: r.grade, sponsorship: r.sponsorship,
    appStatus: r.appStatus, postedLabel: r.postedLabel,
    appliedAt: r.appliedAt, confirmation: r.submittedConfirmation,
    blockers: r.assistBlockers ?? [], notes: r.notes ?? '',
  };
}

/**
 * Build the view-first reports bundle for the Reports drawer: read it on
 * screen FIRST, then export. All sections derive from the same board rows so
 * the numbers always reconcile with the table and tiles.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {Date} [options.now]
 * @returns {object} { generatedAt, dailySummary, applicationLog, preparedPackets,
 *                     blockedJobs, skippedJobs, sponsorshipSummary, sourcePerformance }
 */
export function buildReports(db, { now = new Date() } = {}) {
  const stats = dashboardStats(db, { now });
  const rows = listBoardJobs(db, { now, hideClosed: false, limit: 100000 });

  const byStatus = (status) => rows.filter((r) => r.appStatus === status).map(reportRow);

  // Application log: every job the human acted on (or that stopped), newest first.
  const LOG_STATUSES = new Set([
    APP_STATUS.SUBMITTED, APP_STATUS.SUBMIT_UNVERIFIED, APP_STATUS.SKIPPED,
    APP_STATUS.BLOCKED, APP_STATUS.REJECTED, APP_STATUS.ARCHIVED,
    APP_STATUS.READY_FOR_SUBMIT,
  ]);
  const applicationLog = rows
    .filter((r) => LOG_STATUSES.has(r.appStatus))
    .sort((a, b) => String(b.appliedAt ?? b.updatedAt ?? '')
      .localeCompare(String(a.appliedAt ?? a.updatedAt ?? '')))
    .map(reportRow);

  const sponsorshipSummary = Object.entries(stats.bySponsorship)
    .map(([confidence, v]) => ({ confidence, jobs: v.count, strongFit: v.strong }))
    .sort((a, b) => b.jobs - a.jobs);

  const sourcePerformance = Object.entries(stats.bySource)
    .map(([source, v]) => ({
      source, found: v.found, strong: v.strong, prepared: v.prepared, submitted: v.submitted,
      // Conversion: how much of what a source finds is actually worth acting on.
      strongRate: v.found ? Math.round((v.strong / v.found) * 100) : 0,
    }))
    .sort((a, b) => b.found - a.found);

  return {
    generatedAt: now.toISOString(),
    dailySummary: { totals: stats.totals, daily: stats.daily },
    applicationLog,
    preparedPackets: byStatus(APP_STATUS.NEEDS_REVIEW)
      .concat(byStatus(APP_STATUS.APPROVED)),
    blockedJobs: byStatus(APP_STATUS.BLOCKED),
    skippedJobs: byStatus(APP_STATUS.SKIPPED),
    sponsorshipSummary,
    sourcePerformance,
  };
}

/**
 * Documents view: the master resume plus every tailored resume / cover letter
 * the agent generated, newest first. This is the resume "version history" —
 * one tailored version per prepared job, each traceable to its job and packet.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options] { root, now, statImpl }
 * @returns {{ master: object|null, tailored: object[] }}
 */
export function buildDocuments(db, {
  root = null, now = new Date(), statImpl = null, readFileImpl = null,
} = {}) {
  const stat = statImpl ?? ((p) => {
    try {
      const s = statSync(p);
      return { exists: true, bytes: s.size, modifiedAt: s.mtime.toISOString() };
    } catch { return { exists: false, bytes: 0, modifiedAt: null }; }
  });

  let master = null;
  if (root) {
    const masterPath = join(root, 'resumes', 'base', 'MASTER_RESUME.docx');
    master = { path: masterPath, ...stat(masterPath) };
  }

  const approvals = approvalsByJob(db);
  const readPacket = readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
  const fileInfo = (path) => (path ? { path, ...stat(path) } : null);
  const rows = listSummaryRows(db)
    .filter((j) => j.resume_docx_path || j.resume_path || j.resume_pdf_path
      || j.cover_letter_path || j.application_packet_path)
    .map((j) => {
      let packet = null;
      let packetError = null;
      if (j.application_packet_path) {
        try { packet = JSON.parse(readPacket(j.application_packet_path)); }
        catch (err) { packetError = `packet unreadable: ${err.message}`; }
      }
      const resumeDocx = j.resume_docx_path ?? j.resume_path ?? null;
      const tailoring = packet?.tailoring ?? null;
      const changes = Array.isArray(tailoring?.changes) ? tailoring.changes : [];
      const gaps = Array.isArray(tailoring?.gaps) ? tailoring.gaps : [];
      return {
        jobId: j.id,
        company: j.company,
        title: j.title,
        preparedAt: preparedAtOf(j),
        tailored: packet ? Boolean(packet.resumeTailored) : Boolean(resumeDocx),
        resumeDocx,
        resumePdf: j.resume_pdf_path ?? null,
        coverLetter: j.cover_letter_path ?? null,
        packet: j.application_packet_path ?? null,
        folder: j.output_folder_path ?? null,
        files: {
          resumeDocx: fileInfo(resumeDocx),
          resumePdf: fileInfo(j.resume_pdf_path),
          coverLetter: fileInfo(j.cover_letter_path),
          packet: fileInfo(j.application_packet_path),
        },
        atsScore: j.ats_score == null || j.ats_score === '' ? null : Number(j.ats_score),
        atsBand: j.ats_band ?? null,
        appStatus: deriveAppStatus(j, approvals.get(j.id) ?? null),
        resumeWarning: packet?.resumeWarning ?? null,
        tailoring: tailoring ? {
          changes,
          gaps,
          summaryLine: tailoring.summaryLine ?? null,
          changeCount: changes.length,
          gapCount: gaps.length,
          pageCount: tailoring.pageCount ?? null,
          estimatedPages: tailoring.estimatedPages ?? null,
        } : null,
        provenance: packet ? {
          packetId: packet.id ?? null,
          packetCreatedAt: packet.createdAt ?? null,
          stopBeforeSubmit: packet.stopBeforeSubmit !== false,
          source: 'application packet',
        } : null,
        packetError,
      };
    })
    .sort((a, b) => String(b.preparedAt ?? '').localeCompare(String(a.preparedAt ?? '')));

  return { generatedAt: now.toISOString(), master, tailored: rows };
}

/** Where the master resume lives, and where replaced copies are kept. */
export const MASTER_RESUME_RELATIVE = join('resumes', 'base', 'MASTER_RESUME.docx');
export const MASTER_HISTORY_RELATIVE = join('resumes', 'base', 'history');

/**
 * Everything the master-resume screen needs: the file's metadata, its readable
 * text (so the user can VERIFY the document tailoring reads, not just its
 * filename), previous versions kept when it was replaced, and how many already
 * tailored resumes predate the current master and are therefore stale.
 *
 * Never throws: a missing/unreadable master is a normal first-run state and the
 * screen has to explain it rather than 500.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} [options]
 * @param {string|null} [options.root] workspace root (null -> unavailable)
 * @param {Date} [options.now]
 * @param {Function} [options.readFileImpl] (path) => Buffer
 * @param {Function} [options.statImpl] (path) => { exists, bytes, modifiedAt }
 * @param {Function} [options.listDirImpl] (path) => string[]
 * @param {number} [options.previewParagraphs] cap on returned paragraphs
 * @returns {object}
 */
export function buildMasterResume(db, {
  root = null, now = new Date(), readFileImpl = null, statImpl = null,
  listDirImpl = null, previewParagraphs = 400,
} = {}) {
  const stat = statImpl ?? ((p) => {
    try {
      const s = statSync(p);
      return { exists: s.isFile(), bytes: s.size, modifiedAt: s.mtime.toISOString() };
    } catch { return { exists: false, bytes: 0, modifiedAt: null }; }
  });
  if (!root) {
    return {
      generatedAt: now.toISOString(),
      available: false,
      reason: 'no workspace root is configured, so the master resume cannot be located',
      exists: false, path: null, relativePath: MASTER_RESUME_RELATIVE,
      bytes: 0, modifiedAt: null, wordCount: null, paragraphCount: null,
      paragraphs: [], truncated: false, textError: null, backups: [], stalePackets: 0,
    };
  }

  const path = join(root, MASTER_RESUME_RELATIVE);
  const info = stat(path);
  let paragraphs = [];
  let wordCount = null;
  let truncated = false;
  let textError = null;
  if (info.exists) {
    try {
      const read = readFileImpl ?? ((p) => readFileSync(p));
      const extracted = extractDocxText(read(path));
      wordCount = extracted.wordCount;
      truncated = extracted.paragraphs.length > previewParagraphs;
      paragraphs = extracted.paragraphs.slice(0, previewParagraphs);
    } catch (err) {
      // A present-but-unreadable master is exactly the case worth surfacing:
      // tailoring will fall back to it verbatim and the user needs to know.
      textError = err.message;
    }
  }

  const listDir = listDirImpl ?? ((p) => {
    try { return readdirSync(p); } catch { return []; }
  });
  const historyDir = join(root, MASTER_HISTORY_RELATIVE);
  const backups = listDir(historyDir)
    .filter((name) => /^MASTER_RESUME\..+\.docx$/i.test(name))
    .map((name) => ({ name, ...stat(join(historyDir, name)) }))
    .filter((b) => b.exists)
    .sort((a, b) => String(b.modifiedAt ?? '').localeCompare(String(a.modifiedAt ?? '')));

  // Tailored resumes generated BEFORE the current master no longer reflect it.
  const stalePackets = info.modifiedAt
    ? listSummaryRows(db).filter((j) => {
      const preparedAt = preparedAtOf(j);
      return (j.resume_docx_path || j.resume_path) && preparedAt
        && preparedAt < info.modifiedAt;
    }).length
    : 0;

  return {
    generatedAt: now.toISOString(),
    available: true,
    reason: null,
    path,
    relativePath: MASTER_RESUME_RELATIVE,
    exists: info.exists,
    bytes: info.bytes,
    modifiedAt: info.modifiedAt,
    wordCount,
    paragraphCount: paragraphs.length,
    paragraphs,
    truncated,
    textError,
    backups,
    stalePackets,
  };
}
