/**
 * SQLite persistence using Node's built-in `node:sqlite` (no native build deps).
 *
 * Exposes a thin wrapper that:
 *  - opens/creates the database file (or an in-memory DB for tests),
 *  - applies the schema idempotently,
 *  - provides small helpers for the tables defined in the build spec.
 *
 * Tables: jobs, run_log, application_events, approval_queue.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { PROJECT_ROOT } from '../config/loadConfig.js';
import { nowIso } from '../utils/dates.js';

// Load the built-in `node:sqlite` via createRequire so bundlers/test runners
// (Vite/Vitest) do not statically analyze and try to transform this newer
// built-in module. It is a standard Node module, not an npm dependency.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

/** Default on-disk database path. */
export const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'data', 'applied_jobs.db');

/** Full schema, applied idempotently on open. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  source TEXT,
  company TEXT,
  title TEXT,
  location TEXT,
  url TEXT,
  jd_text TEXT,
  posted_at TEXT,
  applicant_count INTEGER,
  employment_type TEXT,
  employment_category TEXT,
  score INTEGER,
  tier TEXT,
  sponsorship TEXT,
  discard_reason TEXT,
  matched_keywords TEXT,
  missing_keywords TEXT,
  explanation TEXT,
  ats_platform TEXT,
  ats_score INTEGER,
  ats_band TEXT,
  status TEXT,
  resume_path TEXT,
  resume_docx_path TEXT,
  resume_pdf_path TEXT,
  cover_letter_path TEXT,
  application_packet_path TEXT,
  output_folder_path TEXT,
  applied INTEGER DEFAULT 0,
  applied_at TEXT,
  user_decision TEXT,
  decided_at TEXT,
  assist_filled_count INTEGER,
  assist_blockers TEXT,
  notes TEXT,
  submitted_confirmation TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS run_log (
  run_id TEXT PRIMARY KEY,
  mode TEXT,
  started_at TEXT,
  ended_at TEXT,
  jobs_found INTEGER,
  jobs_scored INTEGER,
  jobs_queued INTEGER,
  jobs_prepared INTEGER,
  jobs_applied INTEGER,
  jobs_assisted INTEGER,
  jobs_submitted INTEGER,
  jobs_discarded INTEGER,
  jobs_unknown_date_review INTEGER,
  errors TEXT
);

CREATE TABLE IF NOT EXISTS application_events (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  event_type TEXT,
  message TEXT,
  metadata TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS approval_queue (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  packet_path TEXT,
  approval_status TEXT,
  approved_by_user INTEGER DEFAULT 0,
  approved_at TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_tier ON jobs(tier);
CREATE INDEX IF NOT EXISTS idx_events_job ON application_events(job_id);
CREATE INDEX IF NOT EXISTS idx_approval_job ON approval_queue(job_id);
`;

/** Columns allowed for the jobs table (whitelist for safe upserts). */
const JOB_COLUMNS = [
  'id', 'source', 'company', 'title', 'location', 'url', 'jd_text', 'posted_at',
  'applicant_count', 'employment_type', 'employment_category', 'score', 'tier', 'sponsorship',
  'discard_reason', 'matched_keywords', 'missing_keywords', 'explanation',
  'ats_platform', 'ats_score', 'ats_band', 'status', 'resume_path', 'resume_docx_path', 'resume_pdf_path',
  'cover_letter_path', 'application_packet_path', 'output_folder_path',
  'applied', 'applied_at', 'user_decision', 'decided_at',
  'assist_filled_count', 'assist_blockers', 'notes', 'submitted_confirmation',
  'created_at', 'updated_at',
];

/**
 * Open (and initialize) the database.
 *
 * @param {object} [options]
 * @param {string} [options.path=DEFAULT_DB_PATH] file path, or ':memory:'
 * @returns {Database}
 */
export function openDatabase({ path = DEFAULT_DB_PATH } = {}) {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  // With WAL, NORMAL is the recommended high-throughput durability setting: it
  // is safe across process crashes (only risks a power loss) and avoids an
  // fsync on every commit. Discovery persists thousands of rows per run, so the
  // default FULL setting would otherwise dominate runtime with disk syncs.
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  return new Database(db);
}

/** Idempotent, additive migrations for databases created by older schemas. */
function applyMigrations(db) {
  const runLogCols = new Set(db.prepare('PRAGMA table_info(run_log)').all().map((c) => c.name));
  for (const col of ['jobs_assisted', 'jobs_submitted', 'jobs_unknown_date_review']) {
    if (!runLogCols.has(col)) {
      db.exec(`ALTER TABLE run_log ADD COLUMN ${col} INTEGER`);
    }
  }
  const jobCols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  for (const col of ['resume_docx_path', 'resume_pdf_path', 'output_folder_path',
    'user_decision', 'decided_at', 'assist_blockers', 'notes', 'submitted_confirmation', 'ats_band',
    'employment_category']) {
    if (!jobCols.has(col)) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
    }
  }
  if (!jobCols.has('assist_filled_count')) {
    db.exec('ALTER TABLE jobs ADD COLUMN assist_filled_count INTEGER');
  }
  if (!jobCols.has('ats_score')) {
    db.exec('ALTER TABLE jobs ADD COLUMN ats_score INTEGER');
  }
}

