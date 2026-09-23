/**
 * The board's status vocabulary, and the rules that derive it from a row.
 *
 * WHY THIS IS ITS OWN MODULE. These rules lived in src/dashboard/data.js, so
 * everything that needed to say what state a job was in — the spreadsheet
 * tracker, the reports, the CLI — had to import the whole dashboard data layer
 * (and its fs/zlib/SQLite dependencies) to answer a question about one row.
 * They are pure functions of a row, so they now live here with no I/O at all;
 * data.js re-exports them so no existing import site changes.
 */

import { APPROVAL_STATUS } from '../apply/approvalQueue.js';
import { isSponsorshipGated } from '../scoring/explainScore.js';

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
  NEEDS_DESCRIPTION: 'needs_description', // found, but the JD was never fetched — NOT judged
  SCORED: 'scored',                // scored, no action yet
  DISCOVERED: 'discovered',        // found, not yet scored
});

/**
 * Every lifecycle status this presentation layer knows how to render.
 *
 * `deriveAppStatus` used to be a chain of `if`s with a fallthrough, which is
 * why a status could be introduced by one writer and silently mishandled here:
 * a row whose status nothing matched simply fell through to SCORED. That is
 * exactly how 4,732 rows the pipeline had deliberately marked unread came to be
 * reported as judged — and how `hard_discarded`, which THIS map has always
 * called DISCARDED, still rendered as "Scored" because the if-chain never
 * mentioned it.
 *
 * The function below now switches over this map, so the map is no longer
 * documentation that can drift from the code: it IS the pipeline half of the
 * code. A test asserts exhaustiveness over LIFECYCLE_VALUES.
 *
 * A status maps to `null` when it is deliberately not a distinct board status
 * (it is represented by approval/user-decision precedence instead).
 */
export const LIFECYCLE_TO_APP_STATUS = Object.freeze({
  found: APP_STATUS.DISCOVERED,
  hard_discarded: APP_STATUS.DISCARDED,
  discarded: APP_STATUS.DISCARDED,
  needs_description: APP_STATUS.NEEDS_DESCRIPTION,
  unknown_date_review: APP_STATUS.DATE_UNCONFIRMED,
  scored: APP_STATUS.SCORED,
  near_miss: APP_STATUS.SCORED,
  queued: APP_STATUS.SCORED,
  prepared: APP_STATUS.NEEDS_REVIEW,
  assist_started: APP_STATUS.APPROVED,
  assist_blocked: APP_STATUS.BLOCKED,
  ready_for_submit: APP_STATUS.READY_FOR_SUBMIT,
  submit_unverified: APP_STATUS.SUBMIT_UNVERIFIED,
  submitted: APP_STATUS.SUBMITTED,
  skipped: APP_STATUS.SKIPPED,
  cancelled: APP_STATUS.CANCELLED,
  failed: APP_STATUS.FAILED,
});

/**
 * Lifecycle statuses that OUT-RANK the approval queue and the shortlist: an
 * assist outcome is newer information than "the packet was approved", so a
 * blocked fill must read Blocked even though its approval row says approved.
 */
const ASSIST_OUTCOMES = new Set([
  'skipped', 'assist_blocked', 'failed', 'cancelled', 'submit_unverified', 'ready_for_submit',
]);

/**
 * Pipeline verdicts that stand on their own once no approval row or shortlist
 * out-ranks them. Every OTHER lifecycle status (found / scored / near_miss /
 * queued, and a `prepared` / `assist_started` row that lost its approval row)
 * is judged by whether a score exists — the historical rendering, kept so the
 * board's counts move only where they were wrong.
 */
const PIPELINE_VERDICTS = new Set([
  'unknown_date_review', 'discarded', 'hard_discarded',
  // Written by the pipeline for rows whose JD was never fetched, precisely so
  // they are NOT reported as judged. Their provisional score is not a verdict.
  'needs_description',
]);

/**
 * Derive the single board status for a job + its latest approval row.
 * Precedence: actual submission > user archive/reject > assist outcomes >
 * approval state > user shortlist > pipeline state.
 *
 * The status half is a lookup in LIFECYCLE_TO_APP_STATUS rather than a second,
 * hand-maintained list of `if`s — see the note on that map.
 *
 * @param {object} job jobs-table row
 * @param {object|null} approval latest approval_queue row
 * @returns {string} an APP_STATUS value
 */
export function deriveAppStatus(job = {}, approval = null) {
  if (Number(job.applied) === 1) return APP_STATUS.SUBMITTED;
  if (job.user_decision === 'archived') return APP_STATUS.ARCHIVED;
  if (job.user_decision === 'rejected') return APP_STATUS.REJECTED;

  const status = job.status ?? null;
  if (ASSIST_OUTCOMES.has(status)) return LIFECYCLE_TO_APP_STATUS[status];

  if (approval?.approval_status === APPROVAL_STATUS.REJECTED) return APP_STATUS.REJECTED;
  if (approval?.approval_status === APPROVAL_STATUS.APPROVED) return APP_STATUS.APPROVED;
  if (approval?.approval_status === APPROVAL_STATUS.PENDING) return APP_STATUS.NEEDS_REVIEW;
  if (job.user_decision === 'shortlisted') return APP_STATUS.SHORTLISTED;

  if (PIPELINE_VERDICTS.has(status)) return LIFECYCLE_TO_APP_STATUS[status];
  // Everything else is judged by whether a score exists. That includes
  // `submitted` WITHOUT applied=1: `applied` is the column that makes a
  // submission true, so such a row never claims a submission it cannot prove.
  if (typeof job.score === 'number' || job.tier) return APP_STATUS.SCORED;
  return APP_STATUS.DISCOVERED;
}

