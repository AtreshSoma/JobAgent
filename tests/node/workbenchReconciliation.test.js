/**
 * The one-page workbench contract: every summary-strip metric must reconcile
 * EXACTLY with the filtered list its click applies — a metric that says 7 must
 * show 7 rows. Pins the stat definition and the boardPage filter to the same
 * records on a seeded database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import { dashboardStats, boardPage } from '../../src/dashboard/data.js';

const NOW = new Date('2026-07-11T12:00:00Z');
const FRESH = '2026-07-11T02:00:00Z'; // posted 10h before NOW
const TODAY = '2026-07-11T08:00:00Z';
const LAST_WEEK = '2026-07-06T08:00:00Z';
const OLD = '2026-06-01T08:00:00Z';

describe('summary metrics reconcile with their click-through filters', () => {
  let db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    const rows = [
      // Two strong fits POSTED in the last 24h (one gated) -> qualifiedToday = 2.
      // "New qualified" is truthful freshness: posted <24h, never merely
      // "entered our database today".
      { id: 'q1', company: 'A', title: 'DE', score: 88, tier: 'Priority', sponsorship: 'Likely', status: 'scored', posted_at: FRESH, created_at: TODAY },
      { id: 'q2', company: 'B', title: 'DE', score: 80, tier: 'Queue', sponsorship: 'Unconfirmed', status: 'scored', posted_at: FRESH, created_at: TODAY },
      // Fresh strong fit but REJECTED -> excluded everywhere.
      { id: 'q3', company: 'C', title: 'DE', score: 90, tier: 'Priority', sponsorship: 'Likely', status: 'scored', posted_at: FRESH, created_at: TODAY, user_decision: 'rejected' },
      // Strong fit discovered today but POSTED long ago -> NOT "new qualified".
      { id: 'q4', company: 'C2', title: 'DE', score: 89, tier: 'Priority', sponsorship: 'Likely', status: 'scored', posted_at: OLD, created_at: TODAY },
      // Old gated strong fit -> sponsorship check but NOT qualifiedToday.
      { id: 's1', company: 'D', title: 'DE', score: 78, tier: 'Queue', sponsorship: 'Unconfirmed', status: 'scored', posted_at: OLD, created_at: OLD },
      // Blocked + ready_for_submit rows.
      { id: 'b1', company: 'E', title: 'DE', score: 70, tier: 'Queue', sponsorship: 'Likely', status: 'assist_blocked', created_at: OLD },
      { id: 'r1', company: 'F', title: 'DE', score: 82, tier: 'Apply', sponsorship: 'Confirmed', status: 'ready_for_submit', created_at: OLD },
      // Submitted: one this week, one long ago.
      { id: 'w1', company: 'G', title: 'DE', score: 82, tier: 'Apply', sponsorship: 'Confirmed', status: 'submitted', applied: 1, applied_at: LAST_WEEK, created_at: OLD },
      { id: 'w2', company: 'H', title: 'DE', score: 82, tier: 'Apply', sponsorship: 'Confirmed', status: 'submitted', applied: 1, applied_at: OLD, created_at: OLD },
      // Noise: weak fit + discarded.
      { id: 'n1', company: 'I', title: 'Analyst', score: 52, tier: 'Near miss', sponsorship: 'Unconfirmed', status: 'scored', created_at: TODAY },
      { id: 'n2', company: 'J', title: 'Clerk', score: 10, tier: 'Discard', sponsorship: 'Unconfirmed', status: 'discarded', created_at: TODAY },
    ];
    for (const r of rows) db.upsertJob(r);
  });
  afterEach(() => db.close());

  const metricToFilter = [
    ['qualifiedToday', { qualifiedToday: 'true' }],
    ['pendingReview', { appStatus: 'needs_review' }],
    ['needsSponsorshipCheck', { sponsorshipGated: 'true' }],
    ['readyForSubmit', { appStatus: 'ready_for_submit' }],
    ['blocked', { appStatus: 'blocked' }],
    ['submittedThisWeek', { submittedThisWeek: 'true' }],
  ];

  it('every metric equals the total of the list its click filters to', () => {
    const stats = dashboardStats(db, { now: NOW });
    for (const [metric, filters] of metricToFilter) {
      const page = boardPage(db, { ...filters, now: NOW, limit: 100 });
      expect(page.total, `${metric} must reconcile with ${JSON.stringify(filters)}`)
        .toBe(stats.totals[metric]);
    }
  });

  it('pins the seeded expectations (guards against silently-empty reconciliation)', () => {
    const stats = dashboardStats(db, { now: NOW });
    expect(stats.totals.qualifiedToday).toBe(2);      // q1 + q2, NOT rejected q3
    expect(stats.totals.needsSponsorshipCheck).toBe(2); // q2 + s1 (q4 is not gated)
    expect(stats.totals.blocked).toBe(1);
    expect(stats.totals.readyForSubmit).toBe(1);
    expect(stats.totals.submittedThisWeek).toBe(1);   // w1 only — w2 is too old
  });

  it('rejected and stale-posted strong matches never appear in the new-qualified click-through', () => {
    const page = boardPage(db, { qualifiedToday: 'true', now: NOW });
    expect(page.jobs.map((j) => j.id).sort()).toEqual(['q1', 'q2']); // no q3 (rejected), no q4 (old posting)
  });
});

describe('workflow tabs and fit cards reconcile with their filters', () => {
  let db;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    const seed = [
      { id: 't1', company: 'A', title: 'DE', score: 88, tier: 'Priority', sponsorship: 'Likely', status: 'scored', posted_at: '2026-07-11T02:00:00Z' },
      { id: 't2', company: 'B', title: 'DE', score: 66, tier: 'Queue', sponsorship: 'Likely', status: 'scored' },
      { id: 't3', company: 'C', title: 'DE', score: 55, tier: 'Near miss', sponsorship: 'Unconfirmed', status: 'scored' },
      { id: 't4', company: 'D', title: 'DE', score: 82, tier: 'Apply', sponsorship: 'Confirmed', status: 'assist_blocked' },
      { id: 't5', company: 'E', title: 'DE', score: 82, tier: 'Apply', sponsorship: 'Confirmed', status: 'ready_for_submit' },
      { id: 't6', company: 'F', title: 'DE', score: 82, tier: 'Apply', sponsorship: 'Confirmed', status: 'submitted', applied: 1, applied_at: '2026-07-10T00:00:00Z' },
      { id: 't7', company: 'G', title: 'DE', score: 79, tier: 'Apply', sponsorship: 'Likely', status: 'scored', user_decision: 'shortlisted' },
      { id: 't8', company: 'H', title: 'DE', score: 40, tier: 'Discard', sponsorship: 'Unconfirmed', status: 'discarded' },
      { id: 't9', company: 'I', title: 'DE', score: null, tier: null, sponsorship: null, status: 'unknown_date_review' },
    ];
    for (const r of seed) db.upsertJob(r);
  });
  afterEach(() => db.close());

  it('every workflow tab count equals its view-filtered list total', () => {
    const stats = dashboardStats(db, { now: NOW });
    for (const view of ['all', 'best', 'shortlisted', 'needs_review', 'ready_apply', 'blocked', 'submitted']) {
      const page = boardPage(db, { view, now: NOW, limit: 100 });
      expect(page.total, `tab "${view}" must reconcile`).toBe(stats.views[view]);
    }
  });

  it('fit cards (strong/medium/weak/date-check) reconcile with their click-through filters', () => {
    const stats = dashboardStats(db, { now: NOW });
    expect(boardPage(db, { fit: 'strong', now: NOW }).total).toBe(stats.totals.strongFit);
    expect(boardPage(db, { fit: 'medium', now: NOW }).total).toBe(stats.totals.mediumFit);
    expect(boardPage(db, { fit: 'weak', now: NOW }).total).toBe(stats.totals.weakFit);
    expect(boardPage(db, { appStatus: 'date_unconfirmed', now: NOW }).total).toBe(stats.totals.dateUnconfirmed);
  });

  it('hideClosed=false reveals closed rows without breaking the default view', () => {
    const open = boardPage(db, { now: NOW });
    const all = boardPage(db, { hideClosed: 'false', now: NOW });
    expect(all.total).toBeGreaterThan(open.total); // discarded t8 appears
    expect(all.jobs.some((j) => j.id === 't8')).toBe(true);
    expect(open.jobs.some((j) => j.id === 't8')).toBe(false);
  });
});
