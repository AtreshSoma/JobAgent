/**
 * CLI command orchestration.
 *
 * Composes the existing building blocks (search, pipeline, packets, approval
 * queue, browser automation) into the discrete phases a user drives from the
 * command line:
 *
 *   discover      search only            -> data/found_jobs.json
 *   score         search + score          -> scored_jobs.json + queued_jobs.json
 *   prepare-apps  + tailor + packets       -> data/packets + approval queue
 *   assist        open browser + fill      -> stops before submit
 *   end-to-end    discover -> ... -> assist (always stops before submit)
 *
 * Plus the approval-queue commands (approvals/approve/reject/packets/packet).
 *
 * Every function takes its dependencies (config/db/logger) so it is testable in
 * isolation; the thin CLI in src/index.js wires the real ones.
 */

import { readFileSync } from 'node:fs';

import { runSearch } from '../search/index.js';
import { classifyDiscovery } from '../search/discoveryFilter.js';
import { sourceKind } from '../search/sources.js';
import { fetchUrl } from '../search/adapters/genericPublicPage.js';
import { runPipeline, preparePacket } from '../pipeline/index.js';
import { writeFoundJobs } from '../outputs.js';
import { emptyCounters } from '../outputs.js';
import { LIFECYCLE } from '../lifecycle.js';
import {
  listPending, approve, reject, APPROVAL_STATUS,
} from '../apply/approvalQueue.js';
import { applyExclusions } from '../scoring/exclusionFilter.js';
import { classifySponsorship } from '../scoring/sponsorshipClassifier.js';
import { classifyEmployment } from '../scoring/employmentClassifier.js';
import { scoreJob } from '../scoring/scorer.js';
import { explainScore } from '../scoring/explainScore.js';
import { assistApply } from '../automation/applyRunner.js';
import { EVENT_TYPES } from '../logging/jobLogger.js';

/**
 * DISCOVER — search only, write data/found_jobs.json (no scoring).
 * @returns {Promise<{ counters: object, found: string, jobs: object[] }>}
 */
export async function runDiscover({ config, logger, deps = {} } = {}) {
  const searchFn = deps.searchFn ?? runSearch;
  logger?.event?.(EVENT_TYPES.SEARCH_START, { message: 'Discovery search starting' });
  const { jobs, duplicates, errors } = await searchFn({
    jobboards: config.jobboards,
    candidate: config.candidate,
    scoring: config.scoring,
    existsInDb: () => false,
  });
  logger?.event?.(EVENT_TYPES.SEARCH_END, {
    message: `Discovery complete: ${jobs.length} jobs`,
    meta: { found: jobs.length, duplicates: duplicates.length, errors: errors.length },
  });

  const discovered = jobs.map((job) => {
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });
    return {
      id: job.id,
      source: job.source,
      sourceKind: job.rawMetadata?.sourceKind ?? sourceKind(job.source),
      company: job.company,
      title: job.title,
      location: job.location,
      url: job.url,
      discoveryMatch: discovery?.match ?? 'unknown',
      discoverySignals: discovery?.signals ?? [],
      discoveryReasons: discovery?.reasons ?? [],
      keptForScoring: null,
      lifecycle: LIFECYCLE.FOUND,
      score: null,
      tier: null,
      sponsorship: null,
      matchedKeywords: [],
      missingKeywords: [],
      packetPath: null,
      discardReason: null,
    };
  });

  const counters = { ...emptyCounters(), jobs_found: jobs.length };
  const found = writeFoundJobs(config.root, { discovered, duplicates, errors, counters }, deps);
  return { counters, found, jobs: discovered, errors };
}

/**
 * SCORE — search + score, write found/scored/queued artifacts (no packets).
 * Delegates to the pipeline in DRY_RUN mode.
 */
export async function runScore({ config, db, logger, deps = {} } = {}) {
  return runPipeline({ config, db, logger, mode: 'DRY_RUN', deps });
}

/**
 * PREPARE_APPS — search + score + tailor resumes + build packets + enqueue.
 * Delegates to the pipeline in PREPARE mode.
 */
export async function runPrepareApps({ config, db, logger, deps = {} } = {}) {
  return runPipeline({ config, db, logger, mode: 'PREPARE', deps });
}

