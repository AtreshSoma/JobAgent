/**
 * Posting-age windows on the board.
 *
 * The segmented control and the filter share one allowlist (`POSTED_WINDOWS`).
 * They used to drift: the filter hardcoded `[3, 6, 24]` and SILENTLY IGNORED
 * anything else, so a chip offering a window the filter did not know would
 * render as active over a completely unfiltered board — the same class of lie
 * as a tab badge that disagrees with the rows it opens.
 *
 * 3d and 1w exist because of where the jobs actually are: one measured run held
 * 5 postings under 24 hours old and 4,439 under a week.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { POSTED_WINDOWS, boardPage, dashboardStats } from '../../src/dashboard/data.js';

const HOUR = 3600_000;

/** Minimal in-memory stand-in for the Database wrapper the board reads. */
function fakeDb(jobs) {
  return {
    listJobsSummary: () => jobs,
    listJobs: () => jobs,
    listApprovals: () => [],
  };
}

const at = (hoursAgo) => new Date(Date.now() - hoursAgo * HOUR).toISOString();

const job = (id, hoursAgo) => ({
  id,
  source: 'workday',
  company: 'Acme',
  title: 'Senior Data Engineer',
  url: `https://acme.wd1.myworkdayjobs.com/Careers/job/X/Y_${id}`,
  posted_at: hoursAgo === null ? null : at(hoursAgo),
  created_at: at(1),
  score: 80,
  tier: 'Queue',
  status: 'scored',
});

const JOBS = [
  job('h1', 1), // 1 hour
  job('h5', 5), // 5 hours
  job('h20', 20), // 20 hours
  job('d2', 48), // 2 days
  job('d5', 120), // 5 days
  job('d20', 480), // 20 days
  job('none', null), // undated
];

describe('POSTED_WINDOWS', () => {
  it('offers a week, which is where the jobs actually are', () => {
    expect(POSTED_WINDOWS).toContain(168);
  });

  it('is the single source of truth shared with the segmented control', () => {
    // Any button offering a window the filter does not honor would look active
    // over an unfiltered board.
    const html = readFileSync(join(process.cwd(), 'src/dashboard/public/index.html'), 'utf8');
    const offered = [...html.matchAll(/data-action="set-posted"\s+data-value="(\d+)"/g)]
      .map((m) => Number(m[1]));
    expect(offered.length).toBeGreaterThan(0);
    for (const v of offered) expect(POSTED_WINDOWS).toContain(v);
  });
});

describe('board filtering by posting age', () => {
  const db = fakeDb(JOBS);
  const total = (hours) => boardPage(db, { postedWithinHours: hours, limit: 100 }).total;

  it('narrows correctly at each offered window', () => {
    expect(total(3)).toBe(1); // h1
    expect(total(6)).toBe(2); // h1, h5
    expect(total(24)).toBe(3); // + h20
    expect(total(72)).toBe(4); // + d2
    expect(total(168)).toBe(5); // + d5
  });

  it('excludes undated jobs from every window', () => {
    // A job with no posting date cannot be claimed to be from the last week.
    for (const w of POSTED_WINDOWS) {
      const ids = boardPage(db, { postedWithinHours: w, limit: 100 }).jobs.map((j) => j.id);
      expect(ids).not.toContain('none');
    }
  });

  it('shows everything when no window is selected', () => {
    expect(boardPage(db, { limit: 100 }).total).toBe(JOBS.length);
    expect(boardPage(db, { postedWithinHours: '', limit: 100 }).total).toBe(JOBS.length);
  });

  it('accepts the value as a string, which is how the UI sends it', () => {
    expect(total('168')).toBe(5);
  });
});

describe('header counts reconcile with the filter they open', () => {
  it('"posted 1w" equals the rows its chip opens', () => {
    const db = fakeDb(JOBS);
    const stats = dashboardStats(db, { now: new Date() });
    const rows = boardPage(db, { postedWithinHours: 168, limit: 100 }).total;
    expect(stats.totals.postedLast7d).toBe(rows);
  });

  it('"posted 24h" still equals the rows its chip opens', () => {
    const db = fakeDb(JOBS);
    const stats = dashboardStats(db, { now: new Date() });
    expect(stats.totals.postedLast24h).toBe(boardPage(db, { postedWithinHours: 24, limit: 100 }).total);
  });

  it('counts only actionable jobs, matching the board that hides closed ones', () => {
    const withClosed = fakeDb([...JOBS, { ...job('closed', 2), status: 'discarded' }]);
    const stats = dashboardStats(withClosed, { now: new Date() });
    expect(stats.totals.postedLast7d).toBe(boardPage(withClosed, { postedWithinHours: 168, limit: 100 }).total);
  });
});
