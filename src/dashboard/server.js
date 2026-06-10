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
import { runDiscover, runScore, runPrepareApps, loadPacket } from '../cli/commands.js';
import { assistApply } from '../automation/applyRunner.js';
import { APPROVAL_STATUS } from '../apply/approvalQueue.js';

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
    const packet = deps.loadPacketImpl ? deps.loadPacketImpl(approval) : loadPacket(approval);
    if (!packet) {
      const err = new Error(`packet file unreadable for job ${jobId}`);
      err.statusCode = 500;
      throw err;
    }
    Object.assign(runState, {
      running: true, phase: `assist:${jobId}`, startedAt: new Date().toISOString(),
      finishedAt: null, lastError: null,
    });
    (async () => {
      try {
        const result = await assistFn({ packet, config, mode: 'LIVE_ASSIST', approval, options: {}, deps });
        db.upsertJob({ id: jobId, status: result.status });
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
    if (req.method === 'POST' && path === '/api/run') {
      const body = await readBody(req);
      if (!RUN_PHASES.has(body.phase)) {
        return sendJson(res, 400, { error: `phase must be one of: ${[...RUN_PHASES].join(', ')}` });
      }
      return sendJson(res, 202, await startRun(body.phase));
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
        return sendJson(res, 200, applyDecision(db, jobId, body.decision));
      }
      if (req.method === 'POST' && action === 'approve') {
        return sendJson(res, 200, approveJobPacket(db, jobId));
      }
      if (req.method === 'POST' && action === 'reject-packet') {
        return sendJson(res, 200, rejectJobPacket(db, jobId));
      }
      if (req.method === 'POST' && action === 'mark-submitted') {
        return sendJson(res, 200, markSubmittedByHuman(db, jobId, { now: nowDate() }));
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
  const { server } = createDashboardServer({ config, db, logger, deps });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only — the dashboard must never be reachable from the network.
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        server,
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
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
