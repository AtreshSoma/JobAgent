/**
 * Dashboard server: request hygiene, static caching, run bookkeeping and the
 * UX-support contracts (/api/today, /api/sections?only, /api/runs, decisions).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { openDatabase } from '../../src/logging/db.js';
import { JobLogger } from '../../src/logging/jobLogger.js';
import { startDashboard, runSummary } from '../../src/dashboard/server.js';
import { acquireRunLock } from '../../src/utils/runLock.js';

const NOW = new Date('2026-09-22T15:00:00.000Z');
const JSON_HEADERS = { 'content-type': 'application/json' };

describe('dashboard server — hardening and contracts', () => {
  let db;
  let dash;
  let root;
  const get = (p, headers = {}) => fetch(dash.url + p, { headers });
  const postJson = (p, body) => fetch(dash.url + p, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) });
  const waitIdle = async () => {
    for (let i = 0; i < 80; i += 1) {
      const s = await (await get('/api/run/status')).json();
      if (!s.running) return s;
      await new Promise((r) => { setTimeout(r, 25); });
    }
    throw new Error('run did not finish');
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'jobagent-hardening-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    db = openDatabase({ path: ':memory:' });
    db.onWarning = () => {};
    db.upsertJob({ id: 'ready', title: 'R', company: 'Acme', status: 'ready_for_submit', score: 90, tier: 'Priority' });
    db.upsertJob({ id: 'sub', title: 'S', status: 'submitted', applied: 1, applied_at: NOW.toISOString(), score: 70 });
    db.upsertJob({ id: 'pending', title: 'P', status: 'prepared', score: 80, tier: 'Apply' });
    db.insertApproval({ id: 'ap-p', job_id: 'pending', approval_status: 'pending_review' });
    db.upsertJob({ id: 'approved', title: 'A', status: 'prepared', score: 75, tier: 'Apply' });
    db.insertApproval({ id: 'ap-a', job_id: 'approved', approval_status: 'approved' });
    db.upsertJob({ id: 'weird', title: 'W', status: 'scored', score: 60, resume_docx_path: join(root, 'data', 'x.db') });
    writeFileSync(join(root, 'data', 'x.db'), 'secret');
    const logger = new JobLogger({ db, logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } }, runId: 'session' });
    dash = await startDashboard({
      config: { root }, db, logger, port: 0,
      deps: {
        now: () => NOW,
        extensionKey: 'k'.repeat(32),
        runLock: true,
        discoverFn: async ({ logger: runLogger }) => {
          // What the real pipeline does at its end: endRun on the logger it was given.
          runLogger.endRun({ jobs_found: 5, jobs_new: 3, jobs_discarded_stale: 2 });
          return { counters: { jobs_found: 5, jobs_new: 3, jobs_discarded_stale: 2 }, errors: [], perSource: [{ source: 'lever', found: 5 }] };
        },
      },
    });
  });

  afterEach(async () => {
    await dash.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('CSRF: a mutation needs JSON or X-Job-Agent: 1', async () => {
    const form = await fetch(`${dash.url}/api/jobs/ready/note`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"note":"x"}',
    });
    expect(form.status).toBe(403);
    const withHeader = await fetch(`${dash.url}/api/jobs/ready/note`, {
      method: 'POST', headers: { 'x-job-agent': '1', 'content-type': 'text/plain' }, body: '{"note":"x"}',
    });
    expect(withHeader.status).toBe(200);
    expect((await postJson('/api/jobs/ready/note', { note: 'y' })).status).toBe(200);
  });

  it('a malformed percent-escape is a 400, not a 500', async () => {
    expect((await get('/api/jobs/%E0%A4')).status).toBe(400);
    expect((await get('/assets/%E0%A4.js')).status).toBe(400);
  });

  it('static assets: ETag + no-cache, 304 on If-None-Match, gzip, and HEAD without a body', async () => {
    const first = await get('/assets/js/main.js', { 'accept-encoding': 'gzip' });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-cache');
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^".+"$/);
    expect(first.headers.get('content-encoding')).toBe('gzip');
    await first.arrayBuffer();
    const again = await get('/assets/js/main.js', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    const head = await fetch(`${dash.url}/assets/js/main.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(etag);
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    // API responses stay no-store.
    expect((await get('/api/stats')).headers.get('cache-control')).toBe('no-store');
  });

  it('large JSON is gzipped when accepted', async () => {
    for (let i = 0; i < 400; i += 1) db.upsertJob({ id: `bulk${i}`, title: 'x'.repeat(100), status: 'scored', score: 50, tier: 'Queue' });
    const res = await fetch(`${dash.url}/api/jobs?limit=500`, { headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    // fetch transparently decompresses; the header proves it was compressed.
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect((await res.json()).jobs.length).toBeGreaterThan(100);
    expect(typeof gunzipSync).toBe('function');
  });

  it('S7c: the extension result route rejects unknown, submitted and unapproved jobs', async () => {
    const send = (id) => fetch(`${dash.url}/api/extension/jobs/${id}/result`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-job-agent-key': 'k'.repeat(32) },
      body: JSON.stringify({ formDetected: true, filled: [{ field: 'name' }], readyForReview: true }),
    });
    expect((await send('nope')).status).toBe(404);
    expect((await send('sub')).status).toBe(409);
    expect(db.getJob('sub')).toMatchObject({ status: 'submitted', applied: 1 });
    expect((await send('pending')).status).toBe(409);
    const ok = await send('approved');
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe('ready_for_submit');
  });

  it('resume preview refuses a stored path that is not a PDF/DOCX', async () => {
    expect((await get('/api/jobs/weird/resume?format=docx')).status).toBe(422);
  });

  it('A1/A5 + P9b: a run records under its own id with every counter; /api/runs summarises it', async () => {
    expect((await postJson('/api/run', { phase: 'discover' })).status).toBe(202);
    await waitIdle();
    const { runs } = await (await get('/api/runs')).json();
    expect(runs).toHaveLength(1); // no phantom mode='unknown' row for the session id
    expect(runs[0]).toMatchObject({
      mode: 'discover', errorCount: 0,
      perSource: [{ source: 'lever', found: 5 }],
    });
    expect(runs[0].counters).toMatchObject({ jobs_found: 5, jobs_new: 3, jobs_discarded_stale: 2 });
    expect(typeof runs[0].durationMs).toBe('number');
    expect(runs[0].startedAt).toBeTruthy();
    expect(runs[0].endedAt).toBeTruthy();
    expect(db.getRunLog('session')).toBeNull();
    const clamped = await (await get('/api/runs?limit=5000')).json();
    expect(clamped.runs.length).toBeLessThanOrEqual(100);
  });

  it('P10: a run held by another process answers 409 with the holder', async () => {
    const other = acquireRunLock({ root, owner: 'cli', phase: 'watch', deps: { pid: process.pid } });
    const res = await postJson('/api/run', { phase: 'discover' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.holder).toMatchObject({ owner: 'cli', phase: 'watch' });
    other.release();
  });

  it('A1: GET /api/today and /api/sections?only=', async () => {
    const today = await (await get('/api/today')).json();
    expect(today.items[0]).toMatchObject({ id: 'ready', nextAction: { kind: 'submit' } });
    expect(Array.isArray(today.systemNotices)).toBe(true);
    const only = await (await get('/api/sections?only=readyForSubmit')).json();
    expect(Object.keys(only)).toEqual(['readyForSubmit']);
    expect((await get('/api/sections?only=nope')).status).toBe(400);
  });

  it('A2: decision with a reason, then a single-job undo', async () => {
    const decided = await (await postJson('/api/jobs/ready/decision', { decision: 'rejected', reason: 'salary', reasonNote: 'too low' })).json();
    expect(decided).toMatchObject({ userDecision: 'rejected', decisionReason: 'salary' });
    expect((await postJson('/api/jobs/ready/decision', { decision: 'rejected', reason: 'vibes' })).status).toBe(400);
    const detail = await (await get('/api/jobs/ready')).json();
    expect(detail).toMatchObject({ decisionReason: 'salary', decisionReasonNote: 'too low' });
    const undone = await (await postJson('/api/jobs/ready/undo-decision')).json();
    expect(undone).toMatchObject({ userDecision: null, decisionReason: null, undone: true });
    expect((await postJson('/api/jobs/ready/undo-decision')).status).toBe(409);
  });

  it('S7a over HTTP: marking a submitted job again never un-submits it', async () => {
    const r = await (await postJson('/api/jobs/sub/mark-submitted', { verified: false, note: 'again' })).json();
    expect(r).toMatchObject({ appStatus: 'submitted', alreadySubmitted: true });
    expect(db.getJob('sub').applied).toBe(1);
  });

  it('runSummary counts RCA errors', () => {
    expect(runSummary({ run_id: 'x', errors: JSON.stringify([{ count: 3 }, {}]) }).errorCount).toBe(4);
    expect(runSummary({ run_id: 'x', errors: 'boom' }).errorCount).toBe(1);
  });
});
