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
    const created = db.upsertJob({ id: 'j1', company: 'Acme', title: 'SDE', score: 80, tier: 'Apply' });
    expect(created.company).toBe('Acme');
    expect(created.created_at).toBeTruthy();
    expect(db.jobExists('j1')).toBe(true);

    const updated = db.upsertJob({ id: 'j1', score: 90, tier: 'Priority' });
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
});
