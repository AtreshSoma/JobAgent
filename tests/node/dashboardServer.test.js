/**
 * Dashboard HTTP server tests — boot on an ephemeral 127.0.0.1 port, exercise
 * the JSON API end to end against an in-memory db. No network beyond loopback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';

const NOW = new Date('2026-06-04T12:00:00Z');

function seed(db) {
  db.upsertJob({
    id: 'j1', company: 'Acme', title: 'Senior Data Engineer', url: 'http://a',
    source: 'greenhouse', score: 90, tier: 'Priority', sponsorship: 'Confirmed',
    status: 'prepared', posted_at: '2026-06-04T01:00:00Z',
    application_packet_path: '/p/j1.json', created_at: '2026-06-04T02:00:00Z',
  });
  db.insertApproval({ id: 'ap1', job_id: 'j1', packet_path: '/p/j1.json', approval_status: 'pending_review' });
  db.upsertJob({ id: 'j2', company: 'Globex', title: 'BI Engineer', url: 'http://b', source: 'ashby', score: 60, tier: 'Queue' });
}

describe('dashboard server API', () => {
  let db;
  let dash;
  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    seed(db);
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        readFileImpl: () => JSON.stringify({
          id: 'pk', ats: { platform: 'greenhouse' }, blockers: [],
          prefill: { plan: [], needsUser: [] }, stopBeforeSubmit: true, submitReady: false,
        }),
        // Runner stubs: no real search/scoring in server tests.
        discoverFn: async () => ({ counters: { jobs_found: 5 } }),
        scoreFn: async () => ({ counters: { jobs_scored: 3 } }),
        prepareFn: async () => ({ counters: { jobs_prepared: 1 } }),
        assistFn: async () => ({ status: 'ready_for_submit', blockers: [] }),
        loadPacketImpl: () => ({ job: { id: 'j1', url: 'http://a' }, blockers: [] }),
      },
    });
  });
  afterEach(async () => {
    await dash.close();
    db.close();
  });

  it('serves the UI shell at /', async () => {
    const res = await fetch(dash.url + '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('JobAgent — Dashboard');
  });

  it('binds to 127.0.0.1 only', () => {
    expect(dash.server.address().address).toBe('127.0.0.1');
  });

  it('GET /api/stats returns tiles and breakdowns', async () => {
    const { status, body } = await get('/api/stats');
    expect(status).toBe(200);
    expect(body.totals.jobsTracked).toBe(2);
    expect(body.totals.pendingReview).toBe(1);
    expect(body.bySource.greenhouse.found).toBe(1);
  });

  it('GET /api/jobs filters and GET /api/jobs/:id returns detail with packet', async () => {
    const { body } = await get('/api/jobs?fit=strong');
    expect(body.jobs.map((j) => j.id)).toEqual(['j1']);
    const detail = await get('/api/jobs/j1');
    expect(detail.status).toBe(200);
    expect(detail.body.packet.ats.platform).toBe('greenhouse');
    expect(detail.body.packet.submitReady).toBe(false);
    expect((await get('/api/jobs/ghost')).status).toBe(404);
  });

  it('decision endpoint validates and persists', async () => {
    expect((await post('/api/jobs/j2/decision', { decision: 'shortlisted' })).body.appStatus).toBe('shortlisted');
    expect((await post('/api/jobs/j2/decision', { decision: 'nope' })).status).toBe(400);
    expect((await post('/api/jobs/ghost/decision', { decision: 'shortlisted' })).status).toBe(404);
    expect((await post('/api/jobs/j2/decision', 'not json{{')).status).toBe(400);
  });

  it('approve -> assist -> stops before submit; mark-submitted is explicit', async () => {
    expect((await post('/api/jobs/j2/approve')).status).toBe(409); // no packet
    expect((await post('/api/jobs/j1/assist')).status).toBe(400);  // not approved yet
    expect((await post('/api/jobs/j1/approve')).body.status).toBe('approved');

    const assist = await post('/api/jobs/j1/assist');
    expect(assist.status).toBe(202);
    expect(assist.body.note).toContain('stop before submit');
    await new Promise((r) => setTimeout(r, 20)); // let the async assist settle
    const run = (await get('/api/run/status')).body;
    expect(run.running).toBe(false);
    expect(run.lastResult).toMatchObject({ phase: 'assist', jobId: 'j1', status: 'ready_for_submit' });
    expect(db.getJob('j1').status).toBe('ready_for_submit');
    expect(Number(db.getJob('j1').applied)).toBe(0); // assist NEVER submits

    const done = await post('/api/jobs/j1/mark-submitted');
    expect(done.body.appStatus).toBe('submitted');
    expect(Number(db.getJob('j1').applied)).toBe(1);
  });

  it('POST /api/run validates phase, runs async, and rejects concurrent runs', async () => {
    expect((await post('/api/run', { phase: 'submit' })).status).toBe(400);
    const started = await post('/api/run', { phase: 'discover' });
    expect(started.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const s = (await get('/api/run/status')).body;
    expect(s.running).toBe(false);
    expect(s.lastResult).toMatchObject({ phase: 'discover', counters: { jobs_found: 5 } });
  });

  it('409s when a run is already in progress', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await dash.close();
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: { now: () => NOW, scoreFn: () => gate.then(() => ({ counters: {} })) },
    });
    expect((await post('/api/run', { phase: 'score' })).status).toBe(202);
    expect((await post('/api/run', { phase: 'score' })).status).toBe(409);
    expect((await post('/api/jobs/j1/assist')).status).toBe(409); // assist also gated
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect((await get('/api/run/status')).body.running).toBe(false);
  });

  it('unknown routes 404 with JSON', async () => {
    const r = await get('/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error).toContain('no route');
  });

  it('a crashing pipeline run is captured, not fatal', async () => {
    await dash.close();
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: { now: () => NOW, prepareFn: async () => { throw new Error('boom'); } },
    });
    await post('/api/run', { phase: 'prepare' });
    await new Promise((r) => setTimeout(r, 20));
    const s = (await get('/api/run/status')).body;
    expect(s.running).toBe(false);
    expect(s.lastError).toContain('prepare failed: boom');
    // Server still serves requests after the failure.
    expect((await get('/api/stats')).status).toBe(200);
  });
});
