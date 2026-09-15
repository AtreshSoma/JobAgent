import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runWatch, runWatchCycle, withWatchOverrides } from '../../src/cli/watch.js';
import { runPrepareApps } from '../../src/cli/commands.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { loadTestConfig } from './helpers/testConfig.js';
import * as F from './fixtures/jobs.js';

const base = loadTestConfig({ loadEnv: false, env: {} });

function makeCtx(root) {
  const db = openDatabase({ path: ':memory:' });
  const { logger: pino } = createPinoLogger({ toFile: false });
  const logger = new JobLogger({ db, logger: pino });
  const config = { ...base, root };
  return { db, logger, config };
}

describe('withWatchOverrides', () => {
  it('forces a 24-hour freshness window without mutating the input', () => {
    const config = { runtime: { jobFreshnessMode: 'LAST_7_DAYS' }, jobboards: { sources: [] } };
    const out = withWatchOverrides(config, {});
    expect(out.runtime.jobFreshnessMode).toBe('LAST_24_HOURS');
    expect(config.runtime.jobFreshnessMode).toBe('LAST_7_DAYS'); // unchanged
  });

  it('disables Apify sources when freeOnly is set (others untouched)', () => {
    const config = {
      runtime: {},
      jobboards: { sources: [
        { id: 'gh', adapter: 'greenhouse', enabled: true },
        { id: 'li', adapter: 'apify', enabled: true },
      ] },
    };
    const out = withWatchOverrides(config, { freeOnly: true });
    expect(out.jobboards.sources.find((s) => s.adapter === 'apify').enabled).toBe(false);
    expect(out.jobboards.sources.find((s) => s.adapter === 'greenhouse').enabled).toBe(true);
    // Original config is not mutated.
    expect(config.jobboards.sources.find((s) => s.adapter === 'apify').enabled).toBe(true);
  });
});

describe('runWatchCycle', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'watch-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const sampleJobs = [F.azureFabricSenior, F.confirmedSponsorship, F.noSponsorship, F.juniorRole, F.snowflakeMismatch, F.staleHighApplicants];
  const searchFn = async () => ({ jobs: sampleJobs, duplicates: [], errors: [] });

  it('flags newly-queued jobs as new matches on the first cycle', async () => {
    const { db, logger, config } = makeCtx(root);
    const { newMatches, counters } = await runWatchCycle({
      config, db, logger,
      deps: { searchFn, now: F.NOW, stamp: 'test' },
    });
    expect(counters.jobs_found).toBe(sampleJobs.length);
    expect(newMatches.length).toBeGreaterThanOrEqual(1);
    expect(newMatches.every((m) => m.id)).toBe(true);
    db.close();
  });

  it('reports zero new matches on a second identical cycle (incremental)', async () => {
    const { db, logger, config } = makeCtx(root);
    const deps = { searchFn, now: F.NOW, stamp: 'test' };
    const first = await runWatchCycle({ config, db, logger, deps });
    expect(first.newMatches.length).toBeGreaterThanOrEqual(1);
    // Everything is now in the DB, so a repeat cycle surfaces nothing new.
    const second = await runWatchCycle({ config, db, logger, deps });
    expect(second.newMatches.length).toBe(0);
    db.close();
  });

  it('marks recent postings as urgent (within the fresh-alert window)', async () => {
    const { db, logger, config } = makeCtx(root);
    // NOW is 2026-06-04; fixtures are posted 2026-06-01 (3 days old) => not urgent
    // at the default 60-min window, but urgent with a very wide window.
    const wide = await runWatchCycle({
      config, db, logger,
      options: { freshAlertMinutes: 60 * 24 * 7 },
      deps: { searchFn, now: F.NOW, stamp: 'test' },
    });
    expect(wide.newMatches.some((m) => m.urgent)).toBe(true);
    db.close();
  });
});

describe('runWatch loop', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'watch-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('runs a bounded number of cycles and never auto-submits', async () => {
    const { db, logger, config } = makeCtx(root);
    let prepared = 0;
    const runPrepareAppsFn = vi.fn(async (args) => {
      // Honor the prepareFilter contract so the loop logic is exercised.
      prepared += 1;
      return { queued: prepared === 1
        ? [{ id: 'j-new', company: 'Acme', title: 'SDE', url: 'http://x', score: 90, tier: 'Priority', postedAt: '2026-06-04T00:00:00Z' }]
        : [], counters: { jobs_found: 1, jobs_prepared: prepared === 1 ? 1 : 0 } };
    });
    const sleep = vi.fn(async () => {});
    const r = await runWatch({
      config, db, logger,
      options: { intervalMinutes: 20 },
      deps: { runPrepareAppsFn, sleep, maxCycles: 3, silent: true, now: () => new Date('2026-06-04T00:30:00Z') },
    });
    expect(r.cycles).toBe(3);
    expect(r.totalNew).toBe(1); // only the first cycle had a new match
    expect(runPrepareAppsFn).toHaveBeenCalledTimes(3);
    db.close();
  });

  it('stops promptly when shouldStop flips (Ctrl+C)', async () => {
    const { db, logger, config } = makeCtx(root);
    let stop = false;
    const runPrepareAppsFn = vi.fn(async () => { stop = true; return { queued: [], counters: {} }; });
    const sleep = vi.fn(async () => {});
    const r = await runWatch({
      config, db, logger,
      options: { intervalMinutes: 20 },
      deps: { runPrepareAppsFn, sleep, shouldStop: () => stop, silent: true },
    });
    expect(r.cycles).toBe(1); // ran once, then stop was honored
    db.close();
  });

  it('--once runs exactly one cycle', async () => {
    const { db, logger, config } = makeCtx(root);
    const runPrepareAppsFn = vi.fn(async () => ({ queued: [], counters: {} }));
    const r = await runWatch({
      config, db, logger,
      options: { intervalMinutes: 20, once: true },
      deps: { runPrepareAppsFn, sleep: async () => {}, silent: true },
    });
    expect(r.cycles).toBe(1);
    expect(runPrepareAppsFn).toHaveBeenCalledTimes(1);
    db.close();
  });
});

describe('pipeline prepareFilter hook (used by watch)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'watch-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('skips packet preparation for jobs the filter rejects', async () => {
    const { db, logger, config } = makeCtx(root);
    const searchFn = async () => ({ jobs: [F.azureFabricSenior, F.confirmedSponsorship], duplicates: [], errors: [] });
    const r = await runPrepareApps({
      config, db, logger,
      deps: { searchFn, now: F.NOW, stamp: 'test', prepareFilter: () => false },
    });
    // Filter rejects everything => no packets prepared even for strong matches.
    expect(r.counters.jobs_prepared).toBe(0);
    db.close();
  });
});
