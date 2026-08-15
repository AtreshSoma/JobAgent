/**
 * Discovery wall-clock regressions.
 *
 * A measured run took 11m40s. Three separate causes, each covered here:
 *   1. the slowest sources were CLAIMED LAST, so the run ended waiting on one
 *      source draining alone;
 *   2. SmartRecruiters re-bought ~3,700 descriptions it already had on disk;
 *   3. per-source durations were never persisted, so none of it could be
 *      diagnosed after the fact.
 */

import { describe, it, expect } from 'vitest';
import { mapSettled } from '../../src/utils/concurrency.js';
import { createSourceTimings } from '../../src/search/sourceTimings.js';
import { runSearch } from '../../src/search/index.js';
import * as smartrecruiters from '../../src/search/adapters/smartrecruiters.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('mapSettled longest-first scheduling', () => {
  it('claims the most expensive item first', async () => {
    const items = ['cheap', 'cheap2', 'EXPENSIVE'];
    const cost = { cheap: 1, cheap2: 1, EXPENSIVE: 100 };
    const claimed = [];
    await mapSettled(items, 1, async (item) => { claimed.push(item); return item; },
      { costOf: (item) => cost[item] });
    expect(claimed[0]).toBe('EXPENSIVE');
  });

  it('still returns results in INPUT order, so dedup stays deterministic', async () => {
    const items = [1, 2, 3, 4];
    const results = await mapSettled(items, 2, async (n) => n * 10,
      { costOf: (n) => n });
    expect(results.map((r) => r.value)).toEqual([10, 20, 30, 40]);
  });

  it('passes each item its ORIGINAL index, not its scheduled position', async () => {
    const seen = new Map();
    await mapSettled(['a', 'b', 'c'], 1, async (item, index) => { seen.set(item, index); },
      { costOf: (_item, i) => i }); // reverses the claim order
    expect([...seen.entries()].sort()).toEqual([['a', 0], ['b', 1], ['c', 2]]);
  });

  it('leaves order untouched when no cost function is given', async () => {
    const claimed = [];
    await mapSettled(['a', 'b', 'c'], 1, async (item) => { claimed.push(item); });
    expect(claimed).toEqual(['a', 'b', 'c']);
  });

  it('finishes sooner than claim-in-listed-order for a long tail', async () => {
    // The real shape: one 120ms source listed AFTER several short ones, pool of 2.
    const items = [20, 20, 20, 20, 120];
    const run = (options) => mapSettled(items, 2, async (ms) => { await tick(ms); }, options);

    const listedStart = Date.now();
    await run({});
    const listedMs = Date.now() - listedStart;

    const costStart = Date.now();
    await run({ costOf: (ms) => ms });
    const costMs = Date.now() - costStart;

    expect(costMs).toBeLessThan(listedMs);
  });
});

describe('runSearch scheduling', () => {
  /** Three boards; `slow` is listed LAST, exactly as workday/smartrecruiters were. */
  const jobboards = {
    defaults: { sourceConcurrency: 1 },
    sources: [
      { id: 'fast-a', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['a'] },
      { id: 'fast-b', adapter: 'greenhouse', enabled: true, priority: 2, boards: ['b'] },
      { id: 'slow', adapter: 'greenhouse', enabled: true, priority: 3, boards: ['c'] },
    ],
  };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ jobs: [] }) });

  it('claims the slowest source first when a previous run timed it', async () => {
    const claimed = [];
    await runSearch({
      jobboards,
      ctx: {
        fetchImpl,
        sourceTimings: {
          expectedMs: (id) => (id === 'slow' ? 600_000 : 1_000),
          record: () => {},
        },
      },
      hooks: { onSource: (e) => { if (e.phase === 'start') claimed.push(e.source); } },
    });
    expect(claimed).toEqual(['slow', 'fast-a', 'fast-b']);
  });

  it('keeps configured order when there is no timing history', async () => {
    const claimed = [];
    await runSearch({
      jobboards,
      ctx: { fetchImpl, sourceTimings: { expectedMs: () => 0, record: () => {} } },
      hooks: { onSource: (e) => { if (e.phase === 'start') claimed.push(e.source); } },
    });
    expect(claimed).toEqual(['fast-a', 'fast-b', 'slow']);
  });

  it('reports results in configured order whatever the schedule was', async () => {
    const result = await runSearch({
      jobboards,
      ctx: {
        fetchImpl,
        sourceTimings: { expectedMs: (id) => (id === 'slow' ? 600_000 : 1), record: () => {} },
      },
    });
    expect(result.perSource.map((s) => s.source)).toEqual(['fast-a', 'fast-b', 'slow']);
  });

  it('records every source duration so the next run can schedule on measurement', async () => {
    let recorded = null;
    await runSearch({
      jobboards,
      ctx: { fetchImpl, sourceTimings: { expectedMs: () => 0, record: (p) => { recorded = p; } } },
    });
    expect(recorded.map((s) => s.source).sort()).toEqual(['fast-a', 'fast-b', 'slow']);
    expect(recorded.every((s) => Number.isFinite(s.durationMs))).toBe(true);
  });

  it('runs normally when no timings store is wired in at all', async () => {
    const result = await runSearch({ jobboards, ctx: { fetchImpl } });
    expect(result.perSource).toHaveLength(3);
  });
});

