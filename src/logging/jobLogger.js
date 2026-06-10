/**
 * Job logger: structured JSON logging (pino) + durable decision logging (SQLite).
 *
 * Every meaningful pipeline decision is:
 *  1. emitted as a structured JSON log line (with secrets redacted), and
 *  2. recorded in the application_events table for later reporting/audit.
 *
 * Secrets (passwords, API keys, cookies, tokens) are NEVER logged.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';

import { PROJECT_ROOT } from '../config/loadConfig.js';
import { redact } from '../utils/credentialManager.js';
import { nowIso } from '../utils/dates.js';

/** Canonical event types recorded during a run. */
export const EVENT_TYPES = Object.freeze({
  RUN_START: 'run_start',
  RUN_END: 'run_end',
  CONFIG_VALIDATED: 'config_validated',
  SEARCH_START: 'search_start',
  SEARCH_END: 'search_end',
  JOB_FOUND: 'job_found',
  DUPLICATE_SKIPPED: 'duplicate_skipped',
  FRESHNESS_FILTERED: 'freshness_filtered',
  EXCLUSION_MATCHED: 'exclusion_matched',
  SCORE_EXPLAINED: 'score_explained',
  RESUME_GENERATED: 'resume_generated',
  COVER_LETTER_GENERATED: 'cover_letter_generated',
  PACKET_CREATED: 'packet_created',
  PREFILL_STARTED: 'prefill_started',
  UNKNOWN_SCREENING_QUESTION: 'unknown_screening_question',
  APPROVAL_REQUIRED: 'approval_required',
  APPLICATION_SUBMITTED: 'application_submitted',
  ERROR: 'error',
});

/**
 * Create a pino logger that writes pretty output to the console and JSON lines
 * to a per-run log file under logs/.
 *
 * @param {object} [options]
 * @param {string} [options.runId]
 * @param {string} [options.level='info']
 * @param {string} [options.logDir] defaults to <root>/logs
 * @param {boolean} [options.toFile=true]
 * @param {string} [options.consoleLevel] level for the stdout JSON stream.
 *   Defaults to 'error' so the console stays clean (the human-readable summary
 *   is printed separately by the CLI reporter); the full JSON audit trail still
 *   goes to the log file at `level`. Set LOG_CONSOLE=debug|info|warn to see more
 *   raw JSON (e.g. per-job resume-tailoring fallbacks logged at warn).
 * @returns {{ logger: import('pino').Logger, file: string|null }}
 */
export function createPinoLogger({ runId = randomUUID(), level = 'info', logDir, toFile = true, consoleLevel } = {}) {
  const dir = logDir ?? join(PROJECT_ROOT, 'logs');
  const stdoutLevel = consoleLevel ?? process.env.LOG_CONSOLE ?? 'error';
  let file = null;
  /** @type {pino.StreamEntry[]} */
  const streams = [];

  if (toFile) {
    mkdirSync(dir, { recursive: true });
    file = join(dir, `run-${runId}.log`);
    streams.push({ level, stream: createWriteStream(file, { flags: 'a' }) });
  }
  // JSON stream to stdout — quiet by default so the console reporter owns the
  // human-facing output. Raised via consoleLevel / LOG_CONSOLE when debugging.
  streams.push({ level: stdoutLevel, stream: process.stdout });

  // The logger's own level must be the most permissive of all streams so that
  // lower-severity records still reach the file stream.
  const baseLevel = lowerLevel(level, stdoutLevel);
  const logger = pino({ level: baseLevel, base: { runId } }, pino.multistream(streams));
  return { logger, file };
}

/** Return the more permissive (numerically lower) of two pino levels. */
function lowerLevel(a, b) {
  const order = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity };
  return (order[a] ?? 30) <= (order[b] ?? 30) ? a : b;
}

/**
 * Wraps a pino logger + Database to log-and-persist pipeline decisions.
 */
export class JobLogger {
  /**
   * @param {object} deps
   * @param {import('./db.js').Database} deps.db
   * @param {import('pino').Logger} [deps.logger]
   * @param {string} [deps.runId]
   */
  constructor({ db, logger, runId = randomUUID() }) {
    this.db = db;
    this.runId = runId;
    this.logger = logger ?? createPinoLogger({ runId, toFile: false }).logger;
  }

  /**
   * Log a structured event and persist it to application_events.
   * @param {string} eventType one of EVENT_TYPES
   * @param {object} [fields]
   * @param {string} [fields.jobId]
   * @param {string} [fields.message]
   * @param {object} [fields.meta] arbitrary metadata (auto-redacted)
   * @param {'info'|'warn'|'error'} [fields.level='info']
   * @returns {string} the event id
   */
  event(eventType, { jobId = null, message = '', meta = {}, level = 'info' } = {}) {
    const id = randomUUID();
    const created_at = nowIso();
    const safeMeta = redact(meta);

    const logFn = this.logger[level] ? this.logger[level].bind(this.logger) : this.logger.info.bind(this.logger);
    logFn({ event: eventType, jobId, ...safeMeta }, message || eventType);

    this.db.insertEvent({
      id,
      job_id: jobId,
      event_type: eventType,
      message,
      metadata: safeMeta,
      created_at,
    });
    return id;
  }

  /** Open a run_log row. @param {string} mode */
  startRun(mode) {
    this.db.insertRunLog({
      run_id: this.runId,
      mode,
      started_at: nowIso(),
      jobs_found: 0,
      jobs_scored: 0,
      jobs_queued: 0,
      jobs_prepared: 0,
      jobs_applied: 0,
      jobs_discarded: 0,
      errors: null,
    });
    this.event(EVENT_TYPES.RUN_START, { message: `Run started in ${mode} mode`, meta: { mode } });
    return this.runId;
  }

  /**
   * Close the run_log row with final counters.
   * @param {Record<string, any>} counters
   */
  endRun(counters = {}) {
    this.db.updateRunLog(this.runId, { ...counters, ended_at: nowIso() });
    this.event(EVENT_TYPES.RUN_END, { message: 'Run ended', meta: counters });
    return this.db.getRunLog(this.runId);
  }

  /** Convenience for error logging. @param {string} message @param {object} [meta] @param {string} [jobId] */
  error(message, meta = {}, jobId = null) {
    return this.event(EVENT_TYPES.ERROR, { jobId, message, meta, level: 'error' });
  }
}
