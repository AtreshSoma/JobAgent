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
 *   GET  /api/sections                    curated command-center sections
 *   POST /api/jobs/:id/note {note}        save a free-text note on a job
 *   POST /api/decide-batch {jobIds,decision}  bulk shortlist/reject/archive
 *   POST /api/add-url {url}               ingest one public job URL (score + track)
 *   GET  /api/export/jobs.csv             rich CSV of every job + score/status
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  dashboardStats, listBoardJobs, jobDetail, applyDecision,
  approveJobPacket, rejectJobPacket, markSubmittedByHuman,
  dashboardSections, setJobNote, buildExportRows, exportRowsToCsv, buildReports,
} from './data.js';
import {
  runScore, runPrepareApps, loadPacket, recordAssistResult,
  preparePacketsForJobs, ingestUrl,
} from '../cli/commands.js';
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
    // "Find New Jobs" must leave jobs ON THE BOARD. The bare discover phase
    // only writes data/found_jobs.json — never the SQLite DB the board reads —
    // so the button appeared to do nothing (header stuck at "0 found in last
    // 24h" no matter how many jobs the run found). Route it through the
    // scoring pipeline, which discovers, scores, AND persists in one pass.
    discover: deps.discoverFn ?? (() => runScore({ config, db, logger, deps })),
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
   * Auto-apply across a chosen set of jobs — fully orchestrated, ONE browser at
   * a time. For each job this now runs the WHOLE chain a human used to click
   * through by hand:
   *
   *   1. PREPARE  — jobs without a packet get a tailored resume + packet built
   *   2. APPROVE  — clicking Auto-apply IS the explicit human approval
   *   3. FILL     — open the posting, fill every known field, advance safe
   *                 Next/Continue steps, and STOP before the final Submit
   *
   * Nothing is ever auto-submitted — the browser is left open on the final page
   * for the human to review and click Submit. Jobs whose packet cannot be
   * prepared/loaded are reported in `skipped`, never silently dropped. The
   * batch runs in the background; the UI polls /api/run/status for progress.
   *
   * When `runOpts.autoSubmit` is true (an explicit, per-run human choice), the
   * runner also clicks the final Submit — but only on a completely clean form
   * and under the daily application cap; see applyRunner.tryAutoSubmit.
   *
   * @param {string[]} jobIds
   * @param {{ autoSubmit?: boolean }} [runOpts]
   * @returns {{ started: true, queued: number }}
   */
  function startAssistBatch(jobIds, runOpts = {}) {
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
    Object.assign(runState, {
      running: true, phase: `auto-apply (0/${ids.length})`,
      startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
    });
    (async () => {
      const results = [];
      const skipped = [];
      let queueLen = 0;
      try {
        // 1. Prepare packets for jobs that don't have one yet (tailored resume
        //    + application packet). Failures are honest skips, not crashes.
        const needPacket = ids.filter((id) => !db.getApprovalByJob?.(id));
        if (needPacket.length) {
          runState.phase = `auto-apply — preparing ${needPacket.length} packet(s)…`;
          const prepareImpl = deps.prepareForJobsFn ?? preparePacketsForJobs;
          const prep = await prepareImpl({ config, db, logger, jobIds: needPacket, deps });
          for (const f of prep.failed ?? []) skipped.push({ jobId: f.jobId, reason: f.error });
        }

        // 2+3. Approve (the click is the approval) and fill, one at a time.
        const queue = [];
        for (const jobId of ids) {
          if (skipped.some((s) => s.jobId === jobId)) continue;
          let approval = db.getApprovalByJob?.(jobId);
          if (!approval) { skipped.push({ jobId, reason: 'no packet could be prepared' }); continue; }
          if (approval.approval_status !== APPROVAL_STATUS.APPROVED) {
            approveJobPacket(db, jobId);
            approval = db.getApprovalByJob(jobId);
          }
          const loaded = deps.loadPacketImpl ? deps.loadPacketImpl(approval) : loadPacket(approval);
          if (!loaded) { skipped.push({ jobId, reason: 'packet file unreadable' }); continue; }
          queue.push({ jobId, packet: reconcilePacket(loaded, jobId), approval });
        }
        queueLen = queue.length;

        let done = 0;
        const autoSubmit = runOpts.autoSubmit === true;
        // Seed the daily cap from what was already submitted today, and bump
        // it as this batch submits, so one batch can never blow past the cap.
        let dailyCount = db.countAppliedOn?.(new Date().toISOString().slice(0, 10)) ?? 0;
        for (const { jobId, packet, approval } of queue) {
          runState.phase = `auto-apply (${done + 1}/${queue.length}) — ${jobId}`;
          try {
            const result = await assistFn({
              packet, config, mode: 'LIVE_ASSIST', approval, dailyCount,
              options: { autoSubmit }, deps,
            });
            recordAssistResult(db, jobId, result);
            if (result.submitted === true) dailyCount += 1;
            results.push({ jobId, status: result.status, submitted: result.submitted === true, blockers: result.blockers ?? [] });
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
        runState.lastError = `auto-apply failed: ${err.message}`;
        runState.lastResult = { phase: 'assist-batch', total: queueLen, skipped, results };
      } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
      }
    })();
    return { started: true, queued: ids.length };
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
    // Interview-prep mini-site, mounted under /learn (a separate hash-routed SPA).
    // Redirect the bare path to /learn/ so the SPA's relative asset URLs resolve
    // under /learn/assets/ rather than the dashboard root.
    if (req.method === 'GET' && path === '/learn') {
      res.writeHead(302, { location: '/learn/' });
      res.end();
      return;
    }
    if (req.method === 'GET' && path === '/learn/') {
      const html = readFileSync(join(PUBLIC_DIR, 'learn', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    // Static assets (css/js/img/fonts) for the dashboard and the /learn mini-site.
    if (req.method === 'GET' && (path.startsWith('/assets/') || path.startsWith('/learn/assets/'))) {
      return serveStatic(res, path);
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
    if (req.method === 'GET' && path === '/api/sections') {
      return sendJson(res, 200, dashboardSections(db, { now: nowDate() }));
    }
    if (req.method === 'GET' && path === '/api/reports') {
      return sendJson(res, 200, buildReports(db, { now: nowDate() }));
    }
    if (req.method === 'GET' && path === '/api/export/jobs.csv') {
      const csv = exportRowsToCsv(buildExportRows(db, { now: nowDate() }));
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="jobagent_jobs.csv"',
      });
      res.end(csv);
      return;
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
      return sendJson(res, 202, startAssistBatch(body.jobIds, { autoSubmit: body.autoSubmit === true }));
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
    if (req.method === 'POST' && path === '/api/prepare-batch') {
      const body = await readBody(req);
      const ids = Array.isArray(body.jobIds) ? [...new Set(body.jobIds.filter(Boolean))] : [];
      if (ids.length === 0) return sendJson(res, 400, { error: 'select at least one job to prepare' });
      if (runState.running) {
        return sendJson(res, 409, { error: `busy: ${runState.phase} is in progress` });
      }
      Object.assign(runState, {
        running: true, phase: `prepare-selected (${ids.length})`,
        startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
      });
      (async () => {
        try {
          const prepareImpl = deps.prepareForJobsFn ?? preparePacketsForJobs;
          const r = await prepareImpl({ config, db, logger, jobIds: ids, deps });
          refreshTracker();
          runState.lastResult = {
            phase: 'prepare-selected',
            counters: { jobs_prepared: r.prepared.length },
            prepared: r.prepared, failed: r.failed,
          };
        } catch (err) {
          runState.lastError = `prepare-selected failed: ${err.message}`;
        } finally {
          runState.running = false;
          runState.finishedAt = new Date().toISOString();
        }
      })();
      return sendJson(res, 202, { started: true, queued: ids.length });
    }
    if (req.method === 'POST' && path === '/api/decide-batch') {
      const body = await readBody(req);
      const ids = Array.isArray(body.jobIds) ? [...new Set(body.jobIds.filter(Boolean))] : [];
      const updated = [];
      const failed = [];
      for (const jobId of ids) {
        try { applyDecision(db, jobId, body.decision); updated.push(jobId); }
        catch (err) { failed.push({ jobId, error: err.message }); }
      }
      refreshTracker();
      return sendJson(res, 200, { updated, failed, decision: body.decision });
    }
    if (req.method === 'POST' && path === '/api/add-url') {
      const body = await readBody(req);
      const ingestImpl = deps.ingestUrlFn ?? ingestUrl;
      const result = await ingestImpl({ config, db, logger, url: body.url, deps });
      refreshTracker();
      return sendJson(res, 200, result);
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
        const body = await readBody(req);
        const result = markSubmittedByHuman(db, jobId, {
          now: nowDate(),
          confirmationNumber: body.confirmationNumber,
          note: body.note,
        });
        refreshTracker();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'note') {
        const body = await readBody(req);
        const result = setJobNote(db, jobId, body.note);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'assist') {
        return sendJson(res, 202, await startAssist(jobId));
      }
      // One-click end-to-end: prepare (if needed) -> approve -> fill; submits
      // only when the body explicitly opts in. Same orchestration as the batch.
      if (req.method === 'POST' && action === 'auto-apply') {
        const body = await readBody(req);
        return sendJson(res, 202, startAssistBatch([jobId], { autoSubmit: body.autoSubmit === true }));
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

/** Minimal MIME map for the bundled SPA assets. */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Serve a static file from PUBLIC_DIR. Defends against path traversal by
 * resolving the request and rejecting anything that escapes PUBLIC_DIR
 * (OWASP A01/A03). Returns 404 for missing files, 403 for escapes.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} urlPath request pathname (e.g. "/assets/js/app.js")
 */
function serveStatic(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); }
  catch { rel = urlPath; }
  const abs = normalize(join(PUBLIC_DIR, rel));
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  let buf;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      return sendJson(res, 404, { error: `not found: ${urlPath}` });
    }
    throw err;
  }
  const type = MIME_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(buf);
}

/** Read and parse a JSON request body (empty body -> {}). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > 1_000_000) {
        tooLarge = true;
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy(); // stop buffering — the promise is already settled
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(Object.assign(new Error('invalid JSON body'), { statusCode: 400 })); }
    });
    req.on('error', (err) => { if (!tooLarge) reject(err); });
  });
}
