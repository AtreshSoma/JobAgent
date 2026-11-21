/**
 * When each source last gave this workspace a COMPLETE listing, and which
 * employers it has listed (audit D1).
 *
 * WHY THIS EXISTS. The discovery window (runtime.jobFreshnessMode) admits a
 * posting the store has never seen only when it was posted inside the window.
 * That reads "posted in the last N days" as "new to us", which is only true when
 * the source was read completely in the last N days. Measured on the live store
 * (2026-11-16): with a 3-day window and runs on Nov 15, 16 and 20, 1,715 of
 * 1,839 data-engineering postings were written as `stale` the first time they
 * were seen, and a discarded row is never retained, so they were never judged.
 * An employer added to the config fared worst: its whole open backlog was older
 * than three days on the first run, so almost nothing from it ever surfaced.
 *
 * Two clocks are kept per configured source id:
 *
 *   lastCompleteAt  the last run whose listing was complete (ran, not cancelled,
 *                   no real error, nothing skipped by the board fingerprints).
 *                   The window for that source widens to cover the gap since
 *                   then, so a missed day, a failed source or a skipped page no
 *                   longer loses postings.
 *   companies       employers the source has listed before. A posting from an
 *                   employer this source has NEVER listed (a tenant or careers
 *                   site just added to the config) gets the retention window,
 *                   restricted to titles that fit the profile, so adding a
 *                   company surfaces its open backlog once.
 *
 * Per WORKSPACE (data/profiles/<id>/source_coverage.json), not shared: another
 * profile's run says nothing about what THIS profile's store has seen.
 *
 * The file is a hint. Missing or corrupt, every source is treated as new, which
 * errs toward judging more postings, never fewer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { workspacePaths } from '../profile/workspace.js';

const DAY_MS = 864e5;

/**
 * Minimum `titleFitPriority` for a backfilled or re-admitted posting: a title the
 * candidate stated (4) or an adjacent one (3). Measured on the live store's
 * stale rows: level 3-4 was 840 rows, all on-target ("Senior Data Engineer",
 * "Analytics Engineer", "Power BI Developer"); level 2 (a technology mention)
 * added 493 mostly off-target ("Warehouse GM", "Software Engineer, Spark
 * Platform"); level 1 added 6,091 ("Construction Quality Engineer (Data
 * Centers)"). Catch-up for a gap is NOT title-gated: those postings are what a
 * daily run would have admitted anyway.
 */
export const BACKFILL_MIN_TITLE_FIT = 3;

/** Employers remembered per source; far above any real config. */
const MAX_COMPANIES_PER_SOURCE = 20000;

/** @param {string} root */
export function coveragePath(root) {
  return join(workspacePaths(root).dataDir, 'source_coverage.json');
}

/** Stable employer key: case, punctuation and spacing do not matter. */
export function companyKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The catch-up window for one source, in days.
 *
 * @param {object} args
 * @param {string|null} args.lastCompleteAt ISO time of the last complete listing
 * @param {Date} args.now
 * @param {number} args.retentionDays exclusions.staleness.skipOlderThanDays
 * @returns {{days: number, reason: 'gap'|'new-source', requireTitleFit: boolean}}
 */
export function catchUpWindow({ lastCompleteAt, now, retentionDays }) {
  const retention = Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 45;
  const at = Date.parse(lastCompleteAt ?? '');
  if (!Number.isFinite(at)) {
    return { days: retention, reason: 'new-source', requireTitleFit: true };
  }
  // +1 day: postings dated on the day of the last run may have appeared after
  // it read the board, and dates are often day-granular.
  const gapDays = Math.max(0, Math.ceil((now.getTime() - at) / DAY_MS)) + 1;
  return { days: Math.min(retention, gapDays), reason: 'gap', requireTitleFit: false };
}

/**
 * @param {object} [options]
 * @param {string|null} [options.root] null keeps state in memory (tests)
 * @param {() => number} [options.now]
 * @param {(path: string) => string} [options.readFileImpl]
 * @param {(path: string, data: string) => void} [options.writeFileImpl]
 */