describe('sourceTimings', () => {
  /** In-memory file, so the test never touches disk. */
  const memoryFs = (seed = null) => {
    let contents = seed;
    return {
      readFileImpl: () => { if (contents === null) throw new Error('ENOENT'); return contents; },
      writeFileImpl: (_p, data) => { contents = data; },
      read: () => contents,
    };
  };

  it('reports no expectation for a source it has never timed', () => {
    const fs = memoryFs();
    const t = createSourceTimings({ root: '/x', ...fs });
    expect(t.expectedMs('workday-public')).toBe(0);
  });

  it('remembers a duration across runs', () => {
    const fs = memoryFs();
    createSourceTimings({ root: '/x', ...fs }).record([{ source: 'workday-public', durationMs: 379_000 }]);
    expect(createSourceTimings({ root: '/x', ...fs }).expectedMs('workday-public')).toBe(379_000);
  });

  it('blends a new observation with the old one rather than jumping to it', () => {
    const fs = memoryFs();
    createSourceTimings({ root: '/x', ...fs }).record([{ source: 's', durationMs: 100 }]);
    createSourceTimings({ root: '/x', ...fs }).record([{ source: 's', durationMs: 200 }]);
    expect(createSourceTimings({ root: '/x', ...fs }).expectedMs('s')).toBe(150);
  });

  it('ignores a cancelled source: it stopped early and says nothing about cost', () => {
    const fs = memoryFs();
    createSourceTimings({ root: '/x', ...fs }).record([{ source: 's', durationMs: 100_000 }]);
    createSourceTimings({ root: '/x', ...fs }).record([{ source: 's', durationMs: 5, cancelled: true }]);
    expect(createSourceTimings({ root: '/x', ...fs }).expectedMs('s')).toBe(100_000);
  });

  it('treats a stale timing as no timing — boards change', () => {
    const fs = memoryFs();
    let clock = Date.parse('2026-01-01T00:00:00Z');
    createSourceTimings({ root: '/x', ...fs, now: () => clock }).record([{ source: 's', durationMs: 100 }]);
    clock += 31 * 24 * 60 * 60 * 1000;
    expect(createSourceTimings({ root: '/x', ...fs, now: () => clock }).expectedMs('s')).toBe(0);
  });

  it('keeps a per-source history so a slow run can be explained afterwards', () => {
    const fs = memoryFs();
    createSourceTimings({ root: '/x', ...fs })
      .record([{ source: 's', durationMs: 620_000, found: 40_000, errors: 1 }]);
    const saved = JSON.parse(fs.read());
    expect(saved.sources.s.history[0]).toMatchObject({ ms: 620_000, found: 40_000, errors: 1 });
  });

  it('survives a corrupt timings file instead of failing the run', () => {
    const t = createSourceTimings({ root: '/x', readFileImpl: () => 'not json{', writeFileImpl: () => {} });
    expect(t.expectedMs('s')).toBe(0);
  });

  it('does not throw when the timings file cannot be written', () => {
    const t = createSourceTimings({
      root: '/x',
      readFileImpl: () => { throw new Error('ENOENT'); },
      writeFileImpl: () => { throw new Error('EACCES'); },
    });
    expect(() => t.record([{ source: 's', durationMs: 1 }])).not.toThrow();
  });
});

