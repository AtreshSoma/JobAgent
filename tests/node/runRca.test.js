/**
 * Run-level RCA surface: /api/run/status must expose structured, sanitized
 * root-cause entries for failed runs, and a run where SOME sources failed must
 * be reported as PARTIAL with healthy-source results kept — never as a clean
 * success and never as a total failure.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { startDashboard } from '../../src/dashboard/server.js';
import { openDatabase } from '../../src/logging/db.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('run RCA at /api/run/status', () => {
  let dash;
  let db;
  afterEach(async () => { await dash?.close(); db?.close(); });

  async function boot(deps) {
    db = openDatabase({ path: ':memory:' });
    dash = await startDashboard({ config: {}, db, logger: null, port: 0, deps });
    return dash;
  }
  const post = (path, body) => fetch(dash.url + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());
  const status = () => fetch(dash.url + '/api/run/status').then((r) => r.json());

  it('a partial discovery (one source down) keeps results and reports structured per-source RCA', async () => {
    await boot({
      discoverFn: async () => ({
        counters: { jobs_found: 12 },
        errors: [
          { source: 'greenhouse', error: 'HTTP 429 Too Many Requests' },
          { source: 'lever', error: 'getaddrinfo ENOTFOUND jobs.lever.co' },
        ],
      }),
    });
    const started = await post('/api/run', { phase: 'discover' });
    expect(started.runId).toBeTruthy();
    await wait(80);
    const s = await status();
    expect(s.running).toBe(false);
    expect(s.lastError).toBeNull();                    // NOT a total failure
    expect(s.partial).toBe(true);                      // NOT a clean success
    expect(s.lastResult).toMatchObject({ phase: 'discover', partial: true });
    expect(s.lastResult.failedSources.sort()).toEqual(['greenhouse', 'lever']);
    expect(s.lastResult.counters.jobs_found).toBe(12); // healthy results kept
    const byatSource = Object.fromEntries(s.rca.map((e) => [e.source, e]));
    expect(byatSource.greenhouse).toMatchObject({
      category: 'rate_limit', operation: 'discover', retryable: true,
      partialResultsValid: true, runId: started.runId,
    });
    expect(byatSource.lever.category).toBe('dns');
    for (const e of s.rca) {
      expect(e.guidance.length).toBeGreaterThan(10);
      expect(e.impact).toContain(e.source);
      expect(e.at).toBeTruthy();
    }
  });

  it('a fully failed run reports a sanitized error and one RCA entry (no secrets leaked)', async () => {
    await boot({
      discoverFn: async () => {
        throw Object.assign(
          new Error('HTTP 401 for https://api.apify.com/v2/acts?token=apify_api_supersecret123'),
          { statusCode: 401 },
        );
      },
    });
    await post('/api/run', { phase: 'discover' });
    await wait(80);
    const s = await status();
    expect(s.partial).toBe(false);
    expect(s.lastError).toMatch(/discover failed/);
    expect(s.lastError).not.toMatch(/supersecret123/);
    expect(s.rca).toHaveLength(1);
    expect(s.rca[0]).toMatchObject({ category: 'auth', operation: 'discover', retryable: false });
    expect(s.rca[0].message).not.toMatch(/supersecret123/);
    expect(s.rca[0].message).toContain('[REDACTED]');
  });

  it('a clean run reports neither RCA entries nor the partial flag', async () => {
    await boot({ discoverFn: async () => ({ counters: { jobs_found: 3 }, errors: [] }) });
    await post('/api/run', { phase: 'discover' });
    await wait(80);
    const s = await status();
    expect(s.partial).toBe(false);
    expect(s.rca).toEqual([]);
    expect(s.lastError).toBeNull();
  });
});
