/**
 * P1C — the Applications workspace, refined: recorded outcomes in both CSV
 * exports, a weekly summary, and one scope (every search) for every count and
 * list that describes applications. In-memory databases and temp roots only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import {
  applicationsWorkspace, recordOutcome, updateFollowUp, undoOutcome, buildExportRows, exportRowsToCsv, dashboardStats, listBoardJobs,
} from '../../src/dashboard/data.js';
import { writeJobTracker } from '../../src/reports/jobTracker.js';
import { weeklySummary, shiftDay, outcomeExport, OUTCOME_EVENT } from '../../src/domain/applicationOutcome.js';

const NOW = new Date('2026-10-20T15:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 864e5).toISOString();
const js = (f) => readFileSync(new URL(`../../src/dashboard/public/assets/js/${f}`, import.meta.url), 'utf8');

let db;
beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  db.onWarning = () => {};
  db.upsertJob({ id: 'a1', company: 'Acme', title: 'Charge Nurse', status: 'submitted', applied: 1, applied_at: daysAgo(3), score: 80, tier: 'Apply' });
  db.upsertJob({ id: 'a2', company: 'Acme', title: 'Clinical Educator', status: 'submitted', applied: 1, applied_at: daysAgo(30), score: 70, tier: 'Apply' });
  db.upsertJob({ id: 'p1', company: 'Globex', title: 'Accountant', status: 'prepared', score: 75, tier: 'Apply' });
  db.insertApproval({ id: 'ap-p1', job_id: 'p1', approval_status: 'pending_review' });
  // Prepared from an ad-hoc role search: still the user's application.
  db.upsertJob({ id: 'r1', company: 'Initech', title: 'Paralegal', status: 'prepared', score: 72, tier: 'Apply',
    discovery_mode: 'role_search', search_query: 'paralegal' });
  db.insertApproval({ id: 'ap-r1', job_id: 'r1', approval_status: 'pending_review' });
  db.upsertJob({ id: 's1', company: 'Hooli', title: 'Scored only', status: 'scored', score: 90, tier: 'Priority' });
});
afterEach(() => db.close());

describe('recorded outcomes in the exports', () => {
  it('appends Outcome columns to the tracker CSV, filled only for submitted applications', () => {
    recordOutcome(db, 'a2', { outcome: 'interviewing', on: '2026-10-01', now: NOW });
    recordOutcome(db, 'a2', { outcome: 'rejected', on: '2026-10-15', now: NOW });
    updateFollowUp(db, 'a1', { action: 'set', dueOn: '2026-10-27', now: NOW });
    const root = mkdtempSync(join(tmpdir(), 'tracker-'));
    try {
      writeJobTracker(db, root);
      const [header, ...lines] = readFileSync(join(root, 'data', 'job_tracker.csv'), 'utf8').split('\n');
      const cols = header.split(',');
      expect(cols.slice(-5)).toEqual(['Job ID', 'Outcome', 'Outcome Date', 'Outcome History', 'Follow-up Due']);
      const row = (id) => lines.find((l) => l.includes(`,${id},`) || l.split(',').includes(id));
      expect(row('a2')).toContain('Rejected by employer,2026-10-15,Interviewing 2026-10-01; Rejected by employer 2026-10-15,');
      expect(row('a1')).toMatch(/Awaiting response,,,2026-10-27$/);
      expect(row('s1')).toMatch(/,s1,,,,$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('carries the same outcome cells in the jobs export', () => {
    recordOutcome(db, 'a1', { outcome: 'offer', on: '2026-10-19', now: NOW });
    const rows = buildExportRows(db, { now: NOW });
    expect(rows.find((r) => r.title === 'Charge Nurse')).toMatchObject({ outcome: 'Offer received', outcomeDate: '2026-10-19' });
    expect(rows.find((r) => r.title === 'Scored only')).toMatchObject({ outcome: '', outcomeDate: '' });
    expect(exportRowsToCsv(rows).split('\n')[0]).toContain('Outcome,Outcome date,Outcome history,Follow-up due');
  });

  it('leaves an undone outcome out of the history, and a closed application without a follow-up', () => {
    const ev = (meta, at) => ({ event_type: OUTCOME_EVENT, metadata: JSON.stringify(meta), created_at: at });
    expect(outcomeExport([ev({ outcome: 'offer', on: '2026-10-02' }, '1'), ev({ undo: true }, '2')]))
      .toEqual({ outcome: 'Awaiting response', outcomeDate: '', outcomeHistory: '', followUpDue: '' });
  });
});

describe('weekly summary', () => {
  it('counts what happened in the last seven days and what is due in the next seven', () => {
    recordOutcome(db, 'a1', { outcome: 'interviewing', on: '2026-10-18', now: NOW });
    recordOutcome(db, 'a2', { outcome: 'rejected', on: '2026-10-01', now: NOW }); // older than the week
    updateFollowUp(db, 'a1', { action: 'set', dueOn: '2026-10-25', now: NOW });
    const { weekly } = applicationsWorkspace(db, { now: NOW });
    expect(weekly).toEqual({
      from: '2026-10-14', to: '2026-10-20', submitted: 1,
      responses: { interviewing: 1, offer: 0, hired: 0, rejected: 0, withdrawn: 0 }, responsesTotal: 1,
      followUpsDone: 0, followUpsDueSoon: 1, followUpsOverdue: 0,
    });
  });

  it('counts completed follow-ups and ignores undone outcomes', () => {
    // Events are stamped with the real clock, so this one runs in real time.
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    updateFollowUp(db, 'a1', { action: 'set', dueOn: today, now });
    updateFollowUp(db, 'a1', { action: 'done', now });
    recordOutcome(db, 'a1', { outcome: 'offer', on: today, now });
    undoOutcome(db, 'a1', { now });
    const { weekly } = applicationsWorkspace(db, { now });
    expect(weekly.followUpsDone).toBe(1);
    expect(weekly.responsesTotal).toBe(0);
  });

  it('works across month boundaries', () => {
    expect(shiftDay('2026-03-02', -6)).toBe('2026-02-24');
    expect(weeklySummary({ items: [], today: '2026-01-03' }).from).toBe('2025-12-28');
  });

  it('is shown as one sentence that names only what happened', () => {
    const w = js('workspace.js');
    expect(w).toContain("const first = done.length ? `This week: ${done.join(' · ')}.` : 'Nothing recorded this week yet.';");
    expect(w).toContain("if (!m.submitted) {");
  });
});

describe('one scope for applications', () => {
  it('counts a role-search application in the stats, the list and the board alike', () => {
    const stats = dashboardStats(db, { now: NOW });
    const list = listBoardJobs(db, { now: NOW, view: 'needs_review', discoveryMode: 'all' }).map((r) => r.id).sort();
    const board = applicationsWorkspace(db, { now: NOW }).items.filter((i) => i.stage === 'review').map((i) => i.id).sort();
    expect(list).toEqual(['p1', 'r1']);
    expect(board).toEqual(list);
    expect(stats.views.needs_review).toBe(2);
    expect(stats.totals.pendingReview).toBe(2);
    expect(stats.nextActions.find((a) => a.verb === 'Approve prepared packets')?.count).toBe(2);
    // The personalized Jobs board is unchanged: the role-search row stays out of it.
    expect(listBoardJobs(db, { now: NOW }).map((r) => r.id)).not.toContain('r1');
  });

  it('makes the Applications list read every search, and only that view', () => {
    const filters = js('filters.js');
    expect(filters).toContain("if (applications) p.set('discoveryMode', 'all');");
    expect(filters).toContain("else if (state.discoveryMode === 'role_search') {");
  });
});