/** Serialize a value for a TEXT column (objects/arrays become JSON). */
function toText(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** Thin convenience wrapper around a DatabaseSync handle. */
export class Database {
  /** @param {DatabaseSync} handle */
  constructor(handle) {
    /** @type {DatabaseSync} */
    this.db = handle;
    /**
     * Prepared-statement cache. Discovery upserts thousands of rows per run,
     * each via getJob + INSERT…ON CONFLICT; re-preparing identical SQL every
     * call is wasted work, so we memoize by SQL text.
     * @type {Map<string, import('node:sqlite').StatementSync>}
     */
    this._stmtCache = new Map();
  }

  /** Prepare (and cache) a statement by its SQL text. */
  prepareCached(sql) {
    let stmt = this._stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this._stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Run `fn` inside a single transaction. Commits on success, rolls back on
   * throw. Used to batch the thousands of per-job upserts a discovery run makes
   * into one durable write instead of thousands.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  close() {
    this._stmtCache.clear();
    this.db.close();
  }

  /**
   * Insert or update a job row by id. Unknown keys are ignored; timestamps
   * are managed automatically.
   * @param {Record<string, any>} job
   */
  upsertJob(job) {
    if (!job || !job.id) throw new Error('upsertJob requires a job with an id');
    const now = nowIso();
    const existing = this.getJob(job.id);

    const record = { ...job };
    record.created_at = existing?.created_at ?? job.created_at ?? now;
    record.updated_at = now;

    const cols = JOB_COLUMNS.filter((c) => c in record);
    const placeholders = cols.map((c) => `@${c}`).join(', ');
    const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = @${c}`).join(', ');

    const params = {};
    for (const c of cols) params[c] = toText(record[c]);

    const sql = `INSERT INTO jobs (${cols.join(', ')}) VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updates}`;
    this.prepareCached(sql).run(params);
    return this.getJob(job.id);
  }

  /** @param {string} id */
  getJob(id) {
    return this.prepareCached('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
  }

  /**
   * Return a Set of all job ids that have been APPLIED to. Loading them once is
   * far cheaper than calling getJob() per discovered job during dedup (a
   * discovery run examines thousands of jobs every time).
   * @returns {Set<string>}
   */
  getAppliedJobIds() {
    const rows = this.db.prepare('SELECT id FROM jobs WHERE applied = 1').all();
    return new Set(rows.map((r) => r.id));
  }

  /**
   * Return a Set of EVERY job id currently known to the database (any status).
   * Watch mode snapshots this before a cycle so it can tell which jobs are
   * brand-new this cycle (worth alerting on) vs. already-seen.
   * @returns {Set<string>}
   */
  getKnownJobIds() {
    const rows = this.db.prepare('SELECT id FROM jobs').all();
    return new Set(rows.map((r) => r.id));
  }

  /**
   * @param {object} [filter]
   * @param {string} [filter.tier]
   * @param {string} [filter.status]
   * @returns {object[]}
   */
  listJobs({ tier, status } = {}) {
    const clauses = [];
    const params = [];
    if (tier) { clauses.push('tier = ?'); params.push(tier); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM jobs${where} ORDER BY score DESC`).all(...params);
  }

  /**
   * Record a USER decision on a job (dashboard actions). Decisions are the
   * human's own triage state — they never overwrite pipeline status.
   * @param {string} id job id
   * @param {'shortlisted'|'rejected'|'archived'|null} decision null clears it
   */
  setUserDecision(id, decision) {
    const allowed = new Set(['shortlisted', 'rejected', 'archived', null]);
    if (!allowed.has(decision)) {
      throw new Error(`invalid user decision: ${decision} (use shortlisted/rejected/archived/null)`);
    }
    this.db.prepare(
      'UPDATE jobs SET user_decision = ?, decided_at = ?, updated_at = ? WHERE id = ?',
    ).run(decision, decision ? nowIso() : null, nowIso(), id);
    return this.getJob(id);
  }

  /** @param {string} id */
  jobExists(id) {
    return this.db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id) !== undefined;
  }

  /** Count jobs applied on a given ISO date (YYYY-MM-DD prefix). */
  countAppliedOn(isoDatePrefix) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM jobs WHERE applied = 1 AND substr(applied_at,1,10) = ?")
      .get(isoDatePrefix);
    return row?.c ?? 0;
  }

  /** @param {Record<string, any>} row */
  insertRunLog(row) {
    const cols = ['run_id', 'mode', 'started_at', 'ended_at', 'jobs_found', 'jobs_scored',
      'jobs_queued', 'jobs_prepared', 'jobs_applied', 'jobs_assisted', 'jobs_submitted',
      'jobs_discarded', 'jobs_unknown_date_review', 'errors'];
    const present = cols.filter((c) => c in row);
    const params = {};
    for (const c of present) params[c] = toText(row[c]);
    this.db.prepare(
      `INSERT INTO run_log (${present.join(', ')}) VALUES (${present.map((c) => `@${c}`).join(', ')})`,
    ).run(params);
  }

  /** @param {string} runId @param {Record<string, any>} patch */
  updateRunLog(runId, patch) {
    const cols = Object.keys(patch);
    if (cols.length === 0) return;
    const set = cols.map((c) => `${c} = @${c}`).join(', ');
    const params = { run_id: runId };
    for (const c of cols) params[c] = toText(patch[c]);
    this.db.prepare(`UPDATE run_log SET ${set} WHERE run_id = @run_id`).run(params);
  }

  /** @param {string} runId */
  getRunLog(runId) {
    return this.db.prepare('SELECT * FROM run_log WHERE run_id = ?').get(runId) ?? null;
  }

  /** @param {Record<string, any>} event */
  insertEvent(event) {
    this.db.prepare(
      `INSERT INTO application_events (id, job_id, event_type, message, metadata, created_at)
       VALUES (@id, @job_id, @event_type, @message, @metadata, @created_at)`,
    ).run({
      id: event.id,
      job_id: event.job_id ?? null,
      event_type: event.event_type,
      message: event.message ?? null,
      metadata: toText(event.metadata),
      created_at: event.created_at ?? nowIso(),
    });
  }

  /** @param {string} [jobId] */
  listEvents(jobId) {
    if (jobId) {
      return this.db.prepare(
        'SELECT * FROM application_events WHERE job_id = ? ORDER BY created_at',
      ).all(jobId);
    }
    return this.db.prepare('SELECT * FROM application_events ORDER BY created_at').all();
  }

  /** @param {Record<string, any>} row */
  insertApproval(row) {
    this.db.prepare(
      `INSERT INTO approval_queue (id, job_id, packet_path, approval_status, approved_by_user, approved_at, created_at)
       VALUES (@id, @job_id, @packet_path, @approval_status, @approved_by_user, @approved_at, @created_at)`,
    ).run({
      id: row.id,
      job_id: row.job_id ?? null,
      packet_path: row.packet_path ?? null,
      approval_status: row.approval_status ?? 'pending',
      approved_by_user: row.approved_by_user ? 1 : 0,
      approved_at: row.approved_at ?? null,
      created_at: row.created_at ?? nowIso(),
    });
  }

  /** @param {object} [filter] @param {string} [filter.status] */
  listApprovals({ status } = {}) {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM approval_queue WHERE approval_status = ? ORDER BY created_at',
      ).all(status);
    }
    return this.db.prepare('SELECT * FROM approval_queue ORDER BY created_at').all();
  }

  /**
   * Update an approval row's status (used by the human approval queue).
   * @param {string} id approval id
   * @param {object} fields
   * @param {string} fields.approval_status
   * @param {number} [fields.approved_by_user]
   * @param {string|null} [fields.approved_at]
   */
  updateApprovalStatus(id, { approval_status, approved_by_user = 0, approved_at = null }) {
    this.db.prepare(
      `UPDATE approval_queue
         SET approval_status = @approval_status,
             approved_by_user = @approved_by_user,
             approved_at = @approved_at
       WHERE id = @id`,
    ).run({
      id,
      approval_status,
      approved_by_user: approved_by_user ? 1 : 0,
      approved_at,
    });
  }

  /** @param {string} id @returns {object|undefined} */
  getApproval(id) {
    return this.db.prepare('SELECT * FROM approval_queue WHERE id = ?').get(id);
  }

  /**
   * Most recent approval row for a given job (used to de-duplicate the queue).
   * @param {string} jobId
   * @returns {object|undefined}
   */
  getApprovalByJob(jobId) {
    return this.db.prepare(
      'SELECT * FROM approval_queue WHERE job_id = ? ORDER BY created_at DESC LIMIT 1',
    ).get(jobId);
  }

  /**
   * Repoint an existing approval row at a freshly prepared packet and reset it
   * for review. Used when a job is re-prepared so the queue updates in place
   * instead of accumulating duplicates.
   * @param {string} id approval id
   * @param {object} fields
   * @param {string} fields.packet_path
   * @param {string} fields.approval_status
   */
  updateApprovalPacket(id, { packet_path, approval_status }) {
    this.db.prepare(
      `UPDATE approval_queue
         SET packet_path = @packet_path,
             approval_status = @approval_status,
             approved_by_user = 0,
             approved_at = NULL
       WHERE id = @id`,
    ).run({ id, packet_path, approval_status });
  }
}
