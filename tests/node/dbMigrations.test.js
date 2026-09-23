import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

import {
  openDatabase, applyVersionedMigrations, SCHEMA_VERSION, SCHEMA_SQL, discoveryModeClause, Database,
} from '../../src/logging/db.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const plan = (db, sql, ...params) => db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params)
  .map((r) => r.detail).join(' | ');

describe('db — versioned migrations (PRAGMA user_version)', () => {
  it('a fresh database is at SCHEMA_VERSION with the v2 columns', () => {
    const db = openDatabase({ path: ':memory:' });
    expect(db.db.prepare('PRAGMA user_version').get().user_version).toBe(SCHEMA_VERSION);
    const jobCols = db.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
    expect(jobCols).toContain('decision_reason');
    const runCols = db.db.prepare('PRAGMA table_info(run_log)').all().map((c) => c.name);
    expect(runCols).toContain('per_source');
    db.close();
  });

  it('v1 backfills NULL discovery_mode, is idempotent, and leaves role-search rows alone', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(SCHEMA_SQL);
    raw.exec('ALTER TABLE jobs ADD COLUMN prepared_at TEXT'); // added by the additive migrations
    raw.exec("INSERT INTO jobs (id, discovery_mode) VALUES ('legacy', NULL), ('rs', 'role_search'), ('p', 'profile')");
    const first = applyVersionedMigrations(raw);
    expect(first).toEqual({ from: 0, to: SCHEMA_VERSION });
    const modes = Object.fromEntries(raw.prepare('SELECT id, discovery_mode AS m FROM jobs').all().map((r) => [r.id, r.m]));
    expect(modes).toEqual({ legacy: 'profile', rs: 'role_search', p: 'profile' });
    expect(applyVersionedMigrations(raw)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION });
    raw.close();
  });

  it('a failing step rolls back and leaves user_version where it was', () => {
    const raw = new DatabaseSync(':memory:');
    // No jobs table at all: v1's UPDATE fails.
    expect(() => applyVersionedMigrations(raw)).toThrow(/schema migration v1/);
    expect(raw.prepare('PRAGMA user_version').get().user_version).toBe(0);
    raw.close();
  });

  it('new rows always get a discovery_mode, so the equality clause never loses one', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'a', title: 'x', status: 'scored', score: 70 });
    expect(db.getJob('a').discovery_mode).toBe('profile');
    // An update that omits the mode keeps the stored owner.
    db.upsertJob({ id: 'r', discovery_mode: 'role_search', search_query: 'PM' });
    db.upsertJob({ id: 'r', score: 50 });
    expect(db.getJob('r').discovery_mode).toBe('role_search');
    db.close();
  });

  it('board open-ids and stats reads use a COVERING index scoped by equality', () => {
    const db = openDatabase({ path: ':memory:' });
    const clause = discoveryModeClause('profile');
    expect(clause.sql).toBe("discovery_mode = 'profile'");
    const open = plan(db, `SELECT id FROM jobs WHERE NOT (status IS 'discarded' AND (applied IS NULL OR applied <> 1)
      AND user_decision IS NULL AND NOT EXISTS (SELECT 1 FROM approval_queue aq WHERE aq.job_id = jobs.id))
      AND ${clause.sql}`);
    expect(open).toMatch(/COVERING INDEX idx_jobs_board_open/);
    const stats = plan(db, `SELECT id, source, location, posted_at, score, tier, sponsorship, discard_reason,
      status, application_packet_path, prepared_at, applied, applied_at, user_decision, created_at, updated_at
      FROM jobs WHERE ${clause.sql}`);
    expect(stats).toMatch(/COVERING INDEX idx_jobs_stats/);
    expect(stats).not.toMatch(/TEMP B-TREE/);
    const docs = plan(db, `SELECT id FROM jobs WHERE resume_docx_path IS NOT NULL OR resume_path IS NOT NULL
      OR resume_pdf_path IS NOT NULL OR cover_letter_path IS NOT NULL OR application_packet_path IS NOT NULL`);
    expect(docs).toMatch(/idx_jobs_documents/);
    db.close();
  });

  it('a handle wrapped on an UNMIGRATED database keeps treating NULL as profile', () => {
    const raw = new DatabaseSync(':memory:');
    raw.exec(SCHEMA_SQL);
    raw.exec("INSERT INTO jobs (id, status, score) VALUES ('legacy', 'scored', 70)");
    const db = new Database(raw);
    expect(db.schemaVersion).toBe(0);
    expect(db.listJobsSummary().map((r) => r.id)).toEqual(['legacy']);
    expect(db.countJobs()).toBe(1);
    raw.close();
  });
});

