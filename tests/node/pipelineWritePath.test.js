/**
 * Pipeline write path and lifecycle: F8 retention, F9 ownership of verdicts,
 * F10 rescoreStale, M3 expiry, P5 transactions / stale skip / jd omission,
 * S8a location preservation, P8 date reconciliation, knownIdsBefore.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPipeline, rescoreStale, expireUnlisted, createWriter } from '../../src/pipeline/index.js';
import { openDatabase } from '../../src/logging/db.js';
import { scoringFingerprint } from '../../src/scoring/fingerprint.js';
import { loadTestConfig } from './helpers/testConfig.js';

const base = loadTestConfig({ loadEnv: false, env: {} });
const NOW = new Date('2026-09-22T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 864e5).toISOString();

const JD = 'Build and own Azure Data Factory and Databricks pipelines in PySpark and SQL. '
  + 'Model a data warehouse, publish Power BI datasets, and mentor engineers on the data platform. '.repeat(2);
const job = (over = {}) => ({
  id: 'gh:1', source: 'greenhouse', company: 'Northwind', title: 'Senior Data Engineer',
  location: 'Remote, United States', url: 'https://example.com/1', postedAt: daysAgo(1),
  jdText: JD, employmentType: '', rawMetadata: {}, ...over,
});

let root;
let db;
let config;
const run = (jobs, deps = {}) => runPipeline({
  config, db, logger: null, mode: 'DRY_RUN',
  deps: {
    searchFn: async () => ({ jobs: jobs.map((j) => ({ ...j, rawMetadata: { ...(j.rawMetadata ?? {}) } })), duplicates: [], errors: [], perSource: [] }),
    now: NOW, stamp: 't', sourceTimings: { record() {}, expectedMs: () => 0 }, writeFileImpl: () => {},
    ...deps,
  },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pipe-write-'));
  db = openDatabase({ path: ':memory:' });
  config = { ...base, root, runtime: { ...(base.runtime ?? {}), jobFreshnessMode: 'LAST_7_DAYS' } };
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe('F8 — the discovery window gates NEW rows only', () => {
  it('a new 10-day-old posting is dropped as stale, but a stored scored row of that age is re-judged', async () => {
    await run([job({ postedAt: daysAgo(2) })]);
    expect(db.getJob('gh:1').status).toBe('scored');
    // Same posting, now 10 days old: outside the 7-day window, inside the 45-day retention.
    const second = await run([job({ postedAt: daysAgo(10), jdText: `${JD} updated` })]);
    expect(second.stats.retained).toBe(1);
    expect(db.getJob('gh:1').status).toBe('scored');
    // A brand-new posting of the same age is not admitted.
    await run([job({ id: 'gh:2', url: 'https://example.com/2', title: 'Data Engineer II', postedAt: daysAgo(10) })]);
    expect(db.getJob('gh:2').discard_reason).toMatch(/^stale:/);
  });

  it('retention ends at exclusions.staleness.skipOlderThanDays', async () => {
    await run([job({ postedAt: daysAgo(2) })]);
    await run([job({ postedAt: daysAgo(50), jdText: `${JD} x` })]);
    expect(db.getJob('gh:1').discard_reason).toMatch(/^stale_posting/);
  });
});

describe('P5 — stale discards are cheap', () => {
  it('omits jd_text for a stale discard and does not rewrite an unchanged one', async () => {
    const stale = job({ id: 'gh:9', url: 'https://example.com/9', postedAt: '2026-08-01' });
    const first = await run([stale]);
    expect(first.counters.jobs_discarded_stale).toBe(1);
    const row = db.getJob('gh:9');
    expect(row.jd_text ?? null).toBeNull();
    const second = await run([stale]);
    expect(second.stats.staleSkippedUnchanged).toBe(1);
  });

  it('batches writes into transactions when db.transaction exists', async () => {
    const spy = vi.spyOn(db, 'transaction');
    await run(Array.from({ length: 3 }, (_, i) => job({ id: `gh:${i}`, url: `https://example.com/${i}`, title: `Data Engineer ${i}` })));
    expect(spy).toHaveBeenCalled();
    const calls = [];
    const w = createWriter({ transaction: (fn) => { calls.push('tx'); fn(); } }, 2);
    for (let i = 0; i < 5; i += 1) w.write(() => calls.push(i));
    w.flush();
    expect(calls.filter((c) => c === 'tx')).toHaveLength(3);
  });
});

describe('S8a — a blank incoming location never erases a stored one', () => {
  it('keeps the stored place and still applies the US gate to it', async () => {
    await run([job({ id: 'wd:1', source: 'workday', location: 'Hyderabad', url: 'https://acme.wd1.myworkdayjobs.com/x/job/Hyderabad/DE_1' })]);
    const after = await run([job({ id: 'wd:1', source: 'workday', location: '', url: 'https://acme.wd1.myworkdayjobs.com/x/job/Hyderabad/DE_1' })]);
    const row = db.getJob('wd:1');
    expect(row.location).toBe('Hyderabad');
    expect(row.status).toBe('discarded');
    expect(after.counters.jobs_discarded_excluded).toBe(1);
  });
});

describe('P8 — a relative Workday date that still agrees keeps the stored date', () => {
  it('does not rewrite posted_at when the label still describes it', async () => {
    const stored = '2026-09-19';
    await run([job({ id: 'wd:2', source: 'workday', postedAt: stored })]);
    const res = await run([job({
      id: 'wd:2', source: 'workday', postedAt: '2026-09-18',
      rawMetadata: { postedAtApprox: true, postedOnLabel: 'Posted 3 Days Ago' },
    })]);
    expect(db.getJob('wd:2').posted_at).toBe(stored);
    expect(res.counters.jobs_skipped_unchanged).toBe(1);
  });
});

describe('F9 — a role search never overwrites a profile verdict', () => {
  it('refreshes text but keeps score/tier/status/fingerprint', async () => {
    await run([job()]);
    const before = db.getJob('gh:1');
    await run([job({ jdText: 'Totally different product management role text.' })], {
      discoveryMode: 'role_search', searchQuery: 'Product Manager', keepBelowThreshold: true,
    });
    const after = db.getJob('gh:1');
    expect(after.jd_text).toContain('product management');
    for (const col of ['score', 'tier', 'status', 'explanation', 'scoring_fingerprint']) expect(after[col]).toEqual(before[col]);
    expect(after.discovery_mode).toBe('profile');
  });
});

describe('F10 — rescoreStale', () => {
  it('re-judges active rows whose fingerprint differs, with no network', async () => {
    await run([job()]);
    const fp = db.getJob('gh:1').scoring_fingerprint;
    // A changed likely-sponsor list is a changed judge.
    const changed = {
      ...config,
      scoring: { ...config.scoring, sponsorship: { ...config.scoring.sponsorship, likelySponsors: ['northwind'] } },
    };
    expect(scoringFingerprint(changed)).not.toBe(fp);
    const out = rescoreStale({ db, config: changed, now: NOW });
    expect(out.rescored).toBe(1);
    const row = db.getJob('gh:1');
    expect(row.scoring_fingerprint).toBe(scoringFingerprint(changed));
    expect(row.sponsorship).toBe('Likely');
    expect(rescoreStale({ db, config: changed, now: NOW }).rescored).toBe(0);
  });

  it('the fingerprint covers exclusions.employmentTypes and the role-family taxonomy', () => {
    const a = scoringFingerprint(config);
    expect(scoringFingerprint({ ...config, exclusions: { ...config.exclusions, employmentTypes: { contract: ['x'] } } })).not.toBe(a);
    expect(scoringFingerprint({ ...config, roleFamilies: { families: { x: { roles: ['y'] } } } })).not.toBe(a);
  });
});

describe('M3 — expiry', () => {
  it('expires an active row its source has not listed for 3 successful runs', async () => {
    await run([job()]);
    db.db.prepare("UPDATE jobs SET updated_at = '2026-09-01T00:00:00.000Z' WHERE id = 'gh:1'").run();
    const history = [
      { at: '2026-09-22T00:00:00.000Z', ok: true }, { at: '2026-09-21T00:00:00.000Z', ok: true },
      { at: '2026-09-20T00:00:00.000Z', ok: true },
    ];
    const timings = { historyOf: () => history };
    const perSource = [{ source: 'greenhouse-boards', adapter: 'greenhouse', succeeded: true }];
    expect(expireUnlisted({ db, perSource, sourceTimings: timings })).toBe(1);
    expect(db.getJob('gh:1')).toMatchObject({ status: 'discarded', discard_reason: 'expired: not listed by source for 3 runs' });
  });

  it('does not expire when any of those runs failed, or an aggregate source failed', async () => {
    await run([job()]);
    db.db.prepare("UPDATE jobs SET updated_at = '2026-09-01T00:00:00.000Z' WHERE id = 'gh:1'").run();
    const bad = { historyOf: () => [{ at: '2026-09-22', ok: true }, { at: '2026-09-21', ok: false }, { at: '2026-09-20', ok: true }] };
    expect(expireUnlisted({ db, perSource: [{ source: 'g', adapter: 'greenhouse', succeeded: true }], sourceTimings: bad })).toBe(0);
    const good = { historyOf: () => [{ at: '2026-09-22', ok: true }, { at: '2026-09-21', ok: true }, { at: '2026-09-20', ok: true }] };
    expect(expireUnlisted({
      db, sourceTimings: good,
      perSource: [{ source: 'g', adapter: 'greenhouse', succeeded: true }, { source: 'ats', adapter: 'atsSearch', succeeded: false }],
    })).toBe(0);
    expect(db.getJob('gh:1').status).toBe('scored');
  });

  it('an unchanged, still-listed row is touched so it never ages into expiry', async () => {
    await run([job()]);
    db.db.prepare("UPDATE jobs SET updated_at = '2026-09-01T00:00:00.000Z' WHERE id = 'gh:1'").run();
    const res = await run([job()]);
    expect(res.counters.jobs_skipped_unchanged).toBe(1);
    expect(db.getJob('gh:1').updated_at > '2026-09-01T00:00:00.000Z').toBe(true);
  });

  it('a past validThrough discards the posting as expired', async () => {
    await run([job({ rawMetadata: { validThrough: '2026-09-01' } })]);
    expect(db.getJob('gh:1').discard_reason).toMatch(/^expired: validThrough 2026-09-01/);
  });
});

describe('jobs_new counts rows of every discovery mode as known', () => {
  it('a role-search row rediscovered by a profile run is not "new"', async () => {
    await run([job()], { discoveryMode: 'role_search', searchQuery: 'x', keepBelowThreshold: true });
    const res = await run([job({ jdText: `${JD} changed` })]);
    expect(res.counters.jobs_new).toBe(0);
  });
});
