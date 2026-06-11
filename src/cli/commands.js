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
import { runPipeline } from '../pipeline/index.js';
import { writeFoundJobs } from '../outputs.js';
import { emptyCounters } from '../outputs.js';
import { LIFECYCLE } from '../lifecycle.js';
import {
  listPending, approve, reject, APPROVAL_STATUS,
} from '../apply/approvalQueue.js';
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
  return (now ?? new Date()).toISOString().slice(0, 10);
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
    db.upsertJob({
      id: jobId,
      status: result.status,
      assist_filled_count: Array.isArray(result.filled) ? result.filled.length : null,
      assist_blockers: Array.isArray(result.blockers) ? result.blockers : [],
    });
  } catch {
    /* job may not be persisted in some flows; ignore */
  }
}
