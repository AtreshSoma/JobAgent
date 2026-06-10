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
 *     "submitted" when the human actually submitted it (jobs.applied = 1).
 *   - fitBucket: strong / medium / weak / no_fit, derived from the scoring tier.
 *   - whyFit: the stored score explanation + matched/missing keywords, so the
 *     UI can show exactly WHY a job ranked where it did.
 */

import { readFileSync } from 'node:fs';

import { APPROVAL_STATUS, approve, reject } from '../apply/approvalQueue.js';
import { isWithinLast24Hours, formatPostedRelative } from '../utils/dates.js';

/** Derived application statuses shown on the board (ordered by precedence). */
export const APP_STATUS = Object.freeze({
  SUBMITTED: 'submitted',          // human clicked Submit (applied = 1)
  ARCHIVED: 'archived',            // user archived it
  REJECTED: 'rejected',            // user rejected it (or rejected the packet)
  BLOCKED: 'blocked',              // assist hit login/captcha/unknown fields
  READY_FOR_SUBMIT: 'ready_for_submit', // form filled; awaiting the human's click
  APPROVED: 'approved',            // packet approved; ready for assisted fill
  NEEDS_REVIEW: 'needs_review',    // packet prepared; awaiting human approval
  SHORTLISTED: 'shortlisted',      // user shortlisted; not yet prepared/approved
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
  if (job.status === 'assist_blocked') return APP_STATUS.BLOCKED;
  if (job.status === 'ready_for_submit') return APP_STATUS.READY_FOR_SUBMIT;
  if (approval?.approval_status === APPROVAL_STATUS.REJECTED) return APP_STATUS.REJECTED;
  if (approval?.approval_status === APPROVAL_STATUS.APPROVED) return APP_STATUS.APPROVED;
  if (approval?.approval_status === APPROVAL_STATUS.PENDING) return APP_STATUS.NEEDS_REVIEW;
  if (job.user_decision === 'shortlisted') return APP_STATUS.SHORTLISTED;
  if (job.status === 'discarded' || job.status === 'unknown_date_review') return APP_STATUS.DISCARDED;
  if (typeof job.score === 'number' || job.tier) return APP_STATUS.SCORED;
  return APP_STATUS.DISCOVERED;
}

/**
 * Map a scoring tier to a fit bucket.
 * @param {string|null} tier
 * @returns {'strong'|'medium'|'weak'|'no_fit'|'unscored'}
 */
export function fitBucket(tier) {
  if (tier === 'Priority' || tier === 'Apply') return 'strong';
  if (tier === 'Queue') return 'medium';
  if (tier === 'Near miss') return 'weak';
  if (tier === 'Discard') return 'no_fit';
  return 'unscored';
}

/** An Error carrying the HTTP status the server should reply with. */
function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/** Parse a TEXT column that may hold a JSON array. */
function jsonList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

/** Latest approval row per job id. */
function approvalsByJob(db) {
  const map = new Map();
  for (const a of db.listApprovals()) map.set(a.job_id, a); // created_at ASC -> later rows win
  return map;
}

/** ISO date prefix (YYYY-MM-DD) of a date. */
function dayOf(value) {
  return String(value ?? '').slice(0, 10);
}

/** Decorate one db row with all derived board fields. */
function boardRow(job, approval, now) {
  const matched = jsonList(job.matched_keywords);
  const missing = jsonList(job.missing_keywords);
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    url: job.url,
    source: job.source || 'unknown',
    score: typeof job.score === 'number' ? job.score : null,
    tier: job.tier ?? null,
    fit: fitBucket(job.tier),
    sponsorship: job.sponsorship ?? null,
    postedAt: job.posted_at ?? null,
    postedLabel: formatPostedRelative(job.posted_at, now),
    postedLast24h: isWithinLast24Hours(job.posted_at, now),
    appStatus: deriveAppStatus(job, approval),
    userDecision: job.user_decision ?? null,
    atsPlatform: job.ats_platform ?? null,
    explanation: job.explanation ?? null,
    discardReason: job.discard_reason ?? null,
    matchedKeywords: matched,
    missingKeywords: missing,
    approvalId: approval?.id ?? null,
    approvalStatus: approval?.approval_status ?? null,
    packetPath: job.application_packet_path ?? null,
    resumePath: job.resume_path ?? null,
    coverLetterPath: job.cover_letter_path ?? null,
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
  const jobs = db.listJobs({});
  const approvals = approvalsByJob(db);
  const today = dayOf(now.toISOString());

  const stats = {
    generatedAt: now.toISOString(),
    totals: {
      jobsTracked: jobs.length,
      discoveredToday: 0,
      postedLast24h: 0,
      strongFit: 0,
      mediumFit: 0,
      weakFit: 0,
      shortlisted: 0,
      rejected: 0,
      preparedToday: 0,
      submittedToday: 0,
      pendingReview: 0,
      blocked: 0,
      readyForSubmit: 0,
      submittedTotal: 0,
    },
    bySource: {},
    byStatus: {},
  };

  for (const job of jobs) {
    const approval = approvals.get(job.id) ?? null;
    const status = deriveAppStatus(job, approval);
    const fit = fitBucket(job.tier);
    const source = job.source || 'unknown';

    if (dayOf(job.created_at) === today) stats.totals.discoveredToday += 1;
    if (isWithinLast24Hours(job.posted_at, now)) stats.totals.postedLast24h += 1;
    if (fit === 'strong') stats.totals.strongFit += 1;
    if (fit === 'medium') stats.totals.mediumFit += 1;
    if (fit === 'weak') stats.totals.weakFit += 1;
    if (job.user_decision === 'shortlisted') stats.totals.shortlisted += 1;
    if (status === APP_STATUS.REJECTED) stats.totals.rejected += 1;
    if (job.application_packet_path && dayOf(job.updated_at) === today
        && Number(job.applied) !== 1) stats.totals.preparedToday += 1;
    if (Number(job.applied) === 1 && dayOf(job.applied_at) === today) stats.totals.submittedToday += 1;
    if (status === APP_STATUS.NEEDS_REVIEW) stats.totals.pendingReview += 1;
    if (status === APP_STATUS.BLOCKED) stats.totals.blocked += 1;
    if (status === APP_STATUS.READY_FOR_SUBMIT) stats.totals.readyForSubmit += 1;
    if (Number(job.applied) === 1) stats.totals.submittedTotal += 1;

    if (!stats.bySource[source]) {
      stats.bySource[source] = { found: 0, strong: 0, prepared: 0, submitted: 0 };
    }
    stats.bySource[source].found += 1;
    if (fit === 'strong') stats.bySource[source].strong += 1;
    if (job.application_packet_path) stats.bySource[source].prepared += 1;
    if (Number(job.applied) === 1) stats.bySource[source].submitted += 1;

    stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;
  }

  return stats;
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
 * @param {boolean} [filters.last24h] only roles posted in the last 24 hours
 * @param {boolean} [filters.hideClosed] hide archived/rejected/discarded (default true)
 * @param {string} [filters.sort=score] score|posted|company|updated
 * @param {number} [filters.limit=200]
 * @param {Date} [filters.now]
 * @returns {object[]} decorated board rows
 */
export function listBoardJobs(db, filters = {}) {
  const now = filters.now ?? new Date();
  const approvals = approvalsByJob(db);
  const hideClosed = filters.hideClosed !== false && filters.hideClosed !== 'false';

  let rows = db.listJobs({}).map((job) => boardRow(job, approvals.get(job.id) ?? null, now));

  if (filters.q) {
    const q = String(filters.q).toLowerCase();
    rows = rows.filter((r) => [r.company, r.title, r.location]
      .some((v) => String(v ?? '').toLowerCase().includes(q)));
  }
  if (filters.fit) rows = rows.filter((r) => r.fit === filters.fit);
  if (filters.appStatus) rows = rows.filter((r) => r.appStatus === filters.appStatus);
  if (filters.source) rows = rows.filter((r) => r.source === filters.source);
  if (filters.sponsorship) rows = rows.filter((r) => r.sponsorship === filters.sponsorship);
  if (filters.last24h === true || filters.last24h === 'true') {
    rows = rows.filter((r) => r.postedLast24h);
  }
  if (hideClosed && !filters.appStatus) {
    rows = rows.filter((r) => ![APP_STATUS.ARCHIVED, APP_STATUS.REJECTED, APP_STATUS.DISCARDED]
      .includes(r.appStatus));
  }

  rows.sort(SORTS[filters.sort] ?? SORTS.score);
  const limit = Number(filters.limit) > 0 ? Number(filters.limit) : 200;
  return rows.slice(0, limit);
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
  return { ...row, jdText: job.jd_text ?? null, packet };
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
 * @param {import('../logging/db.js').Database} db
 * @param {string} jobId
 * @param {object} [deps] { now }
 * @returns {{ id: string, appStatus: string, appliedAt: string }}
 */
export function markSubmittedByHuman(db, jobId, deps = {}) {
  const job = db.getJob(jobId);
  if (!job) throw httpError(404, `unknown job id: ${jobId}`);
  const appliedAt = (deps.now ?? new Date()).toISOString();
  db.upsertJob({ id: jobId, applied: 1, applied_at: appliedAt, status: 'submitted' });
  return { id: jobId, appStatus: APP_STATUS.SUBMITTED, appliedAt };
}
