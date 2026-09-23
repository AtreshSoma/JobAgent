/**
 * How long each source took, remembered across runs.
 *
 * WHY THIS EXISTS
 *
 * Two things needed it and neither had it.
 *
 * 1. SCHEDULING. Sources ran in priority order against a pool of 6. Priority
 *    encodes which source we trust, not how long it takes, and the two slowest
 *    sources happened to sit 9th and 10th — so they were claimed only after
 *    eight shorter ones had finished, and the run could not end until the last
 *    of them drained alone. Claiming longest-first overlaps them with the short
 *    work instead, but that requires knowing what "longest" means.
 *
 * 2. DIAGNOSIS. Per-source durations existed only in the dashboard's in-memory
 *    progress object. `run_log` has no duration column and the run logs carry
 *    no per-source events, so once a run ended there was no way to answer "why
 *    did that take eleven minutes" — the evidence was gone.
 *
 * The file is a CACHE, not a source of truth: if it is missing or corrupt the
 * run proceeds in configured order, exactly as before.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';

/** Weight given to the newest observation. Adapts quickly, ignores one blip. */
const EMA_ALPHA = 0.5;

/** Timings older than this are stale — boards change, so re-learn from scratch. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** How many runs of history to keep per source, for after-the-fact diagnosis. */
const HISTORY_LIMIT = 10;

/** @param {string} root */
export function timingsPath(root) {
  return join(root ?? '.', 'data', 'source_timings.json');
}

/**
 * Read/record per-source durations.
 *
 * Every filesystem operation is optional and swallowed: a discovery run must
 * never fail because a scheduling hint could not be written.
 *
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {(path: string) => string} [options.readFileImpl]
 * @param {(path: string, data: string) => void} [options.writeFileImpl]
 * @param {() => number} [options.now]
 */
export function createSourceTimings({
  root = '.',
  readFileImpl,
  writeFileImpl,
  now = () => Date.now(),
} = {}) {
  const path = timingsPath(root);
  const read = readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
  // Atomic (temp + rename): two runs, or a crash mid-write, used to be able to
  // leave a torn file — which the reader then treated as "no timings" and the
  // whole scheduling history was lost.
  const write = writeFileImpl ?? ((p, data) => writeFileAtomic(p, data, 'utf8'));

  /** @type {Record<string, {emaMs:number, lastMs:number, at:string, history:Array<object>}>} */
  let state = {};
  try {
    const parsed = JSON.parse(read(path));
    if (parsed && typeof parsed === 'object' && parsed.sources && typeof parsed.sources === 'object') {
      state = parsed.sources;
    }
  } catch {
    // No file yet, or unreadable. Either way we simply have no hint.
    state = {};
  }

  /**
   * Expected duration for a source, or 0 when we have never timed it.
   *
   * 0 sorts LAST under longest-first, which is the right default: an untimed
   * source is usually a newly added one, and guessing it is slow would push a
   * known-slow source out of the first wave on nothing but a hunch.
   *
   * @param {string} sourceId
   * @returns {number} milliseconds
   */
  function expectedMs(sourceId) {
    const entry = state[sourceId];
    if (!entry) return 0;
    const at = Date.parse(entry.at ?? '');
    if (Number.isFinite(at) && now() - at > MAX_AGE_MS) return 0;
    return Number(entry.emaMs) || 0;
  }

  /**
   * Fold this run's durations in and persist them.
   *
   * A CANCELLED source is recorded but not folded into the average — it stopped
   * early, so its duration says nothing about how long the work takes.
   *
   * @param {Array<{source:string, durationMs:number|null, found?:number, errors?:number, notes?:number, cancelled?:boolean, cached?:boolean}>} perSource
   */
  function record(perSource) {
    if (!Array.isArray(perSource) || perSource.length === 0) return;
    const at = new Date(now()).toISOString();
    for (const entry of perSource) {
      const id = entry?.source;
      const ms = Number(entry?.durationMs);
      if (!id || !Number.isFinite(ms) || ms < 0) continue;
      const prior = state[id];
      const usable = entry.cancelled !== true && entry.cached !== true;
      const emaMs = usable
        ? (prior?.emaMs ? Math.round(EMA_ALPHA * ms + (1 - EMA_ALPHA) * prior.emaMs) : ms)
        : (prior?.emaMs ?? 0);
      const history = [
        {
          at,
          ms,
          found: Number(entry.found) || 0,
          errors: Number(entry.errors) || 0,
          // Degradations (budget reached, teaser kept) are not failures; kept
          // apart so a healthy-but-budgeted source never reads as erroring.
          ...(Number(entry.notes) ? { notes: Number(entry.notes) } : {}),
          // Whether this run returned a COMPLETE listing — the expiry pass
          // only counts such runs as evidence a posting is gone.
          ...(typeof entry.succeeded === 'boolean' ? { ok: entry.succeeded } : {}),
          ...(entry.cancelled ? { cancelled: true } : {}),
          ...(entry.cached ? { cached: true } : {}),
        },
        ...(Array.isArray(prior?.history) ? prior.history : []),
      ].slice(0, HISTORY_LIMIT);
      state[id] = { emaMs, lastMs: ms, at, history };
    }
    try {
      write(path, `${JSON.stringify({ version: 1, updatedAt: at, sources: state }, null, 2)}\n`);
    } catch {
      // A hint we could not save is not a run failure.
    }
  }

  /**
   * Recorded runs for a source, newest first (bounded by HISTORY_LIMIT).
   * @param {string} sourceId
   * @returns {Array<{at: string, ms: number, found: number, errors: number, ok?: boolean}>}
   */
  function historyOf(sourceId) {
    const h = state[sourceId]?.history;
    return Array.isArray(h) ? h.map((x) => ({ ...x })) : [];
  }

  return { expectedMs, record, historyOf, path };
}
