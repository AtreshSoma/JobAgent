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
  SKIPPED: 'skipped',              // user skipped it during assisted apply
  BLOCKED: 'blocked',              // assist hit login/captcha/unknown fields
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
  [APP_STATUS.SKIPPED]: 'skipped',
  [APP_STATUS.REJECTED]: 'rejected',
  [APP_STATUS.ARCHIVED]: 'archived',
  [APP_STATUS.DISCARDED]: 'discarded',
  [APP_STATUS.DATE_UNCONFIRMED]: 'date_unconfirmed',
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
  const appStatus = deriveAppStatus(job, approval);
  const score = typeof job.score === 'number' ? job.score : null;
  const haystack = `${job.location ?? ''} ${job.employment_type ?? ''} ${job.title ?? ''}`.toLowerCase();
  return {
    id: job.id,
    company: job.company,
    title: job.title,
    location: job.location,
    url: job.url,
    source: job.source || 'unknown',
    score,
    grade: gradeFromScore(score),
    tier: job.tier ?? null,
    fit: fitBucket(job.tier),
    sponsorship: job.sponsorship ?? null,
    employmentType: job.employment_type ?? null,
    remote: /\bremote\b/.test(haystack),
    postedAt: job.posted_at ?? null,
    postedLabel: formatPostedRelative(job.posted_at, now),
    postedLast24h: isWithinLast24Hours(job.posted_at, now),
    postedConfidence: postedConfidence(job),
    appStatus,
    progress: progressFor(appStatus),
    lastAction: lastActionFor(job, appStatus),
    userDecision: job.user_decision ?? null,
    atsPlatform: job.ats_platform ?? null,
    resumeStatus: resumeStatusOf(job),
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
    coverLetterPath: job.cover_letter_path ?? null,
    notes: job.notes ?? null,
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
      preparedToday: 0,
      submittedToday: 0,
      pendingReview: 0,
      blocked: 0,
      readyForSubmit: 0,
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
    daily: [],
    nextActions: [],
  };

  let strongUntriaged = 0;

  for (const job of jobs) {
    const approval = approvals.get(job.id) ?? null;
    const status = deriveAppStatus(job, approval);
    const fit = fitBucket(job.tier);
    const source = job.source || 'unknown';

    if (dayOf(job.created_at) === today) stats.totals.discoveredToday += 1;
    if (isWithinLast24Hours(job.created_at, now)) stats.totals.discoveredLast24h += 1;
    if (job.created_at && (!stats.lastDiscoveryAt || job.created_at > stats.lastDiscoveryAt)) {
      stats.lastDiscoveryAt = job.created_at;
    }
    if (isWithinLast24Hours(job.posted_at, now)) stats.totals.postedLast24h += 1;
    if (fit === 'strong') stats.totals.strongFit += 1;
    if (fit === 'medium') stats.totals.mediumFit += 1;
    if (fit === 'weak') stats.totals.weakFit += 1;
    if (job.user_decision === 'shortlisted') stats.totals.shortlisted += 1;
    if (status === APP_STATUS.REJECTED) stats.totals.rejected += 1;
    if (status === APP_STATUS.SKIPPED) stats.totals.skipped += 1;
    if (status === APP_STATUS.DATE_UNCONFIRMED) stats.totals.dateUnconfirmed += 1;
    if (job.application_packet_path && dayOf(job.updated_at) === today
        && Number(job.applied) !== 1) stats.totals.preparedToday += 1;
    if (Number(job.applied) === 1 && dayOf(job.applied_at) === today) stats.totals.submittedToday += 1;
    if (status === APP_STATUS.NEEDS_REVIEW) stats.totals.pendingReview += 1;
    if (status === APP_STATUS.BLOCKED) stats.totals.blocked += 1;
    if (status === APP_STATUS.READY_FOR_SUBMIT) stats.totals.readyForSubmit += 1;
    if (Number(job.applied) === 1) stats.totals.submittedTotal += 1;
    if (fit === 'strong' && !job.user_decision && !approval
        && [APP_STATUS.SCORED, APP_STATUS.DISCOVERED].includes(status)) strongUntriaged += 1;

    if (!stats.bySource[source]) {
      stats.bySource[source] = { found: 0, strong: 0, prepared: 0, submitted: 0 };
    }
    stats.bySource[source].found += 1;
    if (fit === 'strong') stats.bySource[source].strong += 1;
    if (job.application_packet_path) stats.bySource[source].prepared += 1;
    if (Number(job.applied) === 1) stats.bySource[source].submitted += 1;

    stats.byStatus[status] = (stats.byStatus[status] ?? 0) + 1;

    const spon = job.sponsorship ?? 'Unclassified';
    if (!stats.bySponsorship[spon]) stats.bySponsorship[spon] = { count: 0, strong: 0 };
    stats.bySponsorship[spon].count += 1;
    if (fit === 'strong') stats.bySponsorship[spon].strong += 1;

    // Daily progress strip.
    const created = dayOf(job.created_at);
    if (daily.has(created)) daily.get(created).discovered += 1;
    if (job.application_packet_path) {
      const prepared = dayOf(job.updated_at);
      if (daily.has(prepared)) daily.get(prepared).prepared += 1;
    }
    if (Number(job.applied) === 1) {
      const submitted = dayOf(job.applied_at);
      if (daily.has(submitted)) daily.get(submitted).submitted += 1;
    }
  }

  stats.daily = [...daily.values()];
  stats.nextActions = buildNextActions(stats.totals, strongUntriaged);
  return stats;
}

