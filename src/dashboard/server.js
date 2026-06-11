/**
 * Local dashboard server.
 *
 * A zero-dependency node:http server that drives the whole workflow from the
 * browser: stats tiles, a filterable job board, per-job detail with the fit
 * explanation and packet contents, user triage (shortlist/reject/archive),
 * packet approval, pipeline runs, assisted form filling, and the
 * "I submitted it myself" confirmation.
 *
 * Safety properties (identical to the CLI):
 *   - Binds to 127.0.0.1 ONLY. This is a local cockpit, never a public site.
 *   - Nothing is ever auto-submitted. The assist endpoint fills an APPROVED
 *     packet in a real browser and stops before submit, exactly like the CLI.
 *   - "Submitted" is only ever set by the explicit mark-submitted action.
 *   - One pipeline run / one assist at a time (busy guard); state is pollable.
 *
 * API:
 *   GET  /api/stats                       tiles + source/status breakdowns
 *   GET  /api/jobs?…filters               board rows
 *   GET  /api/jobs/:id                    full detail incl. packet summary
 *   POST /api/jobs/:id/decision {decision} shortlist | rejected | archived | clear
 *   POST /api/jobs/:id/approve            approve prepared packet (human gate)
 *   POST /api/jobs/:id/reject-packet      reject prepared packet
 *   POST /api/jobs/:id/mark-submitted     record YOUR manual submission
 *   POST /api/jobs/:id/assist             fill the approved packet, stop before submit
 *   POST /api/run {phase}                 discover | score | prepare (async)
 *   GET  /api/run/status                  current/last run state
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dashboardStats, listBoardJobs, jobDetail, applyDecision,
  approveJobPacket, rejectJobPacket, markSubmittedByHuman,
} from './data.js';
import { runDiscover, runScore, runPrepareApps, loadPacket, recordAssistResult } from '../cli/commands.js';
import { assistApply } from '../automation/applyRunner.js';
import { APPROVAL_STATUS } from '../apply/approvalQueue.js';
import { writeJobTracker } from '../reports/jobTracker.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

/** Phases the dashboard may trigger. Submission is intentionally absent. */
const RUN_PHASES = new Set(['discover', 'score', 'prepare']);

/**
 * Create (but do not start) the dashboard server.
 *
 * @param {object} args
 * @param {object} args.config loadConfig() bundle
 * @param {import('../logging/db.js').Database} args.db
 * @param {object} args.logger JobLogger
 * @param {object} [args.deps] injectable: runners/assistFn/now (testing)
 * @returns {{ server: import('node:http').Server, runState: object }}
 */