describe('smartrecruiters detail cache', () => {
  const POSTING = {
    id: '744000123456789',
    name: 'Senior Data Engineer',
    company: { identifier: 'acme', name: 'Acme' },
    location: { city: 'Austin', region: 'TX', country: 'us' },
  };

  /** Serves one posting on the list endpoint and counts detail reads. */
  const board = () => {
    const detailUrls = [];
    const fetchImpl = async (url) => {
      if (String(url).includes('/postings?')) {
        return { ok: true, json: async () => ({ totalFound: 1, content: [POSTING] }) };
      }
      detailUrls.push(String(url));
      return {
        ok: true,
        json: async () => ({ jobAd: { sections: { jobDescription: { text: 'FETCHED '.repeat(60) } } } }),
      };
    };
    return { fetchImpl, detailUrls };
  };

  it('spends a request when nothing is cached', async () => {
    const { fetchImpl, detailUrls } = board();
    await smartrecruiters.run({ boards: ['acme'] }, { fetchImpl, maxRetries: 0 });
    expect(detailUrls).toHaveLength(1);
  });

  it('reuses a stored description instead of re-buying it', async () => {
    const { fetchImpl, detailUrls } = board();
    const stored = 'STORED DESCRIPTION '.repeat(30);
    const { jobs, reused } = await smartrecruiters.run(
      { boards: ['acme'] },
      { fetchImpl, maxRetries: 0, detailCache: () => ({ jdText: stored, postedAt: '2026-08-01' }) },
    );
    expect(detailUrls).toEqual([]);           // the whole point: no request
    expect(reused).toBe(1);
    expect(jobs[0].jdText).toBe(stored);
    expect(jobs[0].postedAt).toBe('2026-08-01');
    expect(jobs[0].rawMetadata.summaryOnly).toBe(false);
    expect(jobs[0].rawMetadata.detailReused).toBe(true);
  });

  it('still fetches when the cache has no description for that posting', async () => {
    const { fetchImpl, detailUrls } = board();
    const { jobs } = await smartrecruiters.run(
      { boards: ['acme'] }, { fetchImpl, maxRetries: 0, detailCache: () => null },
    );
    expect(detailUrls).toHaveLength(1);
    expect(jobs[0].jdText).toContain('FETCHED');
  });

  it('does not let a cached posting consume the detail budget', async () => {
    // Two postings, budget of 1. If the cached one still counted against the
    // budget, the uncached one would never be read.
    const second = { ...POSTING, id: '744000999999999', name: 'Staff Data Engineer' };
    const detailUrls = [];
    const fetchImpl = async (url) => {
      if (String(url).includes('/postings?')) {
        return { ok: true, json: async () => ({ totalFound: 2, content: [POSTING, second] }) };
      }
      detailUrls.push(String(url));
      return { ok: true, json: async () => ({ jobAd: { sections: { jobDescription: { text: 'X'.repeat(500) } } } }) };
    };
    const cachedText = 'CACHED '.repeat(50);
    await smartrecruiters.run(
      { boards: ['acme'], options: { maxDetailFetches: 1 } },
      {
        fetchImpl,
        maxRetries: 0,
        detailCache: (id) => (id.includes('744000123456789') ? { jdText: cachedText } : null),
      },
    );
    expect(detailUrls).toHaveLength(1);
    expect(detailUrls[0]).toContain('744000999999999');
  });

  it('accepts the legacy workdayDetailCache name', async () => {
    const { fetchImpl, detailUrls } = board();
    const { reused } = await smartrecruiters.run(
      { boards: ['acme'] },
      { fetchImpl, maxRetries: 0, workdayDetailCache: () => ({ jdText: 'S'.repeat(400) }) },
    );
    expect(reused).toBe(1);
    expect(detailUrls).toEqual([]);
  });
});
