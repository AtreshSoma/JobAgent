import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/logging/db.js';

describe('db (node:sqlite, in-memory)', () => {
  let db;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => { db.close(); });

  it('initializes all tables', () => {
    const names = db.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'jobs', 'run_log', 'application_events', 'approval_queue',
    ]));
  });

  it('upserts and reads a job, managing timestamps', () => {
    expect(db.upsertJob({ id: 'j1', company: 'Acme', title: 'SDE', score: 80, tier: 'Apply' })).toEqual({ changes: 1 });
    const created = db.getJob('j1');
    expect(created.company).toBe('Acme');
    expect(created.created_at).toBeTruthy();
    expect(db.jobExists('j1')).toBe(true);

    db.upsertJob({ id: 'j1', score: 90, tier: 'Priority' });
    const updated = db.getJob('j1');
    expect(updated.score).toBe(90);
    expect(updated.tier).toBe('Priority');
    // created_at preserved across update
    expect(updated.created_at).toBe(created.created_at);
  });

  it('serializes array columns as JSON text', () => {
    db.upsertJob({ id: 'j2', matched_keywords: ['azure', 'pyspark'] });
    const row = db.getJob('j2');
    expect(JSON.parse(row.matched_keywords)).toEqual(['azure', 'pyspark']);
  });

  it('lists jobs filtered by tier and status', () => {
    db.upsertJob({ id: 'a', tier: 'Apply', status: 'queued', score: 70 });
    db.upsertJob({ id: 'b', tier: 'Priority', status: 'queued', score: 90 });
    expect(db.listJobs({ tier: 'Apply' }).map((j) => j.id)).toEqual(['a']);
    expect(db.listJobs({ status: 'queued' }).map((j) => j.id)).toEqual(['b', 'a']); // score desc
  });

  it('counts applied jobs on a given date', () => {
    db.upsertJob({ id: 'x', applied: 1, applied_at: '2026-06-04T10:00:00Z' });
    db.upsertJob({ id: 'y', applied: 1, applied_at: '2026-06-04T20:00:00Z' });
    db.upsertJob({ id: 'z', applied: 1, applied_at: '2026-06-05T01:00:00Z' });
    expect(db.countAppliedOn('2026-06-04')).toBe(2);
  });

  it('returns the set of every known job id (for watch incremental detection)', () => {
    db.upsertJob({ id: 'a', status: 'scored' });
    db.upsertJob({ id: 'b', status: 'discarded' });
    db.upsertJob({ id: 'c', status: 'prepared' });
    const known = db.getKnownJobIds();
    expect(known).toBeInstanceOf(Set);
    expect(known.has('a')).toBe(true);
    expect(known.has('b')).toBe(true);
    expect(known.has('c')).toBe(true);
    expect(known.has('missing')).toBe(false);
    expect(known.size).toBe(3);
  });

  it('returns the set of applied job ids for fast dedup', () => {
    db.upsertJob({ id: 'a', applied: 1, applied_at: '2026-06-04T10:00:00Z' });
    db.upsertJob({ id: 'b', score: 80 }); // not applied
    db.upsertJob({ id: 'c', applied: 1, applied_at: '2026-06-05T10:00:00Z' });
    const ids = db.getAppliedJobIds();
    expect(ids).toBeInstanceOf(Set);
    expect(ids.has('a')).toBe(true);
    expect(ids.has('c')).toBe(true);
    expect(ids.has('b')).toBe(false);
    expect(ids.size).toBe(2);
  });

  it('returns URL owners only for actionable/protected records', () => {
    db.upsertJob({ id: 'live', url: 'https://jobs.example/live', status: 'scored' });
    db.upsertJob({ id: 'closed', url: 'https://jobs.example/closed', status: 'discarded' });
    db.upsertJob({ id: 'applied', url: 'https://jobs.example/applied', status: 'submitted', applied: 1 });
    db.upsertJob({ id: 'saved', url: 'https://jobs.example/saved', status: 'discarded', user_decision: 'shortlisted' });
    expect(db.getActiveJobUrls().map((row) => row.id).sort()).toEqual(['applied', 'live', 'saved']);
  });

  it('commits a batch of writes inside a transaction', () => {
    db.transaction(() => {
      for (let i = 0; i < 5; i += 1) db.upsertJob({ id: `t${i}`, score: i });
    });
    expect(db.listJobs({}).length).toBe(5);
  });

  it('rolls back a transaction on error, leaving no partial writes', () => {
    expect(() => db.transaction(() => {
      db.upsertJob({ id: 'ok', score: 1 });
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.getJob('ok')).toBeNull();
  });

  it('records run_log lifecycle', () => {
    db.insertRunLog({ run_id: 'r1', mode: 'DRY_RUN', started_at: '2026-06-04T00:00:00Z', jobs_found: 0 });
    db.updateRunLog('r1', { jobs_found: 5, ended_at: '2026-06-04T00:05:00Z' });
    const row = db.getRunLog('r1');
    expect(row.jobs_found).toBe(5);
    expect(row.ended_at).toBe('2026-06-04T00:05:00Z');
  });

  it('inserts and lists application_events', () => {
    db.insertEvent({ id: 'e1', job_id: 'j1', event_type: 'job_found', message: 'found', metadata: { a: 1 } });
    db.insertEvent({ id: 'e2', job_id: 'j1', event_type: 'score_explained' });
    expect(db.listEvents('j1')).toHaveLength(2);
    expect(JSON.parse(db.listEvents('j1')[0].metadata)).toEqual({ a: 1 });
  });

  it('inserts and lists approvals filtered by status', () => {
    db.insertApproval({ id: 'ap1', job_id: 'j1', packet_path: '/p', approval_status: 'pending' });
    db.insertApproval({ id: 'ap2', job_id: 'j2', approval_status: 'approved', approved_by_user: true });
    expect(db.listApprovals({ status: 'pending' }).map((a) => a.id)).toEqual(['ap1']);
    expect(db.listApprovals()).toHaveLength(2);
  });

  it('throws when upserting without an id', () => {
    expect(() => db.upsertJob({ company: 'x' })).toThrow(/requires a job with an id/);
  });

  describe('reapAbandonedRuns', () => {
    // A run killed mid-flight never reaches endRun, so its row keeps ended_at
    // NULL forever and is indistinguishable from a run still in progress.
    const started = (iso) => ({ run_id: `r-${iso}`, mode: 'DRY_RUN', started_at: iso });

    it('closes runs left open by a dead process', () => {
      db.insertRunLog(started('2026-08-01T00:00:00.000Z'));
      const closed = db.reapAbandonedRuns({ now: new Date('2026-08-10T00:00:00.000Z') });
      expect(closed).toBe(1);
      const row = db.getRunLog('r-2026-08-01T00:00:00.000Z');
      // Duration is unknown, not zero-to-now: stamping the current time would
      // invent a nine-day run for a process that died in seconds.
      expect(row.ended_at).toBe('2026-08-01T00:00:00.000Z');
      expect(row.errors).toMatch(/did not report an end/);
    });

    it('leaves a recent open run alone so a concurrent run is not closed', () => {
      db.insertRunLog(started('2026-08-09T23:30:00.000Z'));
      const closed = db.reapAbandonedRuns({ now: new Date('2026-08-10T00:00:00.000Z') });
      expect(closed).toBe(0);
      expect(db.getRunLog('r-2026-08-09T23:30:00.000Z').ended_at).toBeNull();
    });

    it('never touches a run that already ended', () => {
      db.insertRunLog({ ...started('2026-08-01T00:00:00.000Z'), ended_at: '2026-08-01T00:05:00.000Z' });
      expect(db.reapAbandonedRuns({ now: new Date('2026-08-10T00:00:00.000Z') })).toBe(0);
      expect(db.getRunLog('r-2026-08-01T00:00:00.000Z').errors).toBeNull();
    });
  });

  // Discovery re-buys a description it already owns unless this answers first.
  // It used to be restricted to `source = 'workday'`, so every other adapter
  // with a detail budget paid full price on every run.
  describe('getReusableDetail', () => {
    const description = 'A real description. '.repeat(20);

    it('returns a stored description for any source, not just workday', () => {
      db.upsertJob({ id: 'smartrecruiters:acme::sde::1', source: 'smartrecruiters', jd_text: description });
      expect(db.getReusableDetail('smartrecruiters:acme::sde::1')?.jdText).toBe(description);
    });

    it('still answers for workday', () => {
      db.upsertJob({ id: 'workday:acme::sde::1', source: 'workday', jd_text: description });
      expect(db.getReusableDetail('workday:acme::sde::1')?.jdText).toBe(description);
    });

    it('refuses a teaser, so a summary row is not mistaken for a real read', () => {
      db.upsertJob({ id: 'smartrecruiters:acme::sde::2', source: 'smartrecruiters', jd_text: 'SDE. Austin, TX' });
      expect(db.getReusableDetail('smartrecruiters:acme::sde::2')).toBeNull();
    });

    it('returns null for an unknown id', () => {
      expect(db.getReusableDetail('nope')).toBeNull();
    });

    it('keeps the legacy name working', () => {
      db.upsertJob({ id: 'workday:acme::sde::3', source: 'workday', jd_text: description });
      expect(db.getReusableWorkdayDetail('workday:acme::sde::3')?.jdText).toBe(description);
    });
  });
});
