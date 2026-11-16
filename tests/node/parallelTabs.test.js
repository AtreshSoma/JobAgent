/**
 * Fill two or three applications at once, on different hosts (audit A11).
 *
 * A batch used to open one application at a time. Context reuse already gives
 * each job its own tab in one persistent browser; what was missing was running
 * a few at once. The default stays ONE at a time. Raised (ASSIST_CONCURRENCY,
 * at most 3), the batch fills up to that many tabs together, never two on the
 * same host (an ATS rate-limits and flags a burst from one account), and still
 * stops before every submit: nothing here changes the submit gates.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBrowserSession } from '../../src/automation/browser.js';
import { runAssist } from '../../src/cli/commands.js';
import { enqueueForApproval, approve } from '../../src/apply/approvalQueue.js';
import { hostKey, runLimited } from '../../src/utils/hostScheduler.js';
import { openDatabase } from '../../src/logging/db.js';
import { loadTestConfig } from './helpers/testConfig.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('hostKey', () => {
  it('groups an ATS by its registrable host, so two tenants share a key', () => {
    expect(hostKey('https://acme.wd1.myworkdayjobs.com/x')).toBe('myworkdayjobs.com');
    expect(hostKey('https://other.wd5.myworkdayjobs.com/y')).toBe('myworkdayjobs.com');
    expect(hostKey('https://boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse.io');
    expect(hostKey('https://jobs.lever.co/acme')).toBe('lever.co');
    expect(hostKey('not a url')).toBe('not a url');
  });
});

describe('runLimited', () => {
  const run = (items, opts) => {
    let active = 0; let peak = 0; const overlap = [];
    const live = new Set();
    return runLimited(items, {
      keyOf: (i) => i.key,
      ...opts,
      worker: async (item) => {
        if (live.has(item.key)) overlap.push(item.key);
        live.add(item.key); active += 1; peak = Math.max(peak, active);
        await sleep(item.ms ?? 20);
        active -= 1; live.delete(item.key);
        return item.id;
      },
    }).then((results) => ({ results, peak, overlap }));
  };

  it('with one slot is strictly sequential', async () => {
    const { peak } = await run([{ id: 1, key: 'a' }, { id: 2, key: 'b' }, { id: 3, key: 'c' }], { concurrency: 1 });
    expect(peak).toBe(1);
  });

  it('runs different hosts together, up to the limit, and keeps the input order of results', async () => {
    const { results, peak } = await run([
      { id: 1, key: 'a', ms: 60 }, { id: 2, key: 'b', ms: 10 }, { id: 3, key: 'c', ms: 10 }, { id: 4, key: 'd', ms: 10 },
    ], { concurrency: 2 });
    expect(peak).toBe(2);
    expect(results).toEqual([1, 2, 3, 4]);
  });

  it('never runs two jobs on the same host at once', async () => {
    const { overlap, peak } = await run([
      { id: 1, key: 'a' }, { id: 2, key: 'a' }, { id: 3, key: 'b' }, { id: 4, key: 'a' },
    ], { concurrency: 3 });
    expect(overlap).toEqual([]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('clamps the limit to 1..3', async () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: i, key: `k${i}` }));
    expect((await run(many, { concurrency: 99 })).peak).toBe(3);
    expect((await run(many, { concurrency: 0 })).peak).toBe(1);
    expect((await run(many, { concurrency: -4 })).peak).toBe(1);
  });

  it('stops starting new jobs after a cancel, and lets running ones finish', async () => {
    let cancelled = false; const started = [];
    const out = await runLimited(Array.from({ length: 6 }, (_, i) => ({ id: i, key: `k${i}` })), {
      concurrency: 2, keyOf: (i) => i.key, shouldCancel: () => cancelled,
      worker: async (item) => { started.push(item.id); if (item.id === 1) cancelled = true; await sleep(20); return item.id; },
    });
    expect(started.length).toBeLessThan(6);
    expect(out.filter((r) => r !== undefined)).toEqual(started.sort((a, b) => a - b));
  });

  it('after a failure starts nothing new, waits for the running ones, and rethrows', async () => {
    const started = [];
    await expect(runLimited(Array.from({ length: 5 }, (_, i) => ({ id: i, key: `k${i}` })), {
      concurrency: 2, keyOf: (i) => i.key,
      worker: async (item) => { started.push(item.id); await sleep(10); if (item.id === 0) throw new Error('boom'); return item.id; },
    })).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]);
  });
});

describe('runAssist with several tabs', () => {
  let db; let dir;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); dir = mkdtempSync(join(tmpdir(), 'parallel-')); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function approved(jobId, url) {
    const packet = { job: { id: jobId, company: `Co-${jobId}`, title: 'SDE', url }, owner: {}, score: 90, tier: 'Priority', blockers: [] };
    const path = join(dir, `${jobId}.json`);
    writeFileSync(path, JSON.stringify(packet));
    const queued = enqueueForApproval(db, { packet, packetPath: path });
    approve(db, queued.id);
    db.upsertJob({ id: jobId, company: `Co-${jobId}`, title: 'SDE', url, status: 'prepared' });
  }
  const URLS = ['https://boards.greenhouse.io/a/jobs/1', 'https://jobs.lever.co/b/1', 'https://jobs.ashbyhq.com/c/1', 'https://boards.greenhouse.io/d/jobs/2'];
  async function batch(options, config = {}) {
    URLS.forEach((u, i) => approved(`job-${i}`, u));
    let active = 0; let peak = 0; const order = []; const overlapHosts = []; const liveHosts = new Set();
    const out = await runAssist({
      config: { ...loadTestConfig(), ...config }, db, logger: null, options,
      deps: {
        assistFn: async ({ packet }) => {
          const host = hostKey(packet.job.url);
          if (liveHosts.has(host)) overlapHosts.push(host);
          liveHosts.add(host); active += 1; peak = Math.max(peak, active); order.push(packet.job.id);
          await sleep(30);
          active -= 1; liveHosts.delete(host);
          return { status: 'ready_for_submit', blockers: [], filled: [], jobId: packet.job.id };
        },
      },
    });
    return { out, peak, order, overlapHosts };
  }

  it('is sequential by default', async () => {
    const { peak, out } = await batch({});
    expect(peak).toBe(1);
    expect(out.results).toHaveLength(4);
  });

  it('fills up to the limit together, never two on one host, results in order, nothing auto-submitted', async () => {
    const { peak, overlapHosts, out } = await batch({ concurrency: 3 });
    expect(peak).toBeGreaterThan(1);
    expect(overlapHosts).toEqual([]);
    expect(out.results.map((r) => r.jobId)).toEqual(['job-0', 'job-1', 'job-2', 'job-3']);
    expect(out.counters.jobs_assisted).toBe(4);
  });

  it('reads the limit from the runtime setting when no option is given', async () => {
    const { peak } = await batch({}, { runtime: { assistConcurrency: 2 } });
    expect(peak).toBe(2);
  });
});

describe('opening the persistent browser from several tabs at once', () => {
  it('launches it once, and every tab shares it', async () => {
    let launches = 0;
    const context = {
      pages: () => [], newPage: async () => ({ close: async () => {} }), once: () => {}, close: async () => {},
    };
    const chromium = { launchPersistentContext: async () => { launches += 1; await sleep(30); return context; } };
    const dir = `/tmp/jobagent-fake-profile-${process.pid}`;
    const sessions = await Promise.all([1, 2, 3].map(() => createBrowserSession({ userDataDir: dir, deps: { chromium } })));
    expect(launches).toBe(1);
    expect(sessions).toHaveLength(3);
  });
});