/**
 * ADD ONE JOB BY URL — the fully-compliant manual path for postings on sites
 * the discovery adapters cannot enumerate (Microsoft/Amazon/Apple and other
 * custom/Eightfold/bot-protected career platforms). Fetches ONLY the public
 * page the user pasted (schema.org JobPosting JSON-LD, else readable content),
 * then runs the SAME exclusion → sponsorship → score → tier logic the pipeline
 * uses, and persists the job so it appears on the board to triage/prepare/assist
 * exactly like a discovered one. No login, no scraping of search results, no
 * evasion — one public URL the human chose.
 *
 * @param {object} args
 * @param {object} args.config loadConfig bundle
 * @param {import('../logging/db.js').Database} args.db
 * @param {object} [args.logger]
 * @param {string} args.url a public job posting URL
 * @param {object} [args.deps] { fetchImpl, now }
 * @returns {Promise<{ id, company, title, url, score, tier, sponsorship, appStatusHint, alreadyExisted }>}
 */
export async function ingestUrl({ config, db, logger, url, deps = {} } = {}) {
  const clean = String(url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(clean)) {
    throw Object.assign(new Error('please paste a valid public job URL (http/https)'), { statusCode: 400 });
  }
  const now = deps.now ?? new Date();
  const fetchImpl = deps.fetchImpl ?? fetch;

  let parsed;
  try {
    parsed = await fetchUrl(clean, { fetchImpl, source: 'manual-url', maxRetries: 1 });
  } catch (err) {
    // A blocked/erroring page is a normal outcome for bot-protected sites — be
    // honest rather than fabricate a job. Never bypass the protection.
    throw Object.assign(
      new Error(`could not read that page (${err.message}). Some career sites block automated reads — open it and paste the job description manually if needed.`),
      { statusCode: 422 },
    );
  }
  const job = parsed[0];
  if (!job || (!job.title && !job.jdText)) {
    throw Object.assign(
      new Error('no job posting found at that URL (no readable title or description). It may require login or block automated reads.'),
      { statusCode: 422 },
    );
  }

  const existed = Boolean(db.getJob?.(job.id));

  // A manually-pasted URL is a DELIBERATE human choice, so it is ALWAYS scored —
  // the bulk freshness filter (skip postings older than N days) must not silently
  // discard it without a score, which is what hid the fit for an older posting.
  // Any exclusion that WOULD have applied during bulk discovery (staleness, a
  // "no sponsorship" phrase, a role/location mismatch) is surfaced as a visible
  // caveat instead of a hard discard; the score + tier still decide the outcome.
  const exclusion = applyExclusions(job, config.exclusions, { now });
  const caveat = exclusion.excluded ? `Heads-up (${exclusion.category}): ${exclusion.reason}.` : null;
  if (caveat) {
    logger?.event?.(EVENT_TYPES.EXCLUSION_MATCHED, { jobId: job.id, message: `${exclusion.reason} (added manually, scored anyway)` });
  }

  const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
  const score = scoreJob(job, { scoring: config.scoring, sponsorship, candidate: config.candidate, now });
  const { tier, explanation } = explainScore(score, config.scoring);
  const fullExplanation = caveat ? `${caveat} ${explanation}` : explanation;

  db.upsertJob({
    id: job.id, source: job.source, company: job.company, title: job.title,
    location: job.location, url: job.url, jd_text: job.jdText, posted_at: job.postedAt,
    applicant_count: job.applicantCount, employment_type: job.employmentType,
    employment_category: classifyEmployment(job, config.exclusions?.employmentTypes).category,
    score: score.total, tier, sponsorship: sponsorship.status,
    matched_keywords: score.matchedKeywords, missing_keywords: score.missingKeywords,
    explanation: fullExplanation, status: tier === 'Discard' ? 'discarded' : 'scored',
    discard_reason: tier === 'Discard' && caveat ? exclusion.reason : null,
  });
  logger?.event?.(EVENT_TYPES.SCORE_EXPLAINED, {
    jobId: job.id, message: `${score.total}/100 -> ${tier} (manual URL)`,
    meta: { score: score.total, tier, sponsorship: sponsorship.status, url: job.url, caveat },
  });

  return {
    id: job.id, company: job.company, title: job.title, url: job.url,
    score: score.total, tier, sponsorship: sponsorship.status,
    appStatusHint: tier === 'Discard' ? 'discarded' : 'scored',
    caveat, alreadyExisted: existed,
  };
}