export function createSourceCoverage({
  root = null, now = () => Date.now(), readFileImpl, writeFileImpl,
} = {}) {
  const path = root ? coveragePath(root) : null;
  const read = readFileImpl ?? ((p) => readFileSync(p, 'utf8'));
  const write = writeFileImpl ?? ((p, data) => writeFileAtomic(p, data, 'utf8'));
  /** @type {Record<string, {lastCompleteAt?: string, found?: number, companies?: Record<string, string>}>} */
  let sources = {};
  /** @type {{at: string, zeroYield: Array<{name: string, sources: string[]}>}|null} */
  let lastRun = null;
  if (path) {
    try {
      const parsed = JSON.parse(read(path));
      if (parsed?.sources && typeof parsed.sources === 'object') sources = parsed.sources;
      if (parsed?.lastRun && typeof parsed.lastRun === 'object') lastRun = parsed.lastRun;
    } catch {
      sources = {};
    }
  }

  /** @param {string} sourceId */
  function lastCompleteAt(sourceId) {
    return sources[sourceId]?.lastCompleteAt ?? null;
  }

  /** Has this source listed this employer on a complete run before? */
  function knowsCompany(sourceId, company) {
    const key = companyKey(company);
    return Boolean(key && sources[sourceId]?.companies?.[key]);
  }

  /**
   * A resolver from job → catch-up window, frozen at call time. Call it BEFORE
   * the run records itself, so this run's own listing does not count as "seen".
   *
   * @param {{retentionDays: number, at?: Date}} opts
   * @returns {(sourceId: string|undefined, company: string|undefined) => ReturnType<typeof catchUpWindow>|null}
   */
  function resolver({ retentionDays, at = new Date(now()) }) {
    const frozen = structuredClone(sources);
    const bySource = new Map();
    return (sourceId, company) => {
      if (!sourceId) return null;
      const entry = frozen[sourceId];
      const key = companyKey(company);
      // An employer the source has never listed is new, whatever the source's clock.
      if (!entry?.lastCompleteAt || (key && !entry.companies?.[key])) {
        return catchUpWindow({ lastCompleteAt: null, now: at, retentionDays });
      }
      if (!bySource.has(sourceId)) {
        bySource.set(sourceId, catchUpWindow({ lastCompleteAt: entry.lastCompleteAt, now: at, retentionDays }));
      }
      return bySource.get(sourceId);
    };
  }

  /**
   * Fold this run in. Only a COMPLETE listing moves a source's clock or teaches
   * it employers: succeeded, not cancelled, not served partly from fingerprints.
   *
   * @param {Array<{source: string, succeeded?: boolean, cancelled?: boolean, cached?: boolean, found?: number}>} perSource
   * @param {Iterable<{sourceId?: string, company?: string}>} listed every posting the run returned
   * @param {{at?: Date}} [opts]
   * @returns {string[]} source ids whose clock moved
   */
  function record(perSource, listed = [], { at = new Date(now()) } = {}) {
    const iso = at.toISOString();
    const complete = new Set();
    for (const entry of perSource ?? []) {
      if (!entry?.source) continue;
      if (entry.succeeded !== true || entry.cancelled === true || entry.cached === true) continue;
      complete.add(entry.source);
    }
    for (const id of complete) {
      const prior = sources[id] ?? {};
      const found = (perSource.find((e) => e.source === id)?.found) ?? 0;
      sources[id] = { ...prior, lastCompleteAt: iso, found: Number(found) || 0, companies: { ...(prior.companies ?? {}) } };
    }
    for (const item of listed) {
      if (!complete.has(item?.sourceId)) continue;
      const key = companyKey(item.company);
      if (!key) continue;
      const companies = sources[item.sourceId].companies;
      if (!companies[key] && Object.keys(companies).length < MAX_COMPANIES_PER_SOURCE) companies[key] = iso;
    }
    return [...complete];
  }

  function save() {
    if (!path) return;
    try {
      write(path, `${JSON.stringify({ version: 1, sources, ...(lastRun ? { lastRun } : {}) }, null, 2)}\n`);
    } catch {
      // Losing the hint only means the next run treats sources as new.
    }
  }

  /** What the last complete profile run found missing (audit D8). */
  function setLastRun(value) {
    lastRun = value ? { at: value.at, zeroYield: Array.isArray(value.zeroYield) ? value.zeroYield : [] } : null;
  }

  return {
    lastCompleteAt, knowsCompany, resolver, record, save, path,
    setLastRun, lastRun: () => (lastRun ? structuredClone(lastRun) : null),
    snapshot: () => structuredClone(sources),
  };
}
