/**
 * Apify costs real money per actor run, so the retry policy is a spending
 * policy. `run-sync-get-dataset-items` EXECUTES a scrape and bills for it; the
 * default retry policy (which retries timeouts and 5xx) would re-run — and
 * re-charge — a scrape that had already started.
 */
import { describe, it, expect, vi } from 'vitest';

import { run as runApify, isRetryableBilledRun } from '../../src/search/adapters/apify.js';

const env = { APIFY_TOKEN: 'test-token' };

/**
 * Billed actor calls only. Before running any actor the adapter makes ONE free
 * metadata call to check the account still has credit — counting raw fetches
 * would conflate that with a charge.
 */
const billedCalls = (fetchImpl) => fetchImpl.mock.calls
  .filter(([url]) => !String(url).includes('/users/me/limits'));

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
    expect(billedCalls(fetchImpl)).toHaveLength(1);
  });

  it('does NOT re-run a billed actor on a 5xx — the run may already have been charged', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false, status: 502, headers: { get: () => null },
    });
    await runApify(actorSource(), { fetchImpl, env, maxRetries: 3 });
    expect(billedCalls(fetchImpl)).toHaveLength(1);
  });

  it('DOES retry a 429 — Apify rejected us at the gate, so no run was created or billed', async () => {
    // Routed by URL, not call order: the free credit check is its own request
    // and must not consume the actor's queued responses.
    let actorAttempts = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/users/me/limits')) {
        return { ok: true, status: 200, json: async () => ({ data: {} }) };
      }
      actorAttempts += 1;
      if (actorAttempts === 1) return { ok: false, status: 429, headers: { get: () => null } };
      return { ok: true, status: 200, json: async () => [] };
    });

    await runApify(actorSource(), { fetchImpl, env, maxRetries: 3 });
    expect(billedCalls(fetchImpl)).toHaveLength(2);
  });

  it('spends nothing when the account is out of credit for the cycle', async () => {
    // Apify refuses every new run once the monthly limit is reached, so firing
    // all the configured actors produced one identical rejection each and no
    // indication of the cause. One free check up front replaces all of them.
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/users/me/limits')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              current: { monthlyUsageUsd: 5.25 },
              limits: { maxMonthlyUsageUsd: 5 },
              monthlyUsageCycle: { endAt: '2026-08-07T23:59:59.999Z' },
            },
          }),
        };
      }
      throw new Error('an actor must not be started with no credit left');
    });
    const source = {
      id: 'apify-scrapers',
      options: {
        actors: Array.from({ length: 16 }, (_, i) => ({ actorId: 'valig~indeed-jobs-scraper', label: `a${i}`, input: {} })),
      },
    };

    const { jobs, errors } = await runApify(source, { fetchImpl, env, maxRetries: 3 });
    expect(jobs).toHaveLength(0);
    expect(billedCalls(fetchImpl)).toHaveLength(0);
    // ONE explanation naming the cause, the numbers, and the reset date.
    expect(errors).toHaveLength(1);
    expect(errors[0].category).toBe('quota_exhausted');
    expect(errors[0].error).toMatch(/\$5\.25 of \$5\.00 used/);
    expect(errors[0].error).toMatch(/resets on 2026-08-07/);
    expect(errors[0].error).toMatch(/Other job boards are unaffected/);
  });

  it('still reads a free saved dataset when there is no credit left', async () => {
    // Reading an existing dataset costs nothing, so it must not be gated on
    // credit — and must not spend a request asking about it either.
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/users/me/limits')) throw new Error('should not check credit');
      return { ok: true, status: 200, json: async () => [] };
    });
    const source = { id: 'apify-scrapers', options: { actors: [{ datasetId: 'abc123', label: 'saved' }] } };
    const { errors } = await runApify(source, { fetchImpl, env, maxRetries: 3 });
    expect(errors).toHaveLength(0);
  });

  it('runs normally when the credit check cannot be reached', async () => {
    // A failed probe must never block a run that would otherwise work.
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('/users/me/limits')) throw new Error('network down');
      return { ok: true, status: 200, json: async () => [] };
    });
    const { errors } = await runApify(actorSource(), { fetchImpl, env, maxRetries: 3 });
    expect(errors).toHaveLength(0);
    expect(billedCalls(fetchImpl)).toHaveLength(1);
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