/** Parse a TEXT column that may hold a JSON array. */
function dbList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

/**
 * PREPARE SELECTED — build packets for SPECIFIC jobs the human chose on the
 * dashboard, using their already-stored score/keywords. Unlike the pipeline,
 * this does not re-discover or re-score; it prepares exactly what was asked,
 * even below the auto-prepare tiers (the human's choice overrides the tiers —
 * but never the safety gates: packets still enter the approval queue).
 *
 * @param {object} args { config, db, logger, jobIds, deps }
 * @returns {Promise<{ prepared: Array<{jobId, packetPath}>, failed: Array<{jobId, error}> }>}
 */
export async function preparePacketsForJobs({ config, db, logger, jobIds = [], deps = {} } = {}) {
  const prepared = [];
  const failed = [];
  const counters = { jobs_prepared: 0 };

  for (const jobId of jobIds) {
    const row = db.getJob(jobId);
    if (!row) { failed.push({ jobId, error: 'unknown job id' }); continue; }
    if (Number(row.applied) === 1) {
      failed.push({ jobId, error: 'already submitted — not re-preparing' });
      continue;
    }
    const job = {
      id: row.id, source: row.source, company: row.company, title: row.title,
      location: row.location, url: row.url, jdText: row.jd_text ?? '',
      postedAt: row.posted_at, applicantCount: row.applicant_count,
      employmentType: row.employment_type,
    };
    const score = {
      total: typeof row.score === 'number' ? row.score : 0,
      matchedKeywords: dbList(row.matched_keywords),
      missingKeywords: dbList(row.missing_keywords),
    };
    try {
      const packetPath = await preparePacket({
        config, db, logger, job, score, tier: row.tier ?? 'Queue', deps, counters,
      });
      prepared.push({ jobId, packetPath });
    } catch (err) {
      failed.push({ jobId, error: err.message });
      logger?.error?.(`prepare-selected failed: ${err.message}`, {}, jobId);
    }
  }
  return { prepared, failed, counters };
}

/**
 * Load the packet JSON referenced by an approval row.
 * @returns {object|null}
 */
export function loadPacket(approvalRow, deps = {}) {
  const readImpl = deps.readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
  if (!approvalRow?.packet_path) return null;
  try {
    return JSON.parse(readImpl(approvalRow.packet_path));
  } catch {
    return null;
  }
}

/**
 * ASSIST — open the browser for queued packets and fill them, advancing through
 * safe multi-step navigation (Next/Continue/Review) and stopping before the
 * final submit. Submission is never attempted — a human reviews and submits.
 *
 * @param {object} args
 * @param {string} [args.mode] resolved run mode; defaults to LIVE_ASSIST
 * @returns {Promise<{ results: object[], counters: object }>}
 */
export async function runAssist({ config, db, logger, mode, options = {}, deps = {} } = {}) {
  const assistFn = deps.assistFn ?? assistApply;
  const effectiveMode = mode ?? 'LIVE_ASSIST';

  // Only act on packets a human has approved. Pending/rejected are skipped.
  const approvals = db.listApprovals({ status: APPROVAL_STATUS.APPROVED });
  const results = [];
  const counters = { ...emptyCounters(), jobs_skipped_already_applied: 0 };
  let dailyCount = db.countAppliedOn?.(isoDate(deps.now)) ?? 0;

  for (const approval of approvals) {
    // Idempotency guard: never re-assist a job that was already submitted by a
    // human. Re-running assist must NOT reopen a completed application.
    const jobRow = db.getJob?.(approval.job_id) ?? null;
    if (jobRow && (Number(jobRow.applied) === 1 || jobRow.status === LIFECYCLE.SUBMITTED)) {
      counters.jobs_skipped_already_applied += 1;
      logger?.event?.(EVENT_TYPES.DUPLICATE_SKIPPED, {
        jobId: approval.job_id,
        message: 'already applied — skipping to avoid reopening a completed application',
        meta: { status: jobRow.status ?? null, applied_at: jobRow.applied_at ?? null },
      });
      continue;
    }

    const packet = loadPacket(approval, deps);
    if (!packet) {
      logger?.error?.(`could not load packet for approval ${approval.id}`, {}, approval.job_id);
      continue;
    }

    const result = await assistFn({
      packet, config, mode: effectiveMode, approval, dailyCount, options, deps,
    });
    results.push(result);
    counters.jobs_assisted += 1;
    recordAssistResult(db, approval.job_id, result);
    logger?.event?.(EVENT_TYPES.PREFILL_STARTED, {
      jobId: approval.job_id,
      message: `assist ${result.status}`,
      meta: { status: result.status, blockers: result.blockers?.length ?? 0 },
    });
  }

  return { results, counters };
}

