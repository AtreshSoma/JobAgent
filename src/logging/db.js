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
  compensation_text TEXT,
  score INTEGER,
  tier TEXT,
  sponsorship TEXT,
  sponsorship_signals TEXT,
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
  updated_at TEXT,
  summary_only INTEGER
);

CREATE TABLE IF NOT EXISTS run_log (
  run_id TEXT PRIMARY KEY,
  mode TEXT,
  started_at TEXT,
  ended_at TEXT,
  jobs_found INTEGER,
  jobs_scored INTEGER,
  jobs_skipped_unchanged INTEGER,
  jobs_cancelled INTEGER,
  jobs_queued INTEGER,
  jobs_prepared INTEGER,
  jobs_applied INTEGER,
  jobs_assisted INTEGER,
  jobs_submitted INTEGER,
  jobs_discarded INTEGER,
  jobs_unknown_date_review INTEGER,
  jobs_new INTEGER,
  jobs_unread INTEGER,
  jobs_duplicate INTEGER,
  jobs_discarded_stale INTEGER,
  jobs_discarded_excluded INTEGER,
  jobs_discarded_low_score INTEGER,
  jobs_suppressed_applied INTEGER,
  jobs_suppressed_url_owned INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs(score);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
CREATE INDEX IF NOT EXISTS idx_jobs_posted_at ON jobs(posted_at);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_applied ON jobs(applied);
CREATE INDEX IF NOT EXISTS idx_events_job ON application_events(job_id);
CREATE INDEX IF NOT EXISTS idx_approval_job ON approval_queue(job_id);

`;

/** All jobs-table columns except jd_text (see listJobsSummary). */
const JOB_SUMMARY_COLUMNS = [
  'id', 'source', 'company', 'title', 'location', 'url', 'posted_at',
  'applicant_count', 'employment_type', 'employment_category', 'compensation_text',
  'score', 'tier', 'sponsorship', 'sponsorship_signals',
  'discard_reason', 'matched_keywords', 'missing_keywords', 'explanation',
  'ats_platform', 'ats_score', 'ats_band', 'status', 'resume_path', 'resume_docx_path', 'resume_pdf_path',
  'cover_letter_path', 'application_packet_path', 'output_folder_path', 'prepared_at',
  'applied', 'applied_at', 'user_decision', 'decided_at',
  'assist_filled_count', 'assist_blockers', 'notes', 'submitted_confirmation',
  'created_at', 'updated_at',
].join(', ');

/**
 * The only columns dashboardStats reads — directly, or via the helpers it calls
 * (deriveAppStatus, fitBucket, isSponsorshipGated, isUndatedDrop,
 * postedConfidence, preparedAtOf, gradeFromScore, usLocationSignal).
 *
 * Stats must aggregate the WHOLE table, so it is the one dashboard read that
 * cannot be narrowed by rows — but it can be narrowed by columns. The wide
 * summary projection also carries `explanation`, `matched_keywords`,
 * `missing_keywords`, `notes` and friends: long per-row TEXT that stats never
 * looks at, but that SQLite still has to read off disk and V8 still has to
 * allocate a string for, once per row.
 *
 * Adding a column to the stats loop means adding it HERE too — a missing column
 * arrives as `undefined` and silently changes a count rather than failing.
 */
const JOB_STATS_COLUMNS = [
  'id', 'source', 'location', 'posted_at', 'score', 'tier', 'sponsorship',
  'discard_reason', 'status', 'application_packet_path', 'prepared_at',
  'applied', 'applied_at', 'user_decision', 'created_at', 'updated_at',
].join(', ');

/** Columns allowed for the jobs table (whitelist for safe upserts). */
const JOB_COLUMNS = [
  'id', 'source', 'company', 'title', 'location', 'url', 'jd_text', 'posted_at',
  'applicant_count', 'employment_type', 'employment_category', 'compensation_text',
  'score', 'tier', 'sponsorship', 'sponsorship_signals',
  'discard_reason', 'matched_keywords', 'missing_keywords', 'explanation',
  'ats_platform', 'ats_score', 'ats_band', 'status', 'resume_path', 'resume_docx_path', 'resume_pdf_path',
  'cover_letter_path', 'application_packet_path', 'output_folder_path', 'prepared_at',
  'applied', 'applied_at', 'user_decision', 'decided_at',
  'assist_filled_count', 'assist_blockers', 'notes', 'submitted_confirmation',
  'created_at', 'updated_at',
  'summary_only',
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
  // Two processes legitimately write this DB at once (dashboard server + CLI
  // watch mode). Without a busy timeout a concurrent write throws SQLITE_BUSY
  // immediately; with it, SQLite retries for up to 5s before giving up.
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  // SQLite's default page cache is 2 MB. This database is hundreds of MB (jd_text
  // dominates), and the dashboard re-reads the jobs table on every stats build,
  // so at the default nearly every pass went back to disk. Negative = KiB, so
  // this is a 64 MB ceiling, not 64000 pages. temp_store=MEMORY keeps the sorter
  // for `ORDER BY score` out of a temp file.
  db.exec('PRAGMA cache_size = -65536;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  if (path !== ':memory:') {
    // Long-lived readers (the dashboard) can keep the WAL from ever being
    // checkpointed; left alone it grows without bound (observed: 60+ MB).
    // A truncate checkpoint on open folds it back into the main DB file.
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* best effort */ }
  }
  return new Database(db);
}

/** Idempotent, additive migrations for databases created by older schemas. */
function applyMigrations(db) {
  const runLogCols = new Set(db.prepare('PRAGMA table_info(run_log)').all().map((c) => c.name));
  for (const col of ['jobs_assisted', 'jobs_submitted', 'jobs_unknown_date_review',
    'jobs_skipped_unchanged', 'jobs_cancelled',
    // A run used to report one undifferentiated `jobs_discarded`, and no count
    // of what was actually NEW -- so a run that found thousands of new postings
    // and one that found none produced near-identical numbers. These split the
    // causes apart and record novelty.
    'jobs_new', 'jobs_unread', 'jobs_duplicate', 'jobs_discarded_stale', 'jobs_discarded_excluded',
    'jobs_discarded_low_score', 'jobs_suppressed_applied', 'jobs_suppressed_url_owned']) {
    if (!runLogCols.has(col)) {
      db.exec(`ALTER TABLE run_log ADD COLUMN ${col} INTEGER`);
    }
  }
  const jobCols = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  for (const col of ['resume_docx_path', 'resume_pdf_path', 'output_folder_path',
    'user_decision', 'decided_at', 'assist_blockers', 'notes', 'submitted_confirmation', 'ats_band',
    'employment_category', 'compensation_text', 'prepared_at',
    // Why a row says Confirmed/Denied. The classifier always computed these
    // signals and the pipeline always threw them away, so the sponsorship badge
    // asserted a conclusion with no recoverable evidence -- which is exactly why
    // 6 Humana rows could claim "Confirmed" off sentences that refused
    // sponsorship outright without anyone being able to see it from the UI.
    'sponsorship_signals']) {
    if (!jobCols.has(col)) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
    }
  }
  // Whether the description was ever actually FETCHED. Without this the
  // system cannot distinguish "judged and rejected" from "never read", and
  // 31,409 rows scored on <200 characters were reported as poor fits.
  if (!jobCols.has('summary_only')) {
    db.exec('ALTER TABLE jobs ADD COLUMN summary_only INTEGER');
  }
  // PERFORMANCE INDEXES — created here, not in SCHEMA_SQL, because they name
  // columns that MIGRATIONS add (user_decision, prepared_at). Declared with the
  // table they would reference a column that does not exist yet on a fresh
  // database, and CREATE TABLE would fail outright with "no such column".
  //
  // These two are the difference between a dashboard that responds instantly
  // and one that appears hung. Measured on 112,709 rows / a 383 MB jobs table:
  //   board open-rows predicate   15.3 s -> 39 ms   (covering, no row reads)
  //   stats tiles (all rows)      25.7 s -> 663 ms  (index-only scan)
  // jd_text is stored INLINE, so any full table scan drags every stored job
  // description through memory; these let SQLite answer from the index instead.
  // Keep idx_jobs_stats in sync with JOB_STATS_COLUMNS — a column in the query
  // but missing from the index silently reverts the plan to a full scan.
  const perfIndexes = [
    `CREATE INDEX IF NOT EXISTS idx_jobs_board_open
       ON jobs(status, applied, user_decision, score, id)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_stats
       ON jobs(score, id, source, location, posted_at, tier, sponsorship, status,
               applied, applied_at, user_decision, created_at, updated_at,
               prepared_at, discard_reason, application_packet_path)`,
  ];
  for (const sql of perfIndexes) db.exec(sql);

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

    const record = { ...job };
    record.created_at = job.created_at ?? now;
    record.updated_at = now;

    const cols = JOB_COLUMNS.filter((c) => c in record);
    const placeholders = cols.map((c) => `@${c}`).join(', ');
    // `created_at` is deliberately NOT in the UPDATE list: the first insert owns
    // it and a re-discovery must never move it. This used to be enforced by
    // reading the existing row first (`existing?.created_at ?? ...`) and writing
    // the same value back — a full `SELECT *` per upsert, pulling ~8 KB of
    // jd_text off disk for one timestamp, on every one of the tens of thousands
    // of rows a discovery run persists. Omitting the column from the UPDATE is
    // equivalent and needs no read at all.
    const updates = cols
      .filter((c) => c !== 'id' && c !== 'created_at')
      .map((c) => `${c} = @${c}`).join(', ');

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
   * Just the columns `isProtectedJobRow` (src/lifecycle.js) inspects, for the
   * downgrade guard discovery runs apply to every re-seen posting. Same verdict
   * as passing a full `getJob` row, without reading that row's jd_text.
   * @param {string} id
   * @returns {{applied: number|null, application_packet_path: string|null,
   *            user_decision: string|null, status: string|null}|null}
   */
  getJobProtectionFields(id) {
    return this.prepareCached(
      'SELECT applied, application_packet_path, user_decision, status FROM jobs WHERE id = ?',
    ).get(id) ?? null;
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
   * URL identities that already own an actionable/protected record. Closed
   * discovery-only history is excluded so a genuinely reposted role can return.
   * @returns {Array<{id: string, url: string}>}
   */
  getActiveJobUrls() {
    return this.db.prepare(`
      SELECT id, url FROM jobs
      WHERE trim(coalesce(url, '')) <> ''
        AND (applied = 1
          OR status NOT IN ('discarded', 'skipped')
          OR user_decision = 'shortlisted')
    `).all();
  }

  /**
   * A full description already paid for in an earlier discovery run.
   *
   * Reusing it avoids repeating hundreds of optional public detail requests.
   * This was originally hardcoded to `source = 'workday'`, which meant every
   * OTHER adapter with a detail budget re-bought descriptions it already had on
   * every single run — SmartRecruiters alone spent ~3,700 requests per run
   * re-reading postings that were already stored. A posting's description does
   * not change often enough to be worth that, and the id is already
   * source-qualified, so the restriction bought nothing.
   *
   * @param {string} id
   * @returns {{jdText:string,postedAt:string|null}|null}
   */
  getReusableDetail(id) {
    return this.prepareCached(`
      SELECT jd_text AS jdText, posted_at AS postedAt FROM jobs
      WHERE id = ?
        AND length(trim(coalesce(jd_text, ''))) >= 200
    `).get(id) ?? null;
  }

  /**
   * @deprecated Use {@link getReusableDetail}. Kept so an external caller that
   * still asks for the Workday-only form keeps working.
   * @param {string} id
   * @returns {{jdText:string,postedAt:string|null}|null}
   */
  getReusableWorkdayDetail(id) {
    return this.getReusableDetail(id);
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
   * Ids of every job a re-score could touch, cheapest possible read.
   *
   * Re-scoring needs each row's jd_text, but it needs them ONE AT A TIME. Doing
   * `SELECT *` up front materialized the entire corpus (~150 MB of JD text at
   * 32k rows) in memory before the first row was scored. Fetching ids first and
   * then loading each row on demand keeps peak memory flat and lets the loop
   * yield to the event loop between rows.
   *
   * @returns {string[]}
   */
  listJobIds() {
    return this.db.prepare('SELECT id FROM jobs ORDER BY score DESC').all().map((r) => r.id);
  }

  /**
   * Every job WITHOUT the jd_text column. jd_text dominates row size (~8 KB
   * avg on real data — ~200 MB across 25k jobs), and the dashboard board/stats
   * never render it (job detail loads it via getJob). Excluding it cuts each
   * full-table decoration pass from hundreds of MB of I/O to a few MB.
   * @returns {object[]} jobs-table rows minus jd_text
   */
  listJobsSummary() {
    return this.db.prepare(`SELECT ${JOB_SUMMARY_COLUMNS} FROM jobs ORDER BY score DESC`).all();
  }

  /**
   * Every job, but only the columns dashboardStats reads (JOB_STATS_COLUMNS).
   * Same row count as listJobsSummary — stats counts the whole table — at a
   * fraction of the bytes read and strings allocated.
   * @returns {object[]}
   */
  listJobsForStats() {
    return this.prepareCached(`SELECT ${JOB_STATS_COLUMNS} FROM jobs ORDER BY score DESC`).all();
  }

  /**
   * Same as listJobsSummary, minus rows that are PROVABLY the derived status
   * `discarded` — which the default board hides anyway.
   *
   * Why this exists: on real data the discard pile dwarfs everything else
   * (measured: 99,532 of 101,620 rows). The board was reading and decorating
   * all 101,620 to render a page drawn from the ~2,088 that could actually
   * appear, costing ~5s of blocked event loop per cache miss — which is what
   * made every filter click and every row action feel frozen.
   *
   * The WHERE clause mirrors `deriveAppStatus` (dashboard/data.js) exactly for
   * this one subset, and is deliberately CONSERVATIVE: it excludes a row only
   * when every branch that could out-rank `discarded` is ruled out —
   *   applied != 1        (else SUBMITTED)
   *   user_decision NULL  (else ARCHIVED / REJECTED / SHORTLISTED)
   *   status = 'discarded' (so none of the assist/submit statuses apply, and it
   *                         is not 'unknown_date_review' -> DATE_UNCONFIRMED)
   *   no approval_queue row (else REJECTED / APPROVED / NEEDS_REVIEW)
   * Anything it cannot prove is discarded is KEPT, so callers still see a
   * superset of what they may display and apply their own predicates on top.
   * @returns {object[]} jobs-table rows minus jd_text, minus certain discards
   */
  listOpenJobsSummary() {
    // Every comparison here must be NULL-SAFE. `status = 'discarded'` yields
    // NULL (not false) for a row whose status is NULL, and `NOT (NULL AND ...)`
    // is NULL, which WHERE treats as no-match — so the plain form silently DROPS
    // status-less rows from the board instead of keeping them. Caught by a
    // differential check against the live table; `IS` is SQLite's null-safe
    // equality, and the `applied` test spells out its own NULL case.
    // TWO PHASES, because asking for the predicate and the 40 columns at once
    // defeats the index that makes the predicate cheap.
    //
    // Selecting the wide column list forces SQLite to visit a row page for
    // every candidate, so it abandons the covering index and scans the table
    // via idx_jobs_score instead — reading all 383 MB of `jobs`, including
    // every inline jd_text the query never asked for. Measured: 21.1 seconds.
    //
    // Phase 1 asks ONLY for ids, which the covering index answers without
    // touching a single row (51 ms over 112,709 rows). Phase 2 then fetches
    // the wide columns for just the ~2,500 ids that survived — a few thousand
    // primary-key seeks rather than a whole-table read. Same rows, same order,
    // 1.6 s cold and 185 ms warm.
    const ids = this.prepareCached(`SELECT id FROM jobs
      WHERE NOT (
        status IS 'discarded'
        AND (applied IS NULL OR applied <> 1)
        AND user_decision IS NULL
        AND NOT EXISTS (SELECT 1 FROM approval_queue aq WHERE aq.job_id = jobs.id)
      )`).all().map((r) => r.id);
    if (!ids.length) return [];
    return this.rowsByIds(ids)
      // Phase 2 returns rows in whatever order the chunks came back, so the
      // documented score-descending contract is restored here. Sorting a few
      // thousand already-loaded rows is microseconds; making SQLite do it was
      // what pulled the whole table through the score index in the first place.
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }

  /**
   * Fetch full summary rows for a set of ids, chunked to stay well inside
   * SQLite's bound-parameter ceiling.
   * @param {string[]} ids
   * @returns {object[]}
   */
  rowsByIds(ids = []) {
    const CHUNK = 800;
    const out = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const holes = slice.map(() => '?').join(',');
      out.push(...this.prepareCached(
        `SELECT ${JOB_SUMMARY_COLUMNS} FROM jobs WHERE id IN (${holes})`,
      ).all(...slice));
    }
    return out;
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
      'jobs_skipped_unchanged', 'jobs_cancelled',
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

  /**
   * Close run_log rows that a previous process opened and never ended.
   *
   * `endRun` closes a row on the happy path only, so a crash, a Ctrl-C or a
   * killed terminal leaves `ended_at` NULL forever. Such a row is
   * indistinguishable from a run that is still going, which quietly corrupts any
   * "when did we last complete a run" question asked of this table.
   *
   * `ended_at` is set to `started_at` rather than to now: the true end time is
   * unrecoverable (events carry no run_id), and stamping the current time would
   * invent a multi-day duration for a run that died in seconds. A zero-length
   * window plus the note below says "we do not know" without fabricating one.
   *
   * @param {object} [options]
   * @param {number} [options.olderThanMs] only reap rows older than this
   *   (default 6h — far beyond any real run, so a genuinely concurrent run is
   *   never closed out from under itself)
   * @param {Date} [options.now]
   * @returns {number} rows closed
   */
  reapAbandonedRuns({ olderThanMs = 6 * 60 * 60 * 1000, now = new Date() } = {}) {
    const cutoff = new Date(now.getTime() - olderThanMs).toISOString();
    const stale = this.db.prepare(
      'SELECT run_id, started_at FROM run_log WHERE ended_at IS NULL AND started_at < ?',
    ).all(cutoff);
    const note = 'run did not report an end (process exited before endRun); '
      + 'closed by a later run, so its duration is unknown';
    for (const row of stale) {
      this.db.prepare(
        'UPDATE run_log SET ended_at = @ended_at, errors = @errors WHERE run_id = @run_id',
      ).run({ run_id: row.run_id, ended_at: row.started_at, errors: note });
    }
    return stale.length;
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
