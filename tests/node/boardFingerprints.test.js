/**
 * Skip boards that have not changed (audit D1, Workday first).
 *
 * Every search re-read every page of every Workday board. A board's first page
 * says what it holds: the total and the newest postings. When both match the
 * last run, the remaining pages are skipped. Three things keep this honest:
 *
 *   - every few days a full sweep reads everything regardless;
 *   - a run that skipped anything is reported as not a full listing, so the
 *     expiry pass (which retires rows a source stopped listing) never counts
 *     it as evidence a posting is gone;
 *   - a board whose walk had an error is not recorded as known.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBoardFingerprints, listingFingerprint } from '../../src/search/boardFingerprints.js';
import { run as runWorkday } from '../../src/search/adapters/workday.js';
import { createHostGate } from '../../src/utils/hostGate.js';

const DAY = 86_400_000;
let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jobagent-fp-')); mkdirSync(join(root, 'data'), { recursive: true }); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('listingFingerprint', () => {
  it('changes when the total or the first page changes, not otherwise', () => {
    const a = listingFingerprint(45, [{ externalPath: '/job/1' }, { externalPath: '/job/2' }]);
    expect(listingFingerprint(45, [{ externalPath: '/job/1' }, { externalPath: '/job/2' }])).toBe(a);
    expect(listingFingerprint(46, [{ externalPath: '/job/1' }, { externalPath: '/job/2' }])).not.toBe(a);
    expect(listingFingerprint(45, [{ externalPath: '/job/3' }, { externalPath: '/job/2' }])).not.toBe(a);
  });
});

describe('the store', () => {
  it('starts with a full sweep, remembers boards, and asks for another sweep after three days', () => {
    let t = Date.parse('2026-11-16T07:00:00Z');
    const first = createBoardFingerprints({ root, now: () => t });
    expect(first.fullSweep).toBe(true);
    first.record('b', 'fp1');
    first.finishRun({ completed: true });
    first.save();
    t += DAY;
    const next = createBoardFingerprints({ root, now: () => t });
    expect(next.fullSweep).toBe(false);
    expect(next.unchanged('b', 'fp1')).toBe(true);
    expect(next.unchanged('b', 'fp2')).toBe(false);
    t += 3 * DAY;
    expect(createBoardFingerprints({ root, now: () => t }).fullSweep).toBe(true);
  });

  it('a sweep that did not complete does not count as one', () => {
    const s = createBoardFingerprints({ root });
    s.finishRun({ completed: false });
    s.save();
    expect(createBoardFingerprints({ root }).fullSweep).toBe(true);
  });
});

describe('the Workday adapter', () => {
  const tenant = { host: 'acme.wd1.myworkdayjobs.com', tenant: 'acme', site: 'Ext', searchText: '' };
  const posting = (i) => ({ title: `Data Engineer ${i}`, externalPath: `/job/Remote/Data-Engineer_R${i}`, postedOn: 'Posted Today', locationsText: 'Remote, US' });

  function board(total) {
    const calls = [];
    const fetchImpl = async (_url, init) => {
      const { offset } = JSON.parse(init.body);
      calls.push(offset);
      const page = Array.from({ length: Math.max(0, Math.min(20, total - offset)) }, (_, i) => posting(offset + i));
      return { ok: true, status: 200, json: async () => ({ total: offset === 0 ? total : 0, jobPostings: page }) };
    };
    return { fetchImpl, calls };
  }
  const go = (fetchImpl, store) => runWorkday({ tenants: [tenant], fetchDetails: false }, {
    fetchImpl, hostGate: createHostGate({ maxConcurrent: 4 }), maxRetries: 0, boardFingerprints: store,
  });

  it('reads every page on a full sweep, then only the first page while nothing changes', async () => {
    let t = Date.parse('2026-11-16T07:00:00Z');
    const a = board(45);
    const s1 = createBoardFingerprints({ root, now: () => t });
    const r1 = await go(a.fetchImpl, s1);
    expect(a.calls.sort((x, y) => x - y)).toEqual([0, 20, 40]);
    expect(r1.jobs).toHaveLength(45);
    expect(r1.cached).not.toBe(true);
    s1.finishRun({ completed: true }); s1.save();

    t += DAY;
    const b = board(45);
    const s2 = createBoardFingerprints({ root, now: () => t });
    const r2 = await go(b.fetchImpl, s2);
    expect(b.calls).toEqual([0]);
    expect(r2.jobs).toHaveLength(20);
    // Not a full listing: expiry must not read the missing pages as closed postings.
    expect(r2.cached).toBe(true);
    expect(r2.errors.map((e) => e.note).join(' ')).toMatch(/unchanged/i);
  });

  it('reads everything again when the board changed', async () => {
    let t = Date.parse('2026-11-16T07:00:00Z');
    const s1 = createBoardFingerprints({ root, now: () => t });
    await go(board(45).fetchImpl, s1); s1.finishRun({ completed: true }); s1.save();
    t += DAY;
    const c = board(46);
    const r = await go(c.fetchImpl, createBoardFingerprints({ root, now: () => t }));
    expect(c.calls.sort((x, y) => x - y)).toEqual([0, 20, 40]);
    expect(r.jobs).toHaveLength(46);
    expect(r.cached).not.toBe(true);
  });

  it('without a store, reads everything, as before', async () => {
    const a = board(45);
    await go(a.fetchImpl, undefined);
    await go(a.fetchImpl, undefined);
    expect(a.calls.filter((o) => o === 20)).toHaveLength(2);
  });

  it('does not remember a board whose walk had an error', async () => {
    let t = Date.parse('2026-11-16T07:00:00Z');
    const s1 = createBoardFingerprints({ root, now: () => t });
    const broken = board(45);
    const fetchImpl = async (url, init) => {
      if (JSON.parse(init.body).offset === 20) return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' };
      return broken.fetchImpl(url, init);
    };
    await go(fetchImpl, s1); s1.finishRun({ completed: true }); s1.save();
    t += DAY;
    const again = board(45);
    await go(again.fetchImpl, createBoardFingerprints({ root, now: () => t }));
    expect(again.calls.sort((x, y) => x - y)).toEqual([0, 20, 40]);
  });
});
