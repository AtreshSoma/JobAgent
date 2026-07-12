/**
 * Regression: the reported run.
 *
 * A Workday pod rate-limited the per-job detail endpoint. The agent then:
 *   1. reported HTTP 429 as category "network" ("check your internet
 *      connection") because the wrapper message contained "fetch failed";
 *   2. claimed the source's results were "missing from this run" when in fact
 *      every job had been kept with a summary-only description;
 *   3. printed "Retries spent: 0" while actually retrying every job;
 *   4. emitted one screaming RCA row PER JOB, burying the real signal;
 *   5. kept hammering the throttled pod, turning one 429 into hundreds.
 *
 * All five are pinned here.
 */
import { describe, it, expect } from 'vitest';

import { run as runWorkday, mapJob, parseWorkdayPostedOn, workdayReqId } from '../../src/search/adapters/workday.js';
import { classifyFailure, buildRca } from '../../src/utils/failureRca.js';
import { applyFreshnessFilter } from '../../src/search/freshnessFilter.js';
import { collapseRca } from '../../src/dashboard/server.js';

/** A pod that serves job LISTS but 429s every per-job DETAIL fetch. */
function throttlingPod({ retryAfter = null } = {}) {
  const counts = { list: 0, detail: 0 };
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/jobs')) {
      counts.list += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          total: 10,
          jobPostings: Array.from({ length: 10 }, (_, i) => ({
            title: `Engineer ${i}`,
            externalPath: `/job/Remote/Engineer-${i}_JR${i}`,
            locationsText: 'Remote',
            bulletFields: [`JR${i}`],
          })),
        }),
      };
    }
    counts.detail += 1;
    return {
      ok: false,
      status: 429,
      headers: { get: (h) => (h.toLowerCase() === 'retry-after' && retryAfter ? retryAfter : null) },
    };
  };
  return { fetchImpl, counts };
}

const TENANTS = ['nvidia', 'target', 'citi', 'hpe'].map((t) => ({
  host: `${t}.wd5.myworkdayjobs.com`, tenant: t, site: 'X',
}));