describe('db — write path', () => {
  let db;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => db.close());

  it('upsertJob returns {changes} rather than re-reading the row', () => {
    expect(db.upsertJob({ id: 'j', title: 't' })).toEqual({ changes: 1 });
  });

  it('an undefined field never overwrites a stored value; null still clears', () => {
    db.upsertJob({ id: 'j', notes: 'keep me', url: 'https://x.test/1' });
    db.upsertJob({ id: 'j', notes: undefined, url: null });
    const row = db.getJob('j');
    expect(row.notes).toBe('keep me');
    expect(row.url).toBeNull();
  });

  it('a summary-only sighting never replaces a stored full description', () => {
    const full = 'Full description. '.repeat(30);
    db.upsertJob({ id: 'j', jd_text: full, summary_only: 0 });
    db.upsertJob({ id: 'j', jd_text: 'Short teaser', summary_only: 1 });
    expect(db.getJob('j')).toMatchObject({ jd_text: full, summary_only: 0 });
    db.upsertJob({ id: 'j', jd_text: null, summary_only: 1 });
    expect(db.getJob('j')).toMatchObject({ jd_text: full, summary_only: 0 });
    // A full fetch still replaces it, and a short stored text is not protected.
    db.upsertJob({ id: 'j', jd_text: `${full} updated`, summary_only: 0 });
    expect(db.getJob('j').jd_text).toBe(`${full} updated`);
    db.upsertJob({ id: 'k', jd_text: 'tiny', summary_only: 0 });
    db.upsertJob({ id: 'k', jd_text: 'teaser', summary_only: 1 });
    expect(db.getJob('k')).toMatchObject({ jd_text: 'teaser', summary_only: 1 });
  });

  it('transaction(fn) returns fn\'s result, rolls back on throw, and nests', () => {
    expect(db.transaction(() => { db.upsertJob({ id: 'a' }); return 42; })).toBe(42);
    expect(() => db.transaction(() => { db.upsertJob({ id: 'b' }); throw new Error('boom'); })).toThrow('boom');
    expect(db.getJob('b')).toBeNull();
    expect(db.transaction(() => db.transaction(() => 'inner'))).toBe('inner');
  });

  it('transactionChunks commits per chunk and keeps earlier chunks on a later failure', () => {
    const out = db.transactionChunks([1, 2, 3, 4, 5], 2, (n) => { db.upsertJob({ id: `c${n}` }); return n * 2; });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(() => db.transactionChunks(['x1', 'x2', 'x3'], 2, (id) => {
      if (id === 'x3') throw new Error('stop');
      db.upsertJob({ id });
    })).toThrow('stop');
    expect(db.getJob('x1')).not.toBeNull();
    expect(db.getJob('x2')).not.toBeNull();
  });

  it('rowsByIds uses one statement for any number of ids', () => {
    const ids = Array.from({ length: 2500 }, (_, i) => `r${i}`);
    db.transactionChunks(ids, 1000, (id) => db.upsertJob({ id, score: 1 }));
    const before = db._stmtCache.size;
    expect(db.rowsByIds(ids)).toHaveLength(2500);
    expect(db.rowsByIds(ids.slice(0, 7))).toHaveLength(7);
    expect(db._stmtCache.size - before).toBe(1);
  });

  it('countAppliedBetween counts a half-open window', () => {
    db.upsertJob({ id: 'a', applied: 1, applied_at: '2026-09-22T04:00:00.000Z' });
    db.upsertJob({ id: 'b', applied: 1, applied_at: '2026-09-23T03:59:59.000Z' });
    db.upsertJob({ id: 'c', applied: 1, applied_at: '2026-09-23T04:00:00.000Z' });
    expect(db.countAppliedBetween('2026-09-22T04:00:00.000Z', '2026-09-23T04:00:00.000Z')).toBe(2);
  });

  it('the daily cap counts the candidate\'s local day, not the UTC day', () => {
    // 9 pm and 11:30 pm New York time on Sep 22 are Sep 23 in UTC.
    db.upsertJob({ id: 'e1', applied: 1, applied_at: '2026-09-23T01:00:00.000Z' });
    db.upsertJob({ id: 'e2', applied: 1, applied_at: '2026-09-23T03:30:00.000Z' });
    db.upsertJob({ id: 'm', applied: 1, applied_at: '2026-09-22T14:00:00.000Z' });
    const evening = new Date('2026-09-23T03:45:00.000Z');
    expect(db.countAppliedOnLocalDay(evening, 'America/New_York')).toBe(3);
    expect(db.countAppliedOn('2026-09-23')).toBe(2); // the old UTC answer
  });
});