/**
 * Concrete "do this next" guidance, ordered by impact. Each action carries the
 * board filter that shows exactly those jobs.
 * @returns {Array<{ text: string, filter: object|null }>}
 */
export function buildNextActions(totals, strongUntriaged = 0) {
  const actions = [];
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
      filter: { appStatus: APP_STATUS.BLOCKED },
    });
  }
  if (strongUntriaged > 0) {
    actions.push({
      text: `${strongUntriaged} strong-fit job(s) have no decision yet — shortlist or reject them`,
      filter: { fit: 'strong' },
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
  if (filters.remote === true || filters.remote === 'true') rows = rows.filter((r) => r.remote);
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

  // Audit trail: every event the system recorded for this job (newest first).
  let events = [];
  try {
    events = (db.listEvents?.(jobId) ?? [])
      .map((e) => ({ at: e.created_at, type: e.event_type, message: e.message }))
      .reverse()
      .slice(0, 30);
  } catch { /* events are best-effort */ }

  return { ...row, jdText: job.jd_text ?? null, packet, events };
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
  const approvals = approvalsByJob(db);
  const rows = db.listJobs({}).map((job) => boardRow(job, approvals.get(job.id) ?? null, now));
  const byScore = (a, b) => (b.score ?? -1) - (a.score ?? -1);
  const is = (r, ...statuses) => statuses.includes(r.appStatus);

  const readyForSubmit = rows.filter((r) => is(r, APP_STATUS.READY_FOR_SUBMIT, APP_STATUS.APPROVED)).sort(byScore);
  const needsReview = rows.filter((r) => is(r, APP_STATUS.NEEDS_REVIEW)).sort(byScore);
  const blocked = rows.filter((r) => is(r, APP_STATUS.BLOCKED)).sort(byScore);
  const submitted = rows.filter((r) => is(r, APP_STATUS.SUBMITTED))
    .sort((a, b) => String(b.appliedAt ?? '').localeCompare(String(a.appliedAt ?? '')));

  // Today's priorities: what needs a human RIGHT NOW, most urgent first.
  const todaysPriorities = [
    ...rows.filter((r) => is(r, APP_STATUS.READY_FOR_SUBMIT)),
    ...needsReview,
    ...blocked,
  ].slice(0, limit).map(sectionRow);

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
    bestMatches,
    needsReview: needsReview.slice(0, limit).map(sectionRow),
    readyForSubmit: readyForSubmit.slice(0, limit).map(sectionRow),
    recentlySubmitted: submitted.slice(0, limit).map(sectionRow),
    blockedByReason,
    counts: {
      todaysPriorities: rows.filter((r) => is(r, APP_STATUS.READY_FOR_SUBMIT, APP_STATUS.NEEDS_REVIEW, APP_STATUS.BLOCKED)).length,
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
  const approvals = approvalsByJob(db);
  let rows = db.listJobs({}).map((job) => boardRow(job, approvals.get(job.id) ?? null, now));
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
