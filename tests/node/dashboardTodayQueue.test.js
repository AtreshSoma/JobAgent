import { describe, it, expect } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import {
  todayQueue, dashboardSections, dashboardStats, boardPage, BOARD_FIELDS, MAX_PAGE_LIMIT,
  classifyAttention, explainStatus, buildReports, buildDocuments, buildMasterResume,
} from '../../src/dashboard/data.js';

const NOW = new Date('2026-09-22T15:00:00.000Z');
const BANNER = '╔════════════════╗\n║ Executable doesn\'t exist at /x/chromium ║\n║ Please run: npx playwright install ║\n╚════════════════╝';

function seed(db) {
  const approval = (id, status) => db.insertApproval({ id: `ap-${id}`, job_id: id, approval_status: status });
  db.upsertJob({ id: 'unverified', title: 'U', status: 'submit_unverified', score: 60, tier: 'Queue' });
  db.upsertJob({ id: 'ready', title: 'R', status: 'ready_for_submit', score: 90, tier: 'Priority' });
  db.upsertJob({ id: 'question', title: 'Q', status: 'assist_blocked', score: 80, tier: 'Apply',
    assist_blockers: ['screening question needs user'] });
  db.upsertJob({ id: 'nobrowser', title: 'B', status: 'failed', score: 95, tier: 'Priority',
    assist_blockers: [`browser_unavailable: ${BANNER}`] });
  db.upsertJob({ id: 'nobrowser2', title: 'B2', status: 'assist_blocked', score: 94, tier: 'Priority',
    assist_blockers: [BANNER] });
  db.upsertJob({ id: 'review', title: 'V', status: 'prepared', score: 85, tier: 'Apply',
    application_packet_path: '/tmp/p.json' });
  approval('review', 'pending_review');
  db.upsertJob({ id: 'approved', title: 'A', status: 'prepared', score: 70, tier: 'Queue' });
  approval('approved', 'approved');
  db.upsertJob({ id: 'short', title: 'S', status: 'scored', score: 72, tier: 'Queue', user_decision: 'shortlisted' });
  db.upsertJob({ id: 'fresh', title: 'F', status: 'scored', score: 88, tier: 'Priority',
    posted_at: '2026-09-22T09:00:00.000Z' });
  db.upsertJob({ id: 'failed', title: 'X', status: 'failed', score: 50, tier: 'Queue', assist_blockers: ['timeout'] });
  db.upsertJob({ id: 'old', title: 'O', status: 'discarded', score: 10, tier: 'Discard' });
}

describe('A1 — GET /api/today contract (todayQueue)', () => {
  it('orders by urgency then score, excludes environment failures, and shapes items exactly', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const today = todayQueue(db, { now: NOW });
    expect(Object.keys(today).sort()).toEqual(['generatedAt', 'items', 'systemNotices']);
    expect(today.items.map((i) => i.id)).toEqual([
      'unverified', 'ready', 'question', 'review', 'approved', 'failed', 'short', 'fresh',
    ]);
    expect(today.items.map((i) => i.nextAction.kind)).toEqual([
      'review', 'submit', 'answer', 'approve', 'autofill', 'review', 'prepare', 'prepare',
    ]);
    for (const item of today.items) {
      expect(Object.keys(item).sort()).toEqual([
        'appStatus', 'company', 'grade', 'id', 'location', 'nextAction', 'reason', 'score', 'statusLabel',
        'tier', 'title',
      ]);
      expect(Object.keys(item.nextAction).sort()).toEqual(['kind', 'label']);
    }
    expect(today.systemNotices).toEqual([{
      code: 'browser_unavailable', severity: 'error',
      message: 'Auto-fill can’t start: the Playwright browser is not installed',
      fix: 'npx playwright install chromium',
    }]);
    db.close();
  });

  it('caps the list at 10 items', () => {
    const db = openDatabase({ path: ':memory:' });
    for (let i = 0; i < 15; i += 1) db.upsertJob({ id: `r${i}`, status: 'ready_for_submit', score: i });
    expect(todayQueue(db, { now: NOW }).items).toHaveLength(10);
    db.close();
  });

  it('reports template profile values as one notice', () => {
    const db = openDatabase({ path: ':memory:' });
    const config = { candidate: { identity: { fullName: 'Jane Doe' }, contact: { email: 'you@example.com' } } };
    const notices = todayQueue(db, { now: NOW, config }).systemNotices;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ code: 'profile_placeholders', severity: 'error' });
    expect(notices[0].fix).toMatch(/profile/i);
    db.close();
  });
});

