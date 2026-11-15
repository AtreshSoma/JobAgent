/**
 * Which boards have changed since the last search (audit D1).
 *
 * A board's first page says what it holds: the total and its first postings.
 * When both match the last run, an adapter may skip the remaining pages. The
 * store is per workspace (data/board_fingerprints.json).
 *
 * Safety:
 *   - a FULL SWEEP (nothing skipped) is due when the last completed one is
 *     FULL_SWEEP_DAYS old, so a change deeper in a board is caught within days;
 *   - an adapter that skipped anything reports its run as not a full listing
 *     (`cached`), so the expiry pass never takes a skipped page as proof that a
 *     posting is gone;
 *   - an adapter records a board only after a walk with no errors.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { workspacePaths } from '../profile/workspace.js';

export const FULL_SWEEP_DAYS = 3;
const MAX_BOARDS = 5000;

/** Total plus the first page's posting ids, as one short string. */
export function listingFingerprint(total, firstPage = []) {
  const ids = firstPage.map((p) => p?.externalPath ?? p?.id ?? p?.title ?? '').join('\n');
  return `${Number(total) || 0}:${createHash('sha256').update(ids).digest('hex').slice(0, 16)}`;
}

/**
 * @param {{root?: string|null, now?: () => number, fullSweepDays?: number}} [options]
 *   root null keeps everything in memory (tests).
 */
export function createBoardFingerprints({ root = null, now = Date.now, fullSweepDays = FULL_SWEEP_DAYS } = {}) {
  const file = root ? join(workspacePaths(root).dataDir, 'board_fingerprints.json') : null;
  let state = { lastFullSweep: null, boards: {} };
  if (file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed.boards === 'object') state = { lastFullSweep: parsed.lastFullSweep ?? null, boards: parsed.boards };
    } catch { /* first run */ }
  }
  const last = Date.parse(state.lastFullSweep ?? '');
  const fullSweep = !Number.isFinite(last) || now() - last >= fullSweepDays * 86_400_000;
  const seen = {};

  return {
    /** True when this run must read everything. */
    fullSweep,
    /** Does this board still hold what it held last time? Never true on a full sweep. */
    unchanged(key, fingerprint) {
      return !fullSweep && state.boards[key]?.fp === fingerprint;
    },
    /** Remember a board after a walk with no errors. */
    record(key, fingerprint) {
      seen[key] = { fp: fingerprint, at: new Date(now()).toISOString() };
    },
    /** Call once the search ends: a completed full sweep starts the clock again. */
    finishRun({ completed }) {
      Object.assign(state.boards, seen);
      if (fullSweep && completed) state.lastFullSweep = new Date(now()).toISOString();
    },
    save() {
      if (!file) return;
      const keys = Object.keys(state.boards);
      if (keys.length > MAX_BOARDS) {
        keys.sort((a, b) => String(state.boards[a].at).localeCompare(String(state.boards[b].at)));
        for (const k of keys.slice(0, keys.length - MAX_BOARDS)) delete state.boards[k];
      }
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, `${JSON.stringify(state)}\n`);
      renameSync(`${file}.tmp`, file);
    },
  };
}
