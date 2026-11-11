/**
 * P1A — the dashboard's data-quality, settings and description-fetching API.
 * Enrichment itself is stubbed (enrichment.test.js covers it); this asserts the
 * wiring: opt-in, progress, stop, never during a search, settings validation
 * and the re-check after a freshness change.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { readUserSettings, applyUserSettings, settingsPath } from '../../src/config/userSettings.js';
import { loadTestConfig } from './helpers/testConfig.js';

const base = loadTestConfig({ loadEnv: false, env: {} });
const JSON_HEADERS = { 'content-type': 'application/json' };
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** loadConfig for a private root: the shared test config plus that root's settings. */
const loaderFor = () => ({ root }) => {
  const { settings } = readUserSettings(root);
  const applied = applyUserSettings({ runtime: base.runtime, exclusions: base.exclusions }, settings);
  return { ...base, root, runtime: applied.runtime, exclusions: applied.exclusions, settingSources: applied.sources };
};

describe('dashboard — discovery and data quality', () => {
  let root;
  let db;
  let dash;
  let enrichCalls;
  let rescoreCalls;
  let release;
  const get = async (p) => (await fetch(dash.url + p)).json();
  const post = (p, body) => fetch(dash.url + p, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body ?? {}) });

  const boot = async (deps = {}) => {
    const config = loaderFor()({ root });
    dash = await startDashboard({
      config, db, logger: null, port: 0,
      deps: {
        loadConfigImpl: loaderFor(),
        rescoreStaleImpl: () => { rescoreCalls += 1; return { rescored: 0 }; },
        runEnrichmentImpl: async ({ shouldCancel, onProgress }) => {
          enrichCalls.push({ shouldCancel });
          onProgress({ total: 2, done: 1, fetched: 1, failed: 0, nowActionable: 1 });
          await new Promise((r) => { release = r; });
          return { total: 2, done: shouldCancel() ? 1 : 2, fetched: 1, failed: 0, nowActionable: 1, stillWeak: 0, excluded: 0, gone: 0, cancelled: shouldCancel() };
        },
        ...deps,
      },
    });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jobagent-dq-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    db = openDatabase({ path: ':memory:' });
    db.onWarning = () => {};
    db.upsertJob({ id: 'a', title: 'Senior Data Engineer', status: 'scored', discovery_mode: 'profile' });
    db.upsertJob({ id: 'b', title: 'Data Engineer', status: 'discarded', discard_reason: 'stale: posted 9 day(s) ago (> 7d window)', discovery_mode: 'profile' });
    enrichCalls = [];
    rescoreCalls = 0;
    release = null;
  });

  afterEach(async () => {
    release?.();
    await dash?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
    dash = null;
  });

  it('GET /api/data-quality explains the board, the settings and the filters', async () => {
    await boot();
    const d = await get('/api/data-quality');
    expect(d.board).toMatchObject({ scored: 1 });
    expect(d.filtered).toEqual([expect.objectContaining({ key: 'outside_window', count: 1 })]);
    expect(d.freshness.rules).toHaveLength(4);
    expect(d.enrichment.settings.enabled).toBe(false);
    expect(d.enrichment.state).toMatchObject({ running: false, enabled: false });
  });

  it('POST /api/settings validates, persists, reloads and re-checks the board', async () => {
    await boot();
    const bad = await post('/api/settings', { retentionDays: 2 });
    expect(bad.status).toBe(400);
    expect(existsSync(settingsPath(root))).toBe(false);

    const ok = await post('/api/settings', { discoveryWindow: 'LAST_14_DAYS', retentionDays: 60 });
    expect(ok.status).toBe(200);
    const out = await ok.json();
    expect(out.freshness).toMatchObject({ discoveryWindow: 'LAST_14_DAYS', retentionDays: 60 });
    expect(out.freshness.sources).toEqual({ discoveryWindow: 'settings', retentionDays: 'settings' });
    expect(JSON.parse(readFileSync(settingsPath(root), 'utf8'))).toEqual({ discoveryWindow: 'LAST_14_DAYS', retentionDays: 60 });
    await wait(120);
    expect(rescoreCalls).toBe(1);

    // Turning enrichment on changes no verdict, so it triggers no re-check.
    await post('/api/settings', { enrichment: { enabled: true } });
    await wait(120);
    expect(rescoreCalls).toBe(1);
    expect((await get('/api/enrichment')).enabled).toBe(true);
  });

  it('starts a pass on request, reports progress, and stops on request', async () => {
    await boot();
    const start = await post('/api/enrichment/start');
    expect(start.status).toBe(202);
    await wait(20);
    const running = await get('/api/enrichment');
    expect(running).toMatchObject({ running: true, trigger: 'manual', progress: { done: 1, total: 2 } });
    expect((await post('/api/enrichment/start')).status).toBe(409);

    const stop = await (await post('/api/enrichment/stop')).json();
    expect(stop.stopping).toBe(true);
    expect(enrichCalls[0].shouldCancel()).toBe(true);
    release();
    await wait(20);
    const done = await get('/api/enrichment');
    expect(done.running).toBe(false);
    expect(done.last).toMatchObject({ cancelled: true, trigger: 'manual' });
  });

  it('refuses to start during a search, and a search starting mid-pass stops it', async () => {
    let finishRun;
    await boot({
      discoverFn: async () => { await new Promise((r) => { finishRun = r; }); return { counters: {}, errors: [], perSource: [] }; },
    });
    expect((await post('/api/enrichment/start')).status).toBe(202);
    await wait(20);
    expect(enrichCalls[0].shouldCancel()).toBe(false);
    expect((await post('/api/run', { phase: 'discover' })).status).toBe(202);
    await wait(20);
    expect(enrichCalls[0].shouldCancel()).toBe(true);
    release();
    await wait(20);
    const refused = await post('/api/enrichment/start');
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/run is in progress/);
    finishRun();
  });
});

describe('dashboard — background description fetching is opt-in', () => {
  const saved = process.env.JOB_AGENT_ENRICHMENT;
  let root;
  let db;
  let dash;
  afterEach(async () => {
    if (saved === undefined) delete process.env.JOB_AGENT_ENRICHMENT; else process.env.JOB_AGENT_ENRICHMENT = saved;
    await dash?.close();
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  const bootWith = async (settings) => {
    delete process.env.JOB_AGENT_ENRICHMENT;
    root = mkdtempSync(join(tmpdir(), 'jobagent-dq-sched-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    if (settings) {
      const { writeUserSettings } = await import('../../src/config/userSettings.js');
      writeUserSettings(root, settings);
    }
    db = openDatabase({ path: ':memory:' });
    const calls = [];
    dash = await startDashboard({
      config: loaderFor()({ root }), db, logger: null, port: 0,
      deps: {
        enrichmentDelayMs: 1, enrichmentTickMs: 10_000,
        runEnrichmentImpl: async (args) => { calls.push(args); return { fetched: 0, failed: 0 }; },
      },
    });
    await wait(80);
    return calls;
  };

  it('does nothing in the background until the user enables it', async () => {
    expect(await bootWith(null)).toHaveLength(0);
  });

  it('runs a scheduled pass once enabled', async () => {
    const calls = await bootWith({ enrichment: { enabled: true } });
    expect(calls).toHaveLength(1);
    expect((await (await fetch(`${dash.url}/api/enrichment`)).json()).last).toMatchObject({ trigger: 'scheduled' });
  });
});
