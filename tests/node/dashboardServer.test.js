/**
 * Dashboard HTTP server tests — boot on an ephemeral 127.0.0.1 port, exercise
 * the JSON API end to end against an in-memory db. No network beyond loopback.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard, installProcessSafetyNet } from '../../src/dashboard/server.js';

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

function eligiblePacket(url = 'http://a') {
  return {
    id: 'pk-j1',
    job: { id: 'j1', url },
    ats: { platform: 'greenhouse' },
    blockers: [],
    resumePath: '/docs/tailored-resume.docx',
    prefill: { plan: [], needsUser: [] },
    screeningPlan: { answered: [], needsUser: [] },
    uploads: { blockers: [] },
    stopBeforeSubmit: true,
  };
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
        assistFn: async ({ options }) => (options?.autoSubmit
          // Mirrors the real runner contract: submitted:true is ONLY ever
          // reported together with a positive post-submit verification.
          ? { status: 'submitted', submitted: true, blockers: [],
              submitVerification: { verified: true, signals: ['confirmation message'] } }
          : { status: 'ready_for_submit', blockers: [] }),
        loadPacketImpl: () => eligiblePacket(),
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

  it('approve -> assist stops before submit; submission needs positive evidence', async () => {
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

    const pending = await post('/api/jobs/j1/mark-submitted');
    expect(pending.body.appStatus).toBe('submit_unverified');
    expect(Number(db.getJob('j1').applied)).toBe(0);

    const done = await post('/api/jobs/j1/mark-submitted', {
      verified: true, confirmationNumber: 'confirmation page shown',
    });
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

  it('reports live per-source discovery progress and preserves source timings', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    await dash.close();
    dash = await startDashboard({
      config: {
        jobboards: { sources: [
          { id: 'greenhouse-boards', adapter: 'greenhouse', enabled: true, priority: 1 },
          { id: 'workday-public', adapter: 'workday', enabled: true, priority: 2 },
        ] },
      },
      db, logger: null, port: 0,
      deps: {
        discoverFn: async ({ searchHooks }) => {
          searchHooks.onSource({ phase: 'start', source: 'greenhouse-boards', adapter: 'greenhouse' });
          await gate;
          searchHooks.onSource({ phase: 'end', source: 'greenhouse-boards', adapter: 'greenhouse', found: 3, errors: 0, durationMs: 12 });
          searchHooks.onSource({ phase: 'cancelled', source: 'workday-public', adapter: 'workday', found: 0, errors: 0, durationMs: 0 });
          return { counters: { jobs_found: 3 }, perSource: [
            { source: 'greenhouse-boards', adapter: 'greenhouse', found: 3, errors: 0, durationMs: 12 },
            { source: 'workday-public', adapter: 'workday', found: 0, errors: 0, durationMs: 0, cancelled: true },
          ], cancelled: true };
        },
      },
    });
    await post('/api/run', { phase: 'discover' });
    const live = (await get('/api/run/status')).body;
    expect(live.progress).toMatchObject({ kind: 'sources', total: 2, completed: 0, currentSource: 'greenhouse-boards' });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const done = (await get('/api/run/status')).body;
    expect(done.progress).toMatchObject({ total: 2, completed: 2, currentSource: null });
    expect(done.lastResult.cancelled).toBe(true);
    expect(done.lastResult.perSource[0]).toMatchObject({ source: 'greenhouse-boards', durationMs: 12 });
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

describe('dashboard batch actions + CSV export', () => {
  let db;
  let dash;
  let trackerWrites;
  const get = (p) => fetch(dash.url + p);
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    seed(db);
    trackerWrites = 0;
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        assistFn: async ({ options }) => (options?.autoSubmit
          // Mirrors the real runner contract: submitted:true is ONLY ever
          // reported together with a positive post-submit verification.
          ? { status: 'submitted', submitted: true, blockers: [],
              submitVerification: { verified: true, signals: ['confirmation message'] } }
          : { status: 'ready_for_submit', blockers: [] }),
        loadPacketImpl: () => eligiblePacket(),
        // Avoid touching the real filesystem in tests.
        writeJobTrackerImpl: () => { trackerWrites += 1; return { path: '/fake/root/data/job_tracker.csv' }; },
        readTextImpl: () => 'Company,Job Role\nAcme,Senior Data Engineer',
      },
    });
  });
  afterEach(async () => { await dash.close(); db.close(); });

  it('refreshes the tracker CSV after a human-gated action', async () => {
    await post('/api/jobs/j1/approve');
    expect(trackerWrites).toBeGreaterThan(0);
  });

  it('GET /api/export/tracker.csv streams the spreadsheet as an attachment', async () => {
    const res = await get('/api/export/tracker.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('job_tracker.csv');
    expect(await res.text()).toContain('Company,Job Role');
  });

  it('approve-batch approves prepared packets and reports the rest', async () => {
    const r = await post('/api/approve-batch', { jobIds: ['j1', 'j2'] });
    expect(r.status).toBe(200);
    expect(r.body.approved).toEqual(['j1']);     // j1 has a packet
    expect(r.body.failed.map((f) => f.jobId)).toEqual(['j2']); // j2 has none
    expect(db.getApprovalByJob('j1').approval_status).toBe('approved');
  });

  it('previews Auto-Apply eligibility without mutating jobs or approvals', async () => {
    const before = db.getApprovalByJob('j1').approval_status;
    const r = await post('/api/auto-apply/eligibility', {
      jobIds: ['j1', 'j2'], autoSubmit: true,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ total: 2, eligible: 1, ineligible: 1, autoSubmitAuthorized: true });
    expect(r.body.items.find((x) => x.jobId === 'j1')).toMatchObject({ eligible: true, ats: 'greenhouse' });
    expect(r.body.items.find((x) => x.jobId === 'j2').reasons.join(' ')).toMatch(/Prepare|Sponsorship|ATS/);
    expect(db.getApprovalByJob('j1').approval_status).toBe(before);
    expect(Number(db.getJob('j1').applied)).toBe(0);
  });

  it('auto-apply orchestrates prepare -> approve -> fill and never submits', async () => {
    // j1 has a packet awaiting review (NOT pre-approved); j2 has no packet and
    // no preparable config in this test env. One click must handle both
    // honestly: fill j1 end-to-end, report j2 as skipped with a reason.
    const r = await post('/api/assist-batch', { jobIds: ['j1', 'j2'] });
    expect(r.status).toBe(202);
    expect(r.body.queued).toBe(2);
    await new Promise((res) => setTimeout(res, 60));
    const run = (await fetch(dash.url + '/api/run/status').then((x) => x.json()));
    expect(run.running).toBe(false);
    expect(run.lastResult.phase).toBe('assist-batch');
    // The click IS the approval — j1 was auto-approved and filled.
    expect(db.getApprovalByJob('j1').approval_status).toBe('approved');
    expect(run.lastResult.results.map((x) => x.jobId)).toEqual(['j1']);
    expect(run.lastResult.skipped.map((s) => s.jobId)).toContain('j2');
    expect(Number(db.getJob('j1').applied)).toBe(0); // auto-apply NEVER submits
  });

  it('auto-apply rejects an empty selection; unpreparable jobs are skipped, not 400s', async () => {
    expect((await post('/api/assist-batch', { jobIds: [] })).status).toBe(400);
    const r = await post('/api/assist-batch', { jobIds: ['j2'] });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 60));
    const run = await fetch(dash.url + '/api/run/status').then((x) => x.json());
    expect(run.lastResult.skipped.map((s) => s.jobId)).toEqual(['j2']);
    expect(run.lastResult.results).toEqual([]);
  });

  it('POST /api/jobs/:id/auto-apply runs the full chain for one job', async () => {
    const r = await post('/api/jobs/j1/auto-apply');
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 60));
    expect(db.getApprovalByJob('j1').approval_status).toBe('approved');
    const run = await fetch(dash.url + '/api/run/status').then((x) => x.json());
    expect(run.lastResult.results[0]).toMatchObject({ jobId: 'j1', status: 'ready_for_submit' });
    expect(Number(db.getJob('j1').applied)).toBe(0);
  });

  it('auto-apply submits ONLY with the explicit per-run autoSubmit opt-in', async () => {
    // Without the flag: fills and stops (asserted above). With it: submitted.
    const r = await post('/api/jobs/j1/auto-apply', { autoSubmit: true });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 60));
    const job = db.getJob('j1');
    expect(Number(job.applied)).toBe(1);
    expect(job.status).toBe('submitted');
    const run = await fetch(dash.url + '/api/run/status').then((x) => x.json());
    expect(run.lastResult.results[0]).toMatchObject({ jobId: 'j1', submitted: true });
  });

  it('reconciles a stale packet URL to the live DB job URL before assisting', async () => {
    // The packet was prepared with an old aggregator link; the DB now holds the
    // refreshed direct company URL the user sees on the board.
    await dash.close();
    db.upsertJob({ id: 'j1', url: 'https://jobs.company.com/apply/42' });
    let navigatedUrl = null;
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        loadPacketImpl: () => eligiblePacket('https://www.indeed.com/viewjob?jk=stale'),
        assistFn: async ({ packet }) => { navigatedUrl = packet.job.url; return { status: 'ready_for_submit', blockers: [] }; },
        writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }),
      },
    });
    await post('/api/jobs/j1/approve');
    await post('/api/assist-batch', { jobIds: ['j1'] });
    await new Promise((res) => setTimeout(res, 30));
    expect(navigatedUrl).toBe('https://jobs.company.com/apply/42'); // live URL, not the stale packet one
  });

  it('a failing assistFn never crashes the batch and always clears the busy lock', async () => {
    // Regression: a thrown background error must be captured (status "failed"),
    // the run must finish (running=false), and the server must stay reachable —
    // otherwise the UI would only ever see "Failed to fetch".
    await dash.close();
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        loadPacketImpl: () => eligiblePacket(),
        assistFn: async () => { throw new Error('browser blew up'); },
        writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }),
      },
    });
    await post('/api/jobs/j1/approve');
    const r = await post('/api/assist-batch', { jobIds: ['j1'] });
    expect(r.status).toBe(202);
    await new Promise((res) => setTimeout(res, 30));
    const run = await fetch(dash.url + '/api/run/status').then((x) => x.json());
    expect(run.running).toBe(false);                 // busy lock released
    expect(run.lastResult.results[0].status).toBe('failed');
    expect(run.lastResult.results[0].error).toContain('browser blew up');
    // Server still alive: a follow-up request succeeds.
    expect((await fetch(dash.url + '/api/stats')).status).toBe(200);
  });
});

describe('installProcessSafetyNet', () => {
  // A minimal fake "process" so we never register handlers on the real one.
  function fakeProc() {
    const handlers = {};
    return {
      on(event, fn) { (handlers[event] ??= []).push(fn); },
      off(event, fn) { handlers[event] = (handlers[event] ?? []).filter((h) => h !== fn); },
      emit(event, arg) { for (const h of handlers[event] ?? []) h(arg); },
      count(event) { return (handlers[event] ?? []).length; },
    };
  }

  it('records background errors on runState instead of crashing the process', () => {
    const runState = { lastError: null };
    const proc = fakeProc();
    installProcessSafetyNet({ runState, proc });
    proc.emit('unhandledRejection', new Error('window closed by user'));
    expect(runState.lastError).toContain('window closed by user');
    expect(runState.lastError).toContain('server still up');
    proc.emit('uncaughtException', new Error('transport EPIPE'));
    expect(runState.lastError).toContain('transport EPIPE');
  });

  it('uninstall removes the handlers so tests never leak globals', () => {
    const proc = fakeProc();
    const uninstall = installProcessSafetyNet({ runState: {}, proc });
    expect(proc.count('unhandledRejection')).toBe(1);
    expect(proc.count('uncaughtException')).toBe(1);
    uninstall();
    expect(proc.count('unhandledRejection')).toBe(0);
    expect(proc.count('uncaughtException')).toBe(0);
  });

  it('tolerates a missing runState (logger-only mode)', () => {
    const proc = fakeProc();
    const logs = [];
    installProcessSafetyNet({ logger: { error: (m) => logs.push(m) }, proc });
    expect(() => proc.emit('unhandledRejection', new Error('boom'))).not.toThrow();
    expect(logs[0]).toContain('boom');
  });
});

describe('command-center endpoints (sections, notes, export, decide-batch)', () => {
  let db;
  let dash;
  const get = (p) => fetch(dash.url + p);
  const getJson = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    seed(db);
    db.upsertJob({ id: 'blk', company: 'Wall Co', title: 'DE', url: 'http://w', score: 80, tier: 'Apply',
      status: 'assist_blocked', assist_blockers: ['login required'] });
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: { now: () => NOW, writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }) },
    });
  });
  afterEach(async () => { await dash.close(); db.close(); });

  it('GET /api/sections returns curated sections + counts', async () => {
    const { status, body } = await getJson('/api/sections');
    expect(status).toBe(200);
    expect(body.counts).toBeDefined();
    expect(body.counts.needsReview).toBe(1);          // j1 has a pending packet
    expect(body.counts.blocked).toBe(1);              // blk
    expect(body.blockedByReason[0].reason).toBe('Login / account required');
  });

  it('GET /api/export/jobs.csv streams a rich CSV attachment', async () => {
    const res = await get('/api/export/jobs.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('jobagent_jobs.csv');
    const text = await res.text();
    expect(text).toContain('Company,Role');
    expect(text).toContain('Grade');
  });

  it('POST /api/jobs/:id/note saves a note and rejects unknown ids', async () => {
    const ok = await post('/api/jobs/j1/note', { note: 'call recruiter' });
    expect(ok.status).toBe(200);
    expect(ok.body.notes).toBe('call recruiter');
    expect(db.getJob('j1').notes).toBe('call recruiter');
    expect((await post('/api/jobs/ghost/note', { note: 'x' })).status).toBe(404);
  });

  it('POST /api/decide-batch applies a triage decision to many jobs', async () => {
    const r = await post('/api/decide-batch', { jobIds: ['j1', 'j2'], decision: 'shortlisted' });
    expect(r.status).toBe(200);
    expect(r.body.updated.sort()).toEqual(['j1', 'j2']);
    expect(db.getJob('j1').user_decision).toBe('shortlisted');
    expect(db.getJob('j2').user_decision).toBe('shortlisted');
  });

  it('POST /api/decide-batch reports invalid decisions per job without 500ing', async () => {
    const r = await post('/api/decide-batch', { jobIds: ['j1'], decision: 'banana' });
    expect(r.status).toBe(200);
    expect(r.body.updated).toEqual([]);
    expect(r.body.failed[0].error).toMatch(/invalid decision/);
  });

  it('POST /api/add-url ingests a pasted job (via injected ingest impl) and refreshes the tracker', async () => {
    await dash.close();
    let received = null;
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }),
        ingestUrlFn: async ({ url }) => {
          received = url;
          return { id: 'ext1', company: 'Microsoft', title: 'Senior Data Engineer', url, score: 82, tier: 'Apply', appStatusHint: 'scored' };
        },
      },
    });
    const r = await post('/api/add-url', { url: 'https://careers.microsoft.com/jobs/123' });
    expect(r.status).toBe(200);
    expect(received).toBe('https://careers.microsoft.com/jobs/123');
    expect(r.body).toMatchObject({ company: 'Microsoft', tier: 'Apply', score: 82 });
  });

  it('POST /api/add-url surfaces a blocked-page error with its status code', async () => {
    await dash.close();
    dash = await startDashboard({
      config: { root: '/fake/root' }, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        writeJobTrackerImpl: () => ({ path: '/fake/root/data/job_tracker.csv' }),
        ingestUrlFn: async () => { throw Object.assign(new Error('could not read that page (HTTP 403)'), { statusCode: 422 }); },
      },
    });
    const r = await post('/api/add-url', { url: 'https://blocked.example.com/x' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/could not read that page/);
  });
});

describe('reports, prepare-selected, and submission-record endpoints', () => {
  let db;
  let dash;
  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'p1', company: 'Acme', title: 'Sr DE', url: 'http://a', source: 'greenhouse',
      score: 88, tier: 'Priority', sponsorship: 'Confirmed', status: 'ready_for_submit',
      application_packet_path: '/p/p1.json',
    });
    db.upsertJob({ id: 'p2', company: 'Globex', title: 'DE', url: 'http://b', source: 'ashby', score: 70, tier: 'Queue' });
    dash = await startDashboard({
      config: {}, db, logger: null, port: 0,
      deps: {
        now: () => NOW,
        prepareForJobsFn: async ({ jobIds }) => ({
          prepared: jobIds.map((jobId) => ({ jobId, packetPath: `/p/${jobId}.json` })),
          failed: [],
        }),
      },
    });
  });
  afterEach(async () => { await dash.close(); db.close(); });

  it('GET /api/reports returns the full reports bundle', async () => {
    const { status, body } = await get('/api/reports');
    expect(status).toBe(200);
    expect(body.dailySummary.daily).toHaveLength(7);
    expect(Array.isArray(body.applicationLog)).toBe(true);
    expect(Array.isArray(body.sourcePerformance)).toBe(true);
    expect(body.sourcePerformance.find((s) => s.source === 'greenhouse')).toBeDefined();
  });

  it('POST /api/prepare-batch prepares the selected jobs asynchronously', async () => {
    const started = await post('/api/prepare-batch', { jobIds: ['p2'] });
    expect(started.status).toBe(202);
    await new Promise((r) => setTimeout(r, 20));
    const s = (await get('/api/run/status')).body;
    expect(s.running).toBe(false);
    expect(s.lastResult).toMatchObject({ phase: 'prepare-selected', counters: { jobs_prepared: 1 } });
    expect((await post('/api/prepare-batch', {})).status).toBe(400); // no ids
  });

  it('mark-submitted accepts a confirmation number and note', async () => {
    const r = await post('/api/jobs/p1/mark-submitted', {
      confirmationNumber: 'REQ-9', note: 'submitted via Greenhouse',
    });
    expect(r.status).toBe(200);
    expect(r.body.confirmationNumber).toBe('REQ-9');
    const job = db.getJob('p1');
    expect(job.submitted_confirmation).toBe('REQ-9');
    expect(job.notes).toContain('submitted via Greenhouse');
    expect(Number(job.applied)).toBe(1);
  });

  it('GET /api/jobs supports the ATS filter', async () => {
    db.upsertJob({ id: 'p1', ats_platform: 'greenhouse' });
    const { body } = await get('/api/jobs?ats=greenhouse');
    expect(body.jobs.map((j) => j.id)).toEqual(['p1']);
  });
});

describe('static assets + /learn interview-prep mini-site', () => {
  let db;
  let dash;

  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    dash = await startDashboard({ config: {}, db, logger: null, port: 0, deps: { now: () => NOW } });
  });
  afterEach(async () => {
    await dash.close();
    db.close();
  });

  it('redirects /learn -> /learn/ so the SPA relative asset URLs resolve', async () => {
    const res = await fetch(dash.url + '/learn', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/learn/');
  });

  it('serves the interview academy shell at /learn/', async () => {
    const res = await fetch(dash.url + '/learn/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Interview Academy');
  });

  it('serves /learn assets with the right content-types', async () => {
    const css = await fetch(dash.url + '/learn/assets/css/style.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');

    const js = await fetch(dash.url + '/learn/assets/js/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
  });

  it('404s a missing static asset', async () => {
    expect((await fetch(dash.url + '/learn/assets/js/does-not-exist.js')).status).toBe(404);
  });

  it('never serves files outside the public dir via traversal', async () => {
    // Encoded slashes (%2f) keep the "../../" from being collapsed by fetch, so
    // the request reaches serveStatic and its guard rejects the escape. Either
    // way (guard 403 or unmatched 404), the server source must never leak.
    const res = await fetch(dash.url + '/assets/..%2f..%2fserver.js');
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain('createDashboardServer');
  });

  it('the dashboard shell links to the interview academy', async () => {
    const html = await fetch(dash.url + '/').then((r) => r.text());
    expect(html).toContain('/learn/');
    expect(html).toContain('Interview Prep');
  });
});