/**
 * Human label per board status — the one the board, the tracker and the
 * /api/today queue all show, so a status never reads two ways.
 */
export const APP_STATUS_LABELS = Object.freeze({
  [APP_STATUS.SUBMITTED]: 'Submitted',
  [APP_STATUS.ARCHIVED]: 'Archived',
  [APP_STATUS.REJECTED]: 'Rejected',
  [APP_STATUS.SKIPPED]: 'Skipped',
  [APP_STATUS.BLOCKED]: 'Needs your help',
  [APP_STATUS.FAILED]: 'Retry needed',
  [APP_STATUS.CANCELLED]: 'Paused',
  [APP_STATUS.SUBMIT_UNVERIFIED]: 'Verify submission',
  [APP_STATUS.READY_FOR_SUBMIT]: 'Ready for your review',
  [APP_STATUS.APPROVED]: 'Ready to auto-fill',
  [APP_STATUS.NEEDS_REVIEW]: 'Review resume',
  [APP_STATUS.SHORTLISTED]: 'Shortlisted',
  [APP_STATUS.DATE_UNCONFIRMED]: 'Date unconfirmed',
  [APP_STATUS.DISCARDED]: 'Filtered out',
  [APP_STATUS.NEEDS_DESCRIPTION]: 'Description not fetched',
  [APP_STATUS.SCORED]: 'Scored',
  [APP_STATUS.DISCOVERED]: 'Found',
});

/**
 * Map a scoring tier to a fit bucket.
 *
 * FIT measures how well the ROLE matches the candidate; sponsorship
 * feasibility is reported separately. A 75+ job the sponsorship gate parked
 * in Queue is therefore still a STRONG fit (with sponsorshipGated: true and a
 * "verify sponsorship" action) — hiding those as "medium" made 10k-job sources
 * read as producing zero strong matches.
 *
 * The gate flag is only a PROXY for "this Queue row really scored Apply" — and
 * that proxy does not hold for a row whose sponsorship is `Denied`: such a row
 * was not parked pending verification, it was refused outright. Passing
 * sponsorship through keeps a refused job out of "Best matches".
 *
 * @param {string|null} tier
 * @param {number|null} [score] pass the job's score to classify gated rows
 * @param {string|null} [sponsorship] pass the job's sponsorship status
 * @returns {'strong'|'medium'|'weak'|'no_fit'|'unscored'}
 */
export function fitBucket(tier, score = null, sponsorship = null) {
  if (tier === 'Priority' || tier === 'Apply') return 'strong';
  if (tier === 'Queue') return isSponsorshipGated({ tier, score, sponsorship }) ? 'strong' : 'medium';
  if (tier === 'Near miss') return 'weak';
  if (tier === 'Discard') return 'no_fit';
  return 'unscored';
}

/**
 * ONE vocabulary for "how good a fit is this", shared by the grade label and
 * the fit chip.
 *
 * The grade letter is a SCORE band and the fit bucket is a TIER, and the two
 * were labelled independently: measured on the live board, 33 of the top 100
 * rows read "D · Weak fit" right next to a "medium fit" chip, because the tier
 * thresholds (with sponsorship and profile adjustments) put a 55-64 score in
 * Queue while the letter scale called anything under 65 weak. Two words for
 * one question, disagreeing on a third of the screen.
 *
 * The letter stays a pure function of the score (it is what people sort and
 * compare by), but the WORDS now come from the fit bucket whenever one is
 * known. The label can therefore never contradict the chip beside it.
 */
export const FIT_LABELS = Object.freeze({
  strong: 'Strong fit',
  medium: 'Possible fit',
  weak: 'Weak fit',
  no_fit: 'Poor fit',
});

/** Score band -> letter + the label used when no fit bucket is known. */
const SCORE_BANDS = Object.freeze([
  { min: 85, letter: 'A', label: 'Excellent fit', recommend: true },
  { min: 75, letter: 'B', label: 'Strong fit', recommend: true },
  { min: 65, letter: 'C', label: 'Possible fit', recommend: true },
  { min: 50, letter: 'D', label: 'Weak fit', recommend: false },
  { min: -Infinity, letter: 'F', label: 'Poor fit', recommend: false },
]);

/**
 * Letter grade for a 0-100 score — a compact, career-ops-style signal of how
 * worth-your-time a role is. The system is a FILTER, not spray-and-pray: grades
 * D/F are de-emphasized in the UI so you focus on the few A/B roles.
 *
 * @param {number|null} score
 * @param {string|null} [fit] the row's fitBucket; when given (and scored), the
 *   label is taken from FIT_LABELS so grade and fit chip always agree
 * @returns {{ letter: string, label: string, recommend: boolean }|null}
 */
export function gradeFromScore(score, fit = null) {
  if (typeof score !== 'number' || Number.isNaN(score)) return null;
  const band = SCORE_BANDS.find((b) => score >= b.min);
  const fitLabel = fit ? FIT_LABELS[fit] : undefined;
  if (!fitLabel) return { letter: band.letter, label: band.label, recommend: band.recommend };
  // "Excellent" is a strong fit that ALSO scored in the top band — a
  // refinement of the fit word, never a contradiction of it.
  const label = fit === 'strong' && band.letter === 'A' ? 'Excellent fit' : fitLabel;
  return { letter: band.letter, label, recommend: band.recommend };
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
