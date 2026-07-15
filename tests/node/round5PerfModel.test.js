import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { dashboardStats, boardPage } from '../../src/dashboard/data.js';

const job = (id, extra = {}) => ({
  id, source: 'greenhouse', company: `Co ${id}`, title: 'Data Engineer',
  location: 'Remote, US', url: `https://x.example/${id}`, jd_text: 'Azure SQL',
  posted_at: new Date().toISOString(), score: 80, tier: 'Apply',
  sponsorship: 'Likely', status: 'scored', ...extra,
});

describe('round 5 / P3: archival flag semantics', () => {
  let db;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => db.close());

  it('archives pipeline discards and user rejected/archived rows, never applied ones', () => {
    db.upsertJob(job('hot'));
    db.upsertJob(job('disc', { status: 'discarded' }));
    db.upsertJob(job('rej'));
    db.setUserDecision('rej', 'rejected');
    db.upsertJob(job('done', { status: 'discarded', applied: 1, applied_at: new Date().toISOString() }));

    expect(db.getJob('hot').archived_at).toBeNull();
    expect(db.getJob('disc').archived_at).toBeTruthy();
    expect(db.getJob('rej').archived_at).toBeTruthy();
    expect(db.getJob('done').archived_at).toBeNull(); // applied rows stay hot
  });

  it('clears the flag when a row becomes active again (re-score / cleared decision)', () => {
    db.upsertJob(job('a', { status: 'discarded' }));
    expect(db.getJob('a').archived_at).toBeTruthy();
    db.upsertJob({ id: 'a', status: 'scored' }); // re-score resurrects it
    expect(db.getJob('a').archived_at).toBeNull();

    db.setUserDecision('a', 'archived');
    expect(db.getJob('a').archived_at).toBeTruthy();
    db.setUserDecision('a', null); // decision cleared -> back on the board
    expect(db.getJob('a').archived_at).toBeNull();
  });

  it('a shortlisted job is never archived even if its status is discarded', () => {
    db.upsertJob(job('s', { status: 'discarded', user_decision: 'shortlisted' }));
    expect(db.getJob('s').archived_at).toBeNull();
  });

  it('hot summary excludes archived rows; includeArchived restores them', () => {
    db.upsertJob(job('hot'));
    db.upsertJob(job('cold', { status: 'discarded' }));
    expect(db.listJobsSummary().map((r) => r.id)).toEqual(['hot']);
    expect(db.listJobsSummary({ includeArchived: true }).length).toBe(2);
  });

  it('DEDUPE HARD CONSTRAINT: every "already known" check still sees archived rows', () => {
    db.upsertJob(job('cold', { status: 'discarded' }));
    expect(db.jobExists('cold')).toBe(true);
    expect(db.getKnownJobIds().has('cold')).toBe(true);
    expect(db.getJob('cold')).not.toBeNull();
    expect(db.listJobs({}).map((r) => r.id)).toContain('cold');
  });

  it('board: closed rows hidden by default, reachable via an explicit closed-status filter', () => {
    db.upsertJob(job('hot'));
    db.upsertJob(job('rej'));
    db.setUserDecision('rej', 'rejected');
    expect(boardPage(db, {}).jobs.map((r) => r.id)).toEqual(['hot']);
    expect(boardPage(db, { appStatus: 'rejected' }).jobs.map((r) => r.id)).toEqual(['rej']);
    expect(boardPage(db, { hideClosed: false }).total).toBe(2);
  });

  it('stats still count ALL rows (archived included) so tile totals stay truthful', () => {
    db.upsertJob(job('hot'));
    db.upsertJob(job('cold', { status: 'discarded' }));
    expect(dashboardStats(db).totals.jobsTracked).toBe(2);
  });

  it('sponsorship and archival indexes exist', () => {
    const names = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    expect(names).toContain('idx_jobs_sponsorship');
    expect(names).toContain('idx_jobs_archived');
  });
});

describe('round 5 / P2: invalidate-on-write caching', () => {
  let db;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => db.close());

  it('same-connection writes invalidate: upsertJob', () => {
    db.upsertJob(job('a'));
    expect(dashboardStats(db).totals.jobsTracked).toBe(1);
    db.upsertJob(job('b'));
    expect(dashboardStats(db).totals.jobsTracked).toBe(2);
  });

  it('same-connection writes invalidate: setUserDecision (incl. archival sync)', () => {
    db.upsertJob(job('a'));
    db.upsertJob(job('b'));
    expect(boardPage(db, {}).total).toBe(2);
    db.setUserDecision('b', 'archived');
    expect(boardPage(db, {}).total).toBe(1);
  });

  it('same-connection writes invalidate: approval-queue rows', () => {
    db.upsertJob(job('a'));
    db.insertApproval({
      id: 'ap1', job_id: 'a', packet_path: '/nope.json',
      approval_status: 'pending_review', approved_by_user: 0,
      approved_at: null, created_at: new Date().toISOString(),
    });
    expect(dashboardStats(db).totals.pendingReview).toBe(1);
    db.updateApprovalStatus('ap1', {
      approval_status: 'approved', approved_by_user: 1, approved_at: new Date().toISOString(),
    });
    expect(dashboardStats(db).totals.pendingReview).toBe(0);
  });

  it('unchanged data is served from cache (no TTL expiry recompute)', () => {
    db.upsertJob(job('a'));
    const first = dashboardStats(db);
    const second = dashboardStats(db, { now: new Date(Date.now() + 10 * 60_000) });
    expect(second).toBe(first); // same object => cache hit even 10 minutes later
  });

  it('CROSS-CONNECTION writes invalidate via data_version (maintenance scripts, watch CLI)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'r5-inval-'));
    const path = join(dir, 'jobs.db');
    const reader = openDatabase({ path });
    try {
      reader.upsertJob(job('a'));
      expect(dashboardStats(reader).totals.jobsTracked).toBe(1);

      // Simulate repair-applied-status.mjs / watch: a SEPARATE connection writes.
      const writer = openDatabase({ path });
      writer.upsertJob(job('external'));
      writer.close();

      expect(dashboardStats(reader).totals.jobsTracked).toBe(2);
    } finally {
      reader.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