export function createDashboardServer({ config, db, logger, deps = {} } = {}) {
  const runners = {
    discover: deps.discoverFn ?? (() => runDiscover({ config, logger, deps })),
    score: deps.scoreFn ?? (() => runScore({ config, db, logger, deps })),
    prepare: deps.prepareFn ?? (() => runPrepareApps({ config, db, logger, deps })),
  };
  const assistFn = deps.assistFn ?? assistApply;

  /** Single mutable run/assist state, surfaced at /api/run/status. */
  const runState = {
    running: false, phase: null, startedAt: null,
    finishedAt: null, lastResult: null, lastError: null,
  };

  /**
   * Rewrite data/job_tracker.csv so the spreadsheet always mirrors the DB after
   * any mutating action (approve/reject/decision/submit/assist). No-ops when the
   * config has no root (unit tests) or the write fails — the API never 500s
   * just because the CSV could not be refreshed.
   *
   * @returns {string|null} the CSV path, or null when skipped
   */
  function refreshTracker() {
    const root = config?.root;
    if (!root) return null;
    try {
      const writeImpl = deps.writeJobTrackerImpl ?? writeJobTracker;
      return writeImpl(db, root).path;
    } catch (err) {
      logger?.warn?.(`tracker refresh failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Make the packet navigate to the URL the user actually sees on the board.
   *
   * The packet's `job.url` is frozen at prepare time; if discovery later
   * refreshed the job's URL (e.g. an Indeed/aggregator link resolved to the
   * direct company page), the packet would still point the browser at the old,
   * already-closed link. We always trust the live DB `job.url` so auto-apply
   * opens the same posting shown in the dashboard. Returns the packet unchanged
   * when the DB has no URL (never blanks out a working packet URL).
   *
   * @param {object} packet loaded application packet
   * @param {string} jobId
   * @returns {object} the reconciled packet
   */
  function reconcilePacket(packet, jobId) {
    if (!packet) return packet;
    const job = db.getJob?.(jobId);
    const liveUrl = job?.url;
    if (liveUrl && packet.job && packet.job.url !== liveUrl) {
      logger?.info?.(`assist: using live job URL for ${jobId} (packet URL was stale)`);
      packet.job = { ...packet.job, url: liveUrl };
    }
    return packet;
  }

  async function startRun(phase) {
    if (runState.running) {
      const err = new Error(`a ${runState.phase} run is already in progress`);
      err.statusCode = 409;
      throw err;
    }
    Object.assign(runState, {
      running: true, phase, startedAt: new Date().toISOString(),
      finishedAt: null, lastError: null,
    });
    // Fire and forget; the UI polls /api/run/status.
    (async () => {
      try {
        const r = await runners[phase]();
        runState.lastResult = { phase, counters: r.counters ?? null };
      } catch (err) {
        runState.lastError = `${phase} failed: ${err.message}`;
      } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
      }
    })();
    return { started: true, phase };
  }

  async function startAssist(jobId) {
    if (runState.running) {
      const err = new Error(`busy: ${runState.phase} is in progress`);
      err.statusCode = 409;
      throw err;
    }
    const approval = db.getApprovalByJob?.(jobId);
    if (!approval || approval.approval_status !== APPROVAL_STATUS.APPROVED) {
      const err = new Error('packet is not human-approved — approve it first');
      err.statusCode = 400;
      throw err;
    }
    const loaded = deps.loadPacketImpl ? deps.loadPacketImpl(approval) : loadPacket(approval);
    if (!loaded) {
      const err = new Error(`packet file unreadable for job ${jobId}`);
      err.statusCode = 500;
      throw err;
    }
    const packet = reconcilePacket(loaded, jobId);
    Object.assign(runState, {
      running: true, phase: `assist:${jobId}`, startedAt: new Date().toISOString(),
      finishedAt: null, lastError: null,
    });
    (async () => {
      try {
        const result = await assistFn({ packet, config, mode: 'LIVE_ASSIST', approval, options: {}, deps });
        recordAssistResult(db, jobId, result);
        refreshTracker();
        runState.lastResult = {
          phase: 'assist', jobId, status: result.status,
          blockers: result.blockers ?? [],
        };
      } catch (err) {
        runState.lastError = `assist failed: ${err.message}`;
      } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
      }
    })();
    return { started: true, jobId, note: 'browser will stop before submit — review and click Submit yourself' };
  }

  /**
   * Auto-apply across a chosen set of jobs, ONE browser at a time. Each job is
   * filled and advanced through safe Next/Continue steps, then left on the final
   * page — the human still reviews and clicks Submit. Nothing is auto-submitted.
   *
   * Jobs that are not human-approved are skipped (never silently filled). The
   * batch runs in the background; the UI polls /api/run/status for progress.
   *
   * @param {string[]} jobIds
   * @returns {{ started: true, queued: number, skipped: string[] }}
   */
  function startAssistBatch(jobIds) {
    if (runState.running) {
      const err = new Error(`busy: ${runState.phase} is in progress`);
      err.statusCode = 409;
      throw err;
    }
    const ids = Array.isArray(jobIds) ? [...new Set(jobIds.filter(Boolean))] : [];
    if (ids.length === 0) {
      const err = new Error('select at least one job to auto-apply');
      err.statusCode = 400;
      throw err;
    }
    const queue = [];
    const skipped = [];
    for (const jobId of ids) {
      const approval = db.getApprovalByJob?.(jobId);
      if (!approval || approval.approval_status !== APPROVAL_STATUS.APPROVED) {
        skipped.push(jobId);
        continue;
      }
      const loaded = deps.loadPacketImpl ? deps.loadPacketImpl(approval) : loadPacket(approval);
      if (!loaded) { skipped.push(jobId); continue; }
      queue.push({ jobId, packet: reconcilePacket(loaded, jobId), approval });
    }
    if (queue.length === 0) {
      const err = new Error('none of the selected jobs are approved — approve them first');
      err.statusCode = 400;
      throw err;
    }
    Object.assign(runState, {
      running: true, phase: `assist-batch (0/${queue.length})`,
      startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
    });
    (async () => {
      const results = [];
      let done = 0;
      try {
        for (const { jobId, packet, approval } of queue) {
          runState.phase = `assist-batch (${done + 1}/${queue.length}) — ${jobId}`;
          try {
            const result = await assistFn({ packet, config, mode: 'LIVE_ASSIST', approval, options: {}, deps });
            recordAssistResult(db, jobId, result);
            results.push({ jobId, status: result.status, blockers: result.blockers ?? [] });
          } catch (err) {
            results.push({ jobId, status: 'failed', error: err.message });
          }
          done += 1;
        }
        refreshTracker();
        runState.lastResult = { phase: 'assist-batch', total: queue.length, skipped, results };
      } catch (err) {
        // A background batch failure must NEVER escape — an unhandled rejection
        // here would crash the whole dashboard process (the UI would then only
        // ever show "Failed to fetch").
        runState.lastError = `assist-batch failed: ${err.message}`;
        runState.lastResult = { phase: 'assist-batch', total: queue.length, skipped, results };
      } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
      }
    })();
    return { started: true, queued: queue.length, skipped };
  }

  /** Current time: injectable as a function for deterministic tests. */
  const nowDate = () => (typeof deps.now === 'function' ? deps.now() : new Date());

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      sendJson(res, err.statusCode ?? 500, { error: err.message });
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && path === '/api/stats') {
      return sendJson(res, 200, dashboardStats(db, { now: nowDate() }));
    }
    if (req.method === 'GET' && path === '/api/jobs') {
      const filters = Object.fromEntries(url.searchParams.entries());
      filters.now = nowDate();
      return sendJson(res, 200, { jobs: listBoardJobs(db, filters) });
    }
    if (req.method === 'GET' && path === '/api/run/status') {
      return sendJson(res, 200, runState);
    }
    if (req.method === 'GET' && path === '/api/export/tracker.csv') {
      const root = config?.root;
      if (!root) return sendJson(res, 400, { error: 'no project root configured for export' });
      const writeImpl = deps.writeJobTrackerImpl ?? writeJobTracker;
      const { path: csvPath } = writeImpl(db, root);
      const csv = (deps.readTextImpl ?? ((p) => readFileSync(p, 'utf8')))(csvPath);
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="job_tracker.csv"',
      });
      res.end(csv);
      return;
    }
    if (req.method === 'POST' && path === '/api/run') {
      const body = await readBody(req);
      if (!RUN_PHASES.has(body.phase)) {
        return sendJson(res, 400, { error: `phase must be one of: ${[...RUN_PHASES].join(', ')}` });
      }
      return sendJson(res, 202, await startRun(body.phase));
    }
    if (req.method === 'POST' && path === '/api/assist-batch') {
      const body = await readBody(req);
      return sendJson(res, 202, startAssistBatch(body.jobIds));
    }
    if (req.method === 'POST' && path === '/api/approve-batch') {
      const body = await readBody(req);
      const ids = Array.isArray(body.jobIds) ? [...new Set(body.jobIds.filter(Boolean))] : [];
      const approved = [];
      const failed = [];
      for (const jobId of ids) {
        try { approveJobPacket(db, jobId); approved.push(jobId); }
        catch (err) { failed.push({ jobId, error: err.message }); }
      }
      refreshTracker();
      return sendJson(res, 200, { approved, failed });
    }

    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(?:\/([a-z-]+))?$/);
    if (jobMatch) {
      const [, jobId, action] = jobMatch.map((s) => (s ? decodeURIComponent(s) : s));
      if (req.method === 'GET' && !action) {
        const detail = jobDetail(db, jobId, { ...deps, now: nowDate() });
        if (!detail) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
        return sendJson(res, 200, detail);
      }
      if (req.method === 'POST' && action === 'decision') {
        const body = await readBody(req);
        const result = applyDecision(db, jobId, body.decision);
        refreshTracker();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'approve') {
        const result = approveJobPacket(db, jobId);
        refreshTracker();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'reject-packet') {
        const result = rejectJobPacket(db, jobId);
        refreshTracker();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'mark-submitted') {
        const result = markSubmittedByHuman(db, jobId, { now: nowDate() });
        refreshTracker();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'assist') {
        return sendJson(res, 202, await startAssist(jobId));
      }
    }

    sendJson(res, 404, { error: `no route: ${req.method} ${path}` });
  }

  return { server, runState };
}

/**
 * Start the dashboard on 127.0.0.1.
 *
 * @param {object} args createDashboardServer args + { port }
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, close: Function }>}
 */
export function startDashboard({ config, db, logger, port = 4646, deps = {} } = {}) {
  const { server, runState } = createDashboardServer({ config, db, logger, deps });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only — the dashboard must never be reachable from the network.
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        server,
        runState,
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/**
 * Keep the long-lived dashboard process alive when detached background work
 * throws. The dashboard fires browser automation as fire-and-forget jobs and
 * leaves a real browser open for the human to review; if the user closes that
 * window (or Playwright's transport errors), the resulting unhandled rejection
 * would otherwise terminate the whole server and every later request would fail
 * with the browser's generic "Failed to fetch". This records the error on
 * `runState.lastError` (so the UI surfaces it) and keeps serving. Process
 * signals (SIGINT/SIGTERM) are deliberately NOT intercepted. Returns an
 * uninstall function so tests never leak global handlers.
 *
 * @param {object} args
 * @param {object} [args.runState] shared run state to annotate
 * @param {object} [args.logger]
 * @param {NodeJS.EventEmitter} [args.proc=process]
 * @returns {() => void} uninstall the handlers
 */
export function installProcessSafetyNet({ runState, logger, proc = process } = {}) {
  const record = (kind) => (reason) => {
    const msg = reason?.message ?? String(reason);
    logger?.error?.(`dashboard survived an ${kind}: ${msg}`);
    if (runState) runState.lastError = `background error (server still up): ${msg}`;
  };
  const onRejection = record('unhandled rejection');
  const onException = record('uncaught exception');
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off?.('unhandledRejection', onRejection);
    proc.off?.('uncaughtException', onException);
  };
}

/* ------------------------------- helpers --------------------------------- */

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Read and parse a JSON request body (empty body -> {}). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}
