/**
 * Apify costs real money per actor run, so the retry policy is a spending
 * policy. `run-sync-get-dataset-items` EXECUTES a scrape and bills for it; the
 * default retry policy (which retries timeouts and 5xx) would re-run — and
 * re-charge — a scrape that had already started.
 */
import { describe, it, expect, vi } from 'vitest';

import { run as runApify, isRetryableBilledRun } from '../../src/search/adapters/apify.js';

const env = { APIFY_TOKEN: 'test-token' };

const actorSource = (extra = {}) => ({
  id: 'apify-scrapers',
  options: { actors: [{ actorId: 'valig~indeed-jobs-scraper', label: 'indeed', input: {} }], ...extra },
});

describe('Apify billed-run retry policy', () => {
  it('does NOT re-run a billed actor after a timeout — that is a second charge', async () => {
    // A run-sync call that times out has usually already STARTED the actor.
    const timeout = Object.assign(new Error('Request timed out after 180000ms'), { code: 'ETIMEDOUT', retryable: true });
    const fetchImpl = vi.fn().mockRejectedValue(timeout);

    const { jobs, errors } = await runApify(actorSource(), { fetchImpl, env, maxRetries: 3 });

    expect(jobs).toHaveLength(0);
    expect(errors).toHaveLength(1);
    // Exactly one billed attempt, not four.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does NOT re-run a billed actor on a 5xx — the run may already have been charged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 502, headers: { get: () => null },
    });
    await runApify(actorSource(), { fetchImpl, env, maxRetries: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('DOES retry a 429 — Apify rejected us at the gate, so no run was created or billed', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => null } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] });

    await runApify(actorSource(), { fetchImpl, env, maxRetries: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('a free, idempotent dataset READ keeps the normal retry policy', async () => {
    const source = { id: 'apify-scrapers', options: { actors: [{ datasetId: 'abc123', label: 'saved' }] } };
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => [] });

    await runApify(source, { fetchImpl, env, maxRetries: 3 });
    // Reading a dataset costs nothing and is safe to repeat.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('isRetryableBilledRun admits only 429', () => {
    expect(isRetryableBilledRun({ status: 429 })).toBe(true);
    expect(isRetryableBilledRun({ status: 503 })).toBe(false);
    expect(isRetryableBilledRun({ code: 'ETIMEDOUT' })).toBe(false);
    expect(isRetryableBilledRun({ retryable: true })).toBe(false);
    expect(isRetryableBilledRun(null)).toBe(false);
  });

  it('never puts the token in an error message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, headers: { get: () => null } });
    const { errors } = await runApify(actorSource(), { fetchImpl, env, maxRetries: 0 });
    expect(errors[0].error).not.toContain('test-token');
    expect(errors[0].status).toBe(401);
  });
});