describe('db — deleteRoleSearch keeps what the user invested in', () => {
  it('re-owns applied / decided / packet / queued rows and deletes the rest with their events', () => {
    const db = openDatabase({ path: ':memory:' });
    const rs = { discovery_mode: 'role_search', search_query: 'PM' };
    db.upsertJob({ id: 'plain', ...rs });
    db.upsertJob({ id: 'applied', ...rs, applied: 1 });
    db.upsertJob({ id: 'decided', ...rs, user_decision: 'rejected' });
    db.upsertJob({ id: 'packet', ...rs, application_packet_path: '/tmp/p.json' });
    db.upsertJob({ id: 'queued', ...rs });
    db.insertApproval({ id: 'ap', job_id: 'queued' });
    db.insertEvent({ id: 'e1', job_id: 'plain', event_type: 'score_explained' });
    db.insertEvent({ id: 'e2', job_id: 'applied', event_type: 'application_submitted' });

    expect(db.deleteRoleSearch('PM')).toBe(1);
    expect(db.lastRoleSearchKept).toBe(4);
    expect(db.getJob('plain')).toBeNull();
    for (const id of ['applied', 'decided', 'packet', 'queued']) {
      expect(db.getJob(id)).toMatchObject({ discovery_mode: 'profile', search_query: null });
    }
    expect(db.listEvents().map((e) => e.id)).toEqual(['e2']);
    db.close();
  });
});

describe('db — run_log bookkeeping', () => {
  it('updateRunLog without a mode never invents a phantom "unknown" row', () => {
    const db = openDatabase({ path: ':memory:' });
    const warnings = [];
    db.onWarning = (m) => warnings.push(m);
    db.updateRunLog('session-id', { ended_at: '2026-09-22T00:00:00.000Z', jobs_found: 3 });
    expect(db.listRunLogs()).toEqual([]);
    expect(warnings[0]).toMatch(/session-id/);
    db.close();
  });

  it('insert/update carry every run_log counter, including jobs_new and per_source', () => {
    const db = openDatabase({ path: ':memory:' });
    db.insertRunLog({ run_id: 'r1', mode: 'discover', started_at: '2026-09-22T00:00:00.000Z', jobs_new: 4 });
    db.updateRunLog('r1', { jobs_discarded_stale: 2, per_source: [{ source: 'lever', found: 1 }], bogus: 1 });
    const row = db.getRunLog('r1');
    expect(row).toMatchObject({ jobs_new: 4, jobs_discarded_stale: 2 });
    expect(JSON.parse(row.per_source)).toEqual([{ source: 'lever', found: 1 }]);
    db.close();
  });
});

describe('db — setJobStatus', () => {
  it('asserts the lifecycle transition, writes the patch, and records an event', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j', status: 'ready_for_submit' });
    expect(db.setJobStatus('j', 'submitted', { reason: 'human', patch: { applied: 1 } }))
      .toEqual({ id: 'j', from: 'ready_for_submit', to: 'submitted' });
    expect(db.getJob('j')).toMatchObject({ status: 'submitted', applied: 1 });
    expect(db.listEvents('j').map((e) => e.event_type)).toEqual(['status_changed']);
    expect(() => db.setJobStatus('j', 'submit_unverified')).toThrow(/illegal lifecycle transition/);
    try { db.setJobStatus('j', 'queued'); } catch (err) { expect(err.statusCode).toBe(409); }
    expect(() => db.setJobStatus('nope', 'queued')).toThrow(/unknown job id/);
    db.close();
  });
});