describe('Workday detail-endpoint throttling (HTTP 429)', () => {
  it('classifies a throttled detail fetch as rate_limit, NOT network', () => {
    // The exact message from the reported run. "detail fetch failed" used to
    // match the classifier's /fetch failed/ network rule and win.
    const message = 'detail fetch failed (Workday detail HTTP 429 for '
      + 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/X/job/Singapore/Test-Engineer_JR1); kept summaryOnly';
    const c = classifyFailure(message);
    expect(c.category).toBe('rate_limit');
    expect(c.guidance).toMatch(/rate-limited/i);
    expect(c.guidance).not.toMatch(/internet connection/i);
  });

  it('keeps every job, and says so — a throttled detail fetch is fidelity loss, not data loss', async () => {
    const { fetchImpl } = throttlingPod();
    const { jobs, errors } = await runWorkday(
      { tenants: TENANTS, rateLimitMs: 0 },
      { fetchImpl, maxRetries: 1, requestTimeoutMs: 1000 },
    );

    expect(jobs).toHaveLength(40);                                  // nothing lost
    expect(jobs.every((j) => j.rawMetadata.summaryOnly)).toBe(true); // just lower fidelity

    const entry = buildRca({
      operation: 'discover', source: 'workday-public', partialResultsValid: true,
      error: errors[0].error, status: errors[0].status,
      attempt: errors[0].attempts, degraded: errors[0].degraded, count: errors[0].count,
    });
    expect(entry.category).toBe('rate_limit');
    expect(entry.status).toBe(429);
    expect(entry.degraded).toBe(true);
    expect(entry.impact).toMatch(/KEPT/);
    expect(entry.impact).not.toMatch(/missing from this run/);
  });

  it('reports ONE note per tenant instead of one per job', async () => {
    const { fetchImpl } = throttlingPod();
    const { errors } = await runWorkday(
      { tenants: TENANTS, rateLimitMs: 0 },
      { fetchImpl, maxRetries: 0, requestTimeoutMs: 1000 },
    );
    // 4 tenants x 10 jobs = 40 failed detail fetches, but at most one note each.
    expect(errors.length).toBeLessThanOrEqual(TENANTS.length);
    expect(errors[0].error).toMatch(/jobs kept a summary-only description/);
    expect(errors[0].count).toBeGreaterThan(1);
  });

  it('stops hammering the pod: the breaker caps requests far below jobs x retries', async () => {
    const { fetchImpl, counts } = throttlingPod();
    await runWorkday(
      { tenants: TENANTS, rateLimitMs: 0 },
      { fetchImpl, maxRetries: 3, requestTimeoutMs: 1000 },
    );
    // Without a breaker this is 40 jobs x 4 attempts = 160 requests at a host
    // that already said "slow down". The pod is shared, so the breaker sees all
    // four tenants and shuts the detail fetching down after a handful.
    expect(counts.detail).toBeLessThan(20);
  });

  it('reports the retries it actually spent, not a hard-coded 0', async () => {
    const { fetchImpl } = throttlingPod();
    const { errors } = await runWorkday(
      { tenants: [TENANTS[0]], rateLimitMs: 0 },
      { fetchImpl, maxRetries: 2, requestTimeoutMs: 1000 },
    );
    expect(errors[0].attempts).toBeGreaterThan(0);
  });

  it('collapses a throttled run into a single dashboard row carrying the count', () => {
    const rows = Array.from({ length: 40 }, () => buildRca({
      operation: 'discover', source: 'workday-public', error: 'Workday detail HTTP 429 for https://x',
      status: 429, degraded: true, count: 1, partialResultsValid: true,
    }));
    const collapsed = collapseRca(rows);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].count).toBe(40);
    expect(collapsed[0].category).toBe('rate_limit');
    expect(collapsed[0].impact).toMatch(/40 results/);
  });

  it('dates jobs from the LIST endpoint alone, so a throttled detail fetch cannot delete them', async () => {
    // The real CXS list payload sends NO date — only `postedOn: "Posted Today"`.
    // The adapter used to read a `postedOnDate` field the API never sends, so
    // postedAt was null for every Workday job. Undated jobs are dropped by the
    // freshness filter, so a rate-limited detail endpoint silently wiped the
    // entire source while reporting only "missing descriptions".
    const { fetchImpl } = throttlingPod();
    const { jobs } = await runWorkday(
      { tenants: [TENANTS[0]], rateLimitMs: 0 },
      { fetchImpl, maxRetries: 0, requestTimeoutMs: 1000 },
    );
    expect(jobs.length).toBeGreaterThan(0);
    // Fixture postings carry no postedOn at all, so they stay honestly undated.
    // The real regression is exercised below against the true payload shape.
    const real = mapJob(
      { title: 'Data Engineer', externalPath: '/job/SF/Data-Engineer_JR350461', locationsText: 'SF', postedOn: 'Posted Today', bulletFields: ['JR350461'] },
      { host: 'x.wd5.myworkdayjobs.com', tenant: 'x', site: 'S', company: 'X' },
      { now: new Date('2026-07-12T12:00:00Z') },
    );
    expect(real.postedAt).toBeTruthy();
    expect(real.rawMetadata.postedAtApprox).toBe(true);

    const fresh = applyFreshnessFilter([real], { jobFreshnessMode: 'LAST_7_DAYS' }, { now: new Date('2026-07-12T18:00:00Z') });
    expect(fresh.kept).toHaveLength(1);
    expect(fresh.counts.undatedDropped).toBe(0);
  });

  it('parses every relative posting label Workday actually sends', () => {
    const now = new Date('2026-07-12T12:00:00Z');
    const day = (v) => (v ? v.slice(0, 10) : v);
    expect(day(parseWorkdayPostedOn('Posted Today', now))).toBe('2026-07-12');
    expect(day(parseWorkdayPostedOn('Posted Yesterday', now))).toBe('2026-07-11');
    expect(day(parseWorkdayPostedOn('Posted 5 Days Ago', now))).toBe('2026-07-07');
    // "30+" is a lower bound; 30 days is stale under every window we support.
    expect(day(parseWorkdayPostedOn('Posted 30+ Days Ago', now))).toBe('2026-06-12');
    // Never invent a date out of nothing.
    expect(parseWorkdayPostedOn('', now)).toBeNull();
    expect(parseWorkdayPostedOn(undefined, now)).toBeNull();
    expect(parseWorkdayPostedOn('Apply now', now)).toBeNull();
  });

  it('an exact date from the tenant or the detail endpoint beats the relative label', () => {
    const job = mapJob(
      { title: 'T', externalPath: '/job/x/T_JR1', postedOnDate: '2026-05-30', postedOn: 'Posted Today' },
      { host: 'h', tenant: 't', site: 's' },
      { now: new Date('2026-07-12T12:00:00Z') },
    );
    expect(job.postedAt).toBe('2026-05-30');
    expect(job.rawMetadata.postedAtApprox).toBeUndefined();
  });

  it('takes the requisition id from the path, not from tenant-configurable bulletFields', () => {
    // bulletFields is configurable per tenant; a tenant that puts a relative date
    // there would churn the job's identity on every run.
    expect(workdayReqId({ externalPath: '/job/Singapore/Test-Engineer_JR2020205', bulletFields: ['Posted 4 Days Ago'] })).toBe('JR2020205');
    expect(workdayReqId({ externalPath: '/job/Pune/Eng_JR2018369-1' })).toBe('JR2018369-1');
    expect(workdayReqId({ externalPath: '', bulletFields: ['R0000431693'] })).toBe('R0000431693');
    // A bullet that is prose, not an id, is not used as identity.
    expect(workdayReqId({ externalPath: '', bulletFields: ['Posted 4 Days Ago'], title: 'T' })).toBe('T');
  });

  it('a source that genuinely failed still reads as a failure, not a degradation', () => {
    const collapsed = collapseRca([
      buildRca({ operation: 'discover', source: 'lever', error: 'getaddrinfo ENOTFOUND api.lever.co', partialResultsValid: true }),
      buildRca({ operation: 'discover', source: 'workday-public', error: 'HTTP 429', status: 429, degraded: true, count: 12, partialResultsValid: true }),
    ]);
    const lever = collapsed.find((e) => e.source === 'lever');
    expect(lever.category).toBe('dns');
    expect(lever.degraded).toBe(false);
    expect(lever.impact).toMatch(/missing from this run/);
    // Real failures sort above degradations — they are what needs attention.
    expect(collapsed[0].source).toBe('lever');
  });
});