describe('browser_unavailable is a setup problem everywhere', () => {
  it('attention, status reason, sections and next actions all say so', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const job = db.getJob('nobrowser2');
    expect(classifyAttention(job, 'blocked')).toMatchObject({ kind: 'setup_browser', label: 'Setup: browser not installed' });
    expect(explainStatus(job, 'blocked')).not.toMatch(/[╔═║╚╗╝]/);
    const sections = dashboardSections(db, { now: NOW });
    expect(sections.todaysPriorities.map((r) => r.id)).not.toContain('nobrowser');
    expect(sections.todaysPriorities.map((r) => r.id)).not.toContain('nobrowser2');
    expect(sections.todaysPriorities.map((r) => r.id)).not.toContain('failed');
    expect(sections.blockedByReason.map((g) => g.reason)).toContain('Setup: browser not installed');
    const stats = dashboardStats(db, { now: NOW });
    expect(stats.totals.blockedSetup).toBe(2);
    const verbs = stats.nextActions.map((a) => a.verb);
    expect(verbs).toContain('Setup: browser not installed');
    const unblock = stats.nextActions.find((a) => a.verb === 'Unblock applications');
    expect(unblock.count).toBe(stats.totals.blocked - 2);
    db.close();
  });
});

describe('P3 — board projection, page clamp, narrow reports and documents', () => {
  it('fields=board returns only the table fields; default is unchanged', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    const full = boardPage(db, { now: NOW });
    const slim = boardPage(db, { now: NOW, fields: 'board' });
    expect(slim.total).toBe(full.total);
    expect(Object.keys(slim.jobs[0]).sort()).toEqual([...BOARD_FIELDS].sort());
    expect(full.jobs[0]).toHaveProperty('explanation');
    expect(slim.jobs.find((j) => j.id === 'short').decision).toBe('shortlisted');
    db.close();
  });

  it('clamps limit to MAX_PAGE_LIMIT', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'x', status: 'scored', score: 1 });
    expect(boardPage(db, { now: NOW, limit: 100000 }).limit).toBe(MAX_PAGE_LIMIT);
    db.close();
  });

  it('reports still list every acted-on row, and documents / staleness read only rows with files', () => {
    const db = openDatabase({ path: ':memory:' });
    seed(db);
    db.upsertJob({ id: 'sub', status: 'submitted', applied: 1, applied_at: '2026-09-22T12:00:00.000Z', score: 70 });
    db.upsertJob({ id: 'rej', status: 'discarded', user_decision: 'rejected', score: 30 });
    const reports = buildReports(db, { now: NOW });
    expect(reports.applicationLog.map((r) => r.id)).toEqual(expect.arrayContaining(['sub', 'rej', 'ready', 'question']));
    expect(reports.preparedPackets.map((r) => r.id).sort()).toEqual(['approved', 'review']);
    let calls = 0;
    const original = db.listJobsSummary.bind(db);
    db.listJobsSummary = (...a) => { calls += 1; return original(...a); };
    const docs = buildDocuments(db, { now: NOW, readFileImpl: () => '{}' });
    expect(docs.tailored.map((d) => d.jobId)).toEqual(['review']);
    buildMasterResume(db, { root: '/nonexistent', now: NOW, statImpl: () => ({ exists: true, bytes: 1, modifiedAt: NOW.toISOString() }),
      readFileImpl: () => Buffer.from(''), listDirImpl: () => [] });
    expect(calls).toBe(0);
    db.close();
  });
});
