/**
 * Audit D1 (docs/audits/2026-11-20-discovery-coverage.md): the discovery window
 * must mean "new to us", not "posted in the last N days". A posting first seen
 * after the window — because no run happened, the source failed, or the
 * employer was only just configured — used to be written as `stale` and never
 * judged again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { catchUpWindow, companyKey, createSourceCoverage } from '../../src/search/sourceCoverage.js';
import { applyFreshnessFilter } from '../../src/search/freshnessFilter.js';
import { runPipeline } from '../../src/pipeline/index.js';
import { openDatabase } from '../../src/logging/db.js';
import { normalizeJob } from '../../src/search/normalize.js';
import { loadTestConfig } from './helpers/testConfig.js';

const NOW = new Date('2026-06-10T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 864e5).toISOString();

describe('catchUpWindow', () => {
  it('covers the gap since the last complete listing, plus a day', () => {
    expect(catchUpWindow({ lastCompleteAt: daysAgo(6), now: NOW, retentionDays: 45 }))
      .toEqual({ days: 7, reason: 'gap', requireTitleFit: false });
  });

  it('never exceeds retention', () => {
    expect(catchUpWindow({ lastCompleteAt: daysAgo(90), now: NOW, retentionDays: 45 }).days).toBe(45);
  });

  it('treats a source with no complete run as new: retention window, title-fit only', () => {
    expect(catchUpWindow({ lastCompleteAt: null, now: NOW, retentionDays: 30 }))
      .toEqual({ days: 30, reason: 'new-source', requireTitleFit: true });
  });
});

describe('createSourceCoverage', () => {
  it('moves the clock only on a complete listing', () => {
    const cov = createSourceCoverage({ root: null });
    cov.record([
      { source: 'ok', succeeded: true },
      { source: 'failed', succeeded: false },
      { source: 'cancelled', succeeded: true, cancelled: true },
      { source: 'skipped-pages', succeeded: true, cached: true },
    ], [], { at: NOW });
    expect(cov.lastCompleteAt('ok')).toBe(NOW.toISOString());
    expect(cov.lastCompleteAt('failed')).toBeNull();
    expect(cov.lastCompleteAt('cancelled')).toBeNull();
    expect(cov.lastCompleteAt('skipped-pages')).toBeNull();
  });

  it('learns employers per source and treats an unseen employer as new', () => {
    const cov = createSourceCoverage({ root: null });
    cov.record([{ source: 'wd', succeeded: true }], [{ sourceId: 'wd', company: 'Acme, Inc.' }], { at: new Date(daysAgo(2)) });
    const resolve = cov.resolver({ retentionDays: 45, at: NOW });
    expect(resolve('wd', 'ACME inc')).toMatchObject({ reason: 'gap', days: 3 });
    expect(resolve('wd', 'Microsoft')).toMatchObject({ reason: 'new-source', days: 45 });
    expect(resolve(undefined, 'Acme')).toBeNull();
  });

  it('freezes the resolver so this run cannot count itself as already seen', () => {
    const cov = createSourceCoverage({ root: null });
    const resolve = cov.resolver({ retentionDays: 45, at: NOW });
    cov.record([{ source: 'wd', succeeded: true }], [{ sourceId: 'wd', company: 'Acme' }], { at: NOW });
    expect(resolve('wd', 'Acme').reason).toBe('new-source');
  });

  it('persists per workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'cov-'));
    try {
      const a = createSourceCoverage({ root });
      a.record([{ source: 'g', succeeded: true }], [{ sourceId: 'g', company: 'Globex' }], { at: NOW });
      a.save();
      const b = createSourceCoverage({ root });
      expect(b.lastCompleteAt('g')).toBe(NOW.toISOString());
      expect(b.knowsCompany('g', 'globex')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes employer keys', () => {
    expect(companyKey('  Acme, Inc. ')).toBe('acme inc');
  });
});

describe('applyFreshnessFilter with a catch-up window', () => {
  const job = (id, age, extra = {}) => ({ id, title: 'Senior Data Engineer', postedAt: daysAgo(age), ...extra });
  const settings = { jobFreshnessMode: 'LAST_3_DAYS', includeLast3DaysFallback: false };

  it('admits a posting from the gap since the last complete run', () => {
    const out = applyFreshnessFilter([job('a', 5), job('b', 9)], settings, {
      now: NOW, windowFor: () => ({ days: 7, reason: 'gap' }),
    });
    expect(out.kept.map((j) => j.id)).toEqual(['a']);
    expect(out.counts).toMatchObject({ caughtUp: 1, stale: 1 });
    expect(out.kept[0].rawMetadata.admittedBy).toBe('catch-up');
  });

  it('backfills a new employer only for title-fit roles', () => {
    const fits = (j) => j.title.includes('Data');
    const out = applyFreshnessFilter([job('fit', 20), job('nofit', 20, { title: 'Store Associate' })], settings, {
      now: NOW, windowFor: () => ({ days: 45, reason: 'new-source', requireTitleFit: true }), titleFits: fits,
    });
    expect(out.kept.map((j) => j.id)).toEqual(['fit']);
    expect(out.counts.backfilled).toBe(1);
  });

  it('never narrows the configured window', () => {
    const out = applyFreshnessFilter([job('a', 2)], settings, { now: NOW, windowFor: () => ({ days: 1, reason: 'gap' }) });
    expect(out.kept).toHaveLength(1);
  });
});

describe('runPipeline catch-up (D1)', () => {
  const base = loadTestConfig({ loadEnv: false, env: {} });
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'catchup-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const posting = (id, company, title, age) => {
    const job = normalizeJob({
      source: 'greenhouse', company, title, location: 'Remote, US', sourceJobId: id,
      postedAt: daysAgo(age),
      jdText: `${title} building Azure Databricks and Microsoft Fabric lakehouses with PySpark, SQL and Power BI.`,
    });
    job.rawMetadata = { ...(job.rawMetadata ?? {}), sourceId: 'gh' };
    return job;
  };

  async function run(jobs, coverage) {
    const db = openDatabase({ path: ':memory:' });
    const config = { ...base, root, runtime: { ...(base.runtime ?? {}), jobFreshnessMode: 'LAST_3_DAYS', includeLast3DaysFallback: false } };
    const result = await runPipeline({
      config, db, logger: null, mode: 'DRY_RUN',
      deps: {
        now: NOW, stamp: 't', sourceCoverage: coverage, boardFingerprints: null, rescoreStale: false,
        sourceTimings: { record() {}, expectedMs: () => 0, historyOf: () => [] },
        searchFn: async () => ({
          jobs, duplicates: [], errors: [],
          perSource: [{ source: 'gh', adapter: 'greenhouse', found: jobs.length, succeeded: true }],
        }),
      },
    });
    const statusOf = (id) => db.getJob(id)?.status;
    return { result, statusOf, db };
  }

  it('admits a 5-day-old posting when the source was last read completely 6 days ago', async () => {
    const cov = createSourceCoverage({ root: null });
    cov.record([{ source: 'gh', succeeded: true }], [{ sourceId: 'gh', company: 'Acme' }], { at: new Date(daysAgo(6)) });
    const recent = posting('r1', 'Acme', 'Senior Data Engineer', 5);
    const old = posting('o1', 'Acme', 'Senior Data Engineer', 12);
    const { result, statusOf, db } = await run([recent, old], cov);
    expect(statusOf(recent.id)).not.toBe('discarded');
    expect(db.getJob(old.id).discard_reason).toMatch(/^stale:/);
    expect(result.stats.caughtUp).toBe(1);
    db.close();
  });

  it('keeps the plain window when the source was read completely yesterday', async () => {
    const cov = createSourceCoverage({ root: null });
    cov.record([{ source: 'gh', succeeded: true }], [{ sourceId: 'gh', company: 'Acme' }], { at: new Date(daysAgo(1)) });
    const job = posting('r2', 'Acme', 'Senior Data Engineer', 5);
    const { db } = await run([job], cov);
    expect(db.getJob(job.id).discard_reason).toMatch(/^stale:/);
    db.close();
  });

  it('backfills a newly configured employer for title-fit roles, then records it', async () => {
    const cov = createSourceCoverage({ root: null });
    cov.record([{ source: 'gh', succeeded: true }], [{ sourceId: 'gh', company: 'Acme' }], { at: new Date(daysAgo(1)) });
    const fit = posting('n1', 'Microsoft', 'Senior Data Engineer', 20);
    const unrelated = posting('n2', 'Microsoft', 'Retail Store Associate', 20);
    const { result, db } = await run([fit, unrelated], cov);
    expect(db.getJob(fit.id).discard_reason ?? '').not.toMatch(/^stale:/);
    expect(db.getJob(unrelated.id).discard_reason).toMatch(/^stale:/);
    expect(result.stats.backfilled).toBe(1);
    expect(cov.knowsCompany('gh', 'Microsoft')).toBe(true);
    db.close();
  });

  it('null coverage restores window-only behaviour', async () => {
    const job = posting('w1', 'Acme', 'Senior Data Engineer', 5);
    const { db } = await run([job], null);
    expect(db.getJob(job.id).discard_reason).toMatch(/^stale:/);
    db.close();
  });
});

describe('rejudgeStale (one-time repair of D1 rows)', async () => {
  const { rejudgeStale, READMITTED_REASON } = await import('../../src/pipeline/rejudgeStale.js');
  const base = loadTestConfig({ loadEnv: false, env: {} });
  const seed = (db, id, title, location, age, extra = {}) => db.upsertJob({
    id, source: 'greenhouse', company: 'Acme', title, location, url: `https://example.test/${id}`,
    posted_at: daysAgo(age), status: 'discarded', discard_reason: `stale: posted ${age} day(s) ago (> 3d window)`, ...extra,
  });

  it('re-admits title-fit rows inside retention, relabels hard exclusions, leaves the rest', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db, 'fit', 'Senior Data Engineer', 'Remote, US', 10);
    seed(db, 'abroad', 'Senior Data Engineer', 'Bengaluru, Karnataka, India', 10);
    seed(db, 'offtarget', 'Retail Store Associate', 'Austin, TX', 10);
    seed(db, 'tooold', 'Senior Data Engineer', 'Remote, US', 80);
    seed(db, 'decided', 'Senior Data Engineer', 'Remote, US', 10, { user_decision: 'skip' });

    const dry = rejudgeStale({ db, config: base, now: NOW });
    expect(dry).toMatchObject({ readmitted: 1, relabelled: 1 });
    expect(db.getJob('fit').status).toBe('discarded');

    rejudgeStale({ db, config: base, now: NOW, apply: true });
    expect(db.getJob('fit')).toMatchObject({ status: 'needs_description', discard_reason: READMITTED_REASON });
    expect(db.getJob('abroad').discard_reason).toMatch(/^geography_mismatch/);
    expect(db.getJob('offtarget').discard_reason).toMatch(/^stale:/);
    expect(db.getJob('tooold').discard_reason).toMatch(/^stale:/);
    expect(db.getJob('decided').status).toBe('discarded');
    expect(rejudgeStale({ db, config: base, now: NOW }).readmitted).toBe(0);
    db.close();
  });
});

describe('Workday lower-bound dates (D7)', () => {
  const settings = { jobFreshnessMode: 'LAST_3_DAYS', includeLast3DaysFallback: false };
  it('never admits a "30+ days" posting through a wider catch-up window, and says "30+"', () => {
    const job = { id: 'wd', title: 'Senior Data Engineer', postedAt: daysAgo(30), rawMetadata: { postedAtLowerBound: true } };
    const out = applyFreshnessFilter([job], settings, { now: NOW, windowFor: () => ({ days: 45, reason: 'new-source' }), titleFits: () => true });
    expect(out.kept).toHaveLength(0);
    expect(out.dropped[0].reason).toMatch(/^posted 30\+ day\(s\) ago/);
  });
});
