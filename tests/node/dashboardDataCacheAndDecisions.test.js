import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import {
  dashboardStats, boardPage, applyDecision, undoDecision, markSubmittedByHuman, jobDetail,
  noteUserMutation, DECISION_REASONS,
} from '../../src/dashboard/data.js';

const NOW = new Date('2026-09-22T15:00:00.000Z');

function seed(db) {
  db.upsertJob({ id: 'a', title: 'Data Engineer', company: 'Acme', status: 'scored', score: 88, tier: 'Priority',
    sponsorship: 'Confirmed', posted_at: '2026-09-22T10:00:00.000Z', created_at: '2026-09-22T10:00:00.000Z' });
  db.upsertJob({ id: 'b', title: 'Analyst', company: 'Beta', status: 'scored', score: 70, tier: 'Queue',
    sponsorship: 'Unconfirmed', posted_at: '2026-09-15T10:00:00.000Z' });
  db.upsertJob({ id: 'c', title: 'Old', company: 'Gamma', status: 'discarded', score: 20, tier: 'Discard',
    sponsorship: 'Denied' });
  db.upsertJob({ id: 'd', title: 'Unread', company: 'Delta', status: 'scored', score: 60, tier: 'Queue' });
}

describe('dashboard caches — keyed by data, not by a 30 s clock', () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('sees a write from ANOTHER connection (PRAGMA data_version)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobagent-cache-'));
    dirs.push(dir);
    const path = join(dir, 'jobs.db');
    const dash = openDatabase({ path });
    seed(dash);
    const cli = openDatabase({ path });
    expect(dashboardStats(dash, { now: NOW }).totals.jobsTracked).toBe(4);
    cli.upsertJob({ id: 'e', title: 'New from CLI', status: 'scored', score: 90, tier: 'Priority' });
    // Same instant: the old key (total_changes + 30 s bucket) would have hit.
    expect(dashboardStats(dash, { now: NOW }).totals.jobsTracked).toBe(5);
    cli.close();
    dash.close();
  });

  it('refreshes time-derived row labels without rebuilding, and a user mutation invalidates', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const first = boardPage(db, { now: NOW, view: 'all' }).jobs.find((j) => j.id === 'a');
    expect(first.postedLast24h).toBe(true);
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    const again = boardPage(db, { now: later, view: 'all' }).jobs.find((j) => j.id === 'a');
    expect(again).toBe(first); // same cached object ...
    expect(again.postedLast24h).toBe(false); // ... with its clock fields refreshed
    noteUserMutation();
    const rebuilt = boardPage(db, { now: later, view: 'all' }).jobs.find((j) => j.id === 'a');
    expect(rebuilt).not.toBe(first);
    db.close();
  });

  it('stats stale-while-revalidate: serves the cached value flagged stale, recomputes once in the background', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobagent-swr-'));
    dirs.push(dir);
    const path = join(dir, 'jobs.db');
    const dash = openDatabase({ path });
    seed(dash);
    const cli = openDatabase({ path });
    const first = dashboardStats(dash, { now: NOW, allowStale: true });
    expect(first.stale).toBeUndefined();
    cli.upsertJob({ id: 'e', status: 'scored', score: 90, tier: 'Priority' });
    const stale = dashboardStats(dash, { now: NOW, allowStale: true });
    expect(stale.stale).toBe(true);
    expect(stale.totals.jobsTracked).toBe(4);
    // A second request while the refresh is pending does not start another.
    expect(dashboardStats(dash, { now: NOW, allowStale: true }).stale).toBe(true);
    await new Promise((r) => setImmediate(r));
    const fresh = dashboardStats(dash, { now: NOW, allowStale: true });
    expect(fresh.stale).toBeUndefined();
    expect(fresh.totals.jobsTracked).toBe(5);
    // The user's OWN action is always reflected synchronously.
    applyDecision(dash, 'a', 'shortlisted');
    const own = dashboardStats(dash, { now: NOW, allowStale: true });
    expect(own.stale).toBeUndefined();
    expect(own.totals.shortlisted).toBe(1);
    cli.close();
    dash.close();
  });
});

describe('A3 — sponsorshipOpen counts actionable rows only', () => {
  it('breaks down open, unsubmitted rows and reports unclassified ones apart', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    db.upsertJob({ id: 's', status: 'scored', score: 80, tier: 'Apply', sponsorship: 'Likely', applied: 1 });
    const stats = dashboardStats(db, { now: NOW });
    expect(stats.sponsorshipOpen).toEqual({ confirmed: 1, likely: 0, unconfirmed: 1, denied: 0, notEvaluated: 1 });
    expect(stats.bySponsorship.Denied.count).toBe(1); // the old whole-table field is unchanged
    db.close();
  });
});

describe('A2 — decision reasons and single-decision undo', () => {
  it('persists a reason + note, exposes it on rows and detail, and undoes exactly', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    expect(DECISION_REASONS).toContain('salary');
    const r = applyDecision(db, 'b', 'rejected', { reason: 'salary', reasonNote: 'x'.repeat(300) });
    expect(r).toMatchObject({ id: 'b', userDecision: 'rejected', decisionReason: 'salary', appStatus: 'rejected' });
    const detail = jobDetail(db, 'b', { now: NOW });
    expect(detail.decisionReason).toBe('salary');
    expect(detail.decisionReasonNote).toHaveLength(200);
    const row = boardPage(db, { now: NOW, includeClosed: true }).jobs.find((j) => j.id === 'b');
    expect(row.decisionReason).toBe('salary');

    applyDecision(db, 'b', 'archived', { reason: 'stale' });
    expect(undoDecision(db, 'b')).toMatchObject({ userDecision: 'rejected', decisionReason: 'salary', undone: true });
    // Undo reverts the LAST decision only; undoing an undo is refused.
    expect(() => undoDecision(db, 'b')).toThrow(/nothing|no decision/);
    db.close();
  });

  it('rejects an unknown reason and a non-text note, and 409s an undo with nothing to undo', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    expect(() => applyDecision(db, 'a', 'rejected', { reason: 'vibes' })).toThrow(/invalid reason/);
    expect(() => applyDecision(db, 'a', 'rejected', { reasonNote: 5 })).toThrow(/reasonNote/);
    try { undoDecision(db, 'a'); throw new Error('no'); } catch (err) { expect(err.statusCode).toBe(409); }
    db.close();
  });
});

describe('S7a — markSubmittedByHuman never downgrades a submission', () => {
  it('an unverified report on a submitted job only appends the note', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j', status: 'ready_for_submit' });
    markSubmittedByHuman(db, 'j', { verified: true, now: NOW, confirmationNumber: 'C-1' });
    const again = markSubmittedByHuman(db, 'j', { verified: false, note: 'double click', now: NOW });
    expect(again).toMatchObject({ appStatus: 'submitted', alreadySubmitted: true, confirmationNumber: 'C-1' });
    const row = db.getJob('j');
    expect(row).toMatchObject({ applied: 1, status: 'submitted', applied_at: NOW.toISOString() });
    expect(row.notes).toMatch(/double click/);
    expect(db.listEvents('j').filter((e) => e.event_type === 'status_changed')).toHaveLength(1);
    db.close();
  });

  it('a human may report a submission from a scored row (lifecycle actor=human)', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'k', status: 'scored', score: 80 });
    expect(markSubmittedByHuman(db, 'k', { verified: false, now: NOW }).appStatus).toBe('submit_unverified');
    expect(markSubmittedByHuman(db, 'k', { verified: true, now: NOW }).appStatus).toBe('submitted');
    db.close();
  });
});