/**
 * END_TO_END — prepare packets, then assist. Always stops before submit; assist
 * only acts on packets a human has already approved.
 */
export async function runEndToEnd({ config, db, logger, options = {}, deps = {} } = {}) {
  const prepared = await runPrepareApps({ config, db, logger, deps });
  const assisted = await runAssist({ config, db, logger, options, deps });
  return { prepared: prepared.counters, assisted: assisted.counters, results: assisted.results };
}

/* --------------------------- approval-queue CLI --------------------------- */

/** List packets awaiting review (or all, with `all: true`). */
export function listApprovalQueue(db, { all = false } = {}) {
  return all ? db.listApprovals() : listPending(db);
}

/** Approve a packet by approval id. */
export function approvePacket(db, approvalId) {
  return approve(db, approvalId);
}

/** Reject a packet by approval id. */
export function rejectPacket(db, approvalId) {
  return reject(db, approvalId);
}

/** List prepared packets (joined view from the approval queue). */
export function listPackets(db, deps = {}) {
  return db.listApprovals().map((a) => {
    const packet = loadPacket(a, deps);
    return {
      approvalId: a.id,
      jobId: a.job_id,
      status: a.approval_status,
      approvedByUser: Boolean(a.approved_by_user),
      packetPath: a.packet_path,
      company: packet?.job?.company ?? null,
      title: packet?.job?.title ?? null,
      score: packet?.score ?? null,
      tier: packet?.tier ?? null,
      blockers: packet?.blockers ?? [],
    };
  });
}

/** Load a single packet by job id or packet/approval id. */
export function getPacket(db, idOrJobId, deps = {}) {
  const approvals = db.listApprovals();
  const match = approvals.find(
    (a) => a.job_id === idOrJobId || a.id === idOrJobId || a.packet_path?.includes(idOrJobId),
  );
  if (!match) return null;
  return { approval: match, packet: loadPacket(match, deps) };
}

/* ------------------------------- helpers --------------------------------- */

function isoDate(now) {
  // deps.now may be a Date OR a clock function (dashboard/tests inject both).
  const d = typeof now === 'function' ? now() : now ?? new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Persist the outcome of one assisted-fill run: lifecycle status, how many
 * fields were actually filled, and the blockers that need the human. This is
 * what makes "Fields Filled" / "Blockers" in the tracker and dashboard real
 * data instead of guesses. Exported so the dashboard server records assists
 * identically to the CLI.
 */
export function recordAssistResult(db, jobId, result) {
  if (!jobId) return;
  try {
    const patch = {
      id: jobId,
      status: result.status,
      assist_filled_count: Array.isArray(result.filled) ? result.filled.length : null,
      assist_blockers: Array.isArray(result.blockers) ? result.blockers : [],
    };
    // Auto-submit (explicit per-run opt-in) is the ONE automated path to
    // applied=1 — the runner only sets result.submitted after clicking the
    // final Submit on a clean form at the human's request.
    if (result.submitted === true) {
      patch.applied = 1;
      patch.applied_at = new Date().toISOString();
      patch.status = 'submitted';
      patch.submitted_confirmation = 'auto-submitted — verify the ATS confirmation email';
    }
    db.upsertJob(patch);
  } catch {
    /* job may not be persisted in some flows; ignore */
  }
}
