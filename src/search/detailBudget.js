/**
 * Reusing stored descriptions, and spending a detail budget on what is left.
 *
 * WHY THIS EXISTS. Every adapter with a per-board "detail budget" (Workday,
 * SmartRecruiters, Oracle, iCIMS, Rippling) faces the same two questions:
 *
 *   1. Which postings do we ALREADY have a full description for? A requisition
 *      read on an earlier run is just as accurate today, and re-buying it is
 *      pure cost — SmartRecruiters alone spent ~3,700 of ~3,800 requests per
 *      run re-reading postings already on disk before it hydrated from cache.
 *   2. Of the rest, which deserve one of the few fetches this run can afford?
 *
 * Only Workday and SmartRecruiters asked question 1, and they did it inline
 * with slightly different rules. Oracle, iCIMS and Rippling re-bought the same
 * top-ranked postings on EVERY run, so the budget never reached past them and
 * coverage never grew. Answering both questions here makes the budget ROLLING:
 * whatever was read before is hydrated for free, so each run's budget lands on
 * titles that have never been read, and coverage grows run over run.
 *
 * All helpers are pure over their inputs; the cache is injected.
 */

import { sortByTitleFit } from '../scoring/profileFit.js';
import { urlKeyFor } from './deduplicator.js';
import { normalizeJob } from './normalize.js';

/**
 * Read one stored description for a job, by id first and then by URL.
 *
 * The cache is the pipeline's `detailCache`: a function `(jobId) => detail`
 * that may also carry `.byUrl(url, source)` for adapters whose job id depends
 * on fields only the detail endpoint returns (Rippling's company name, iCIMS'
 * title as the portal renders it). A plain Map keyed by id also works.
 *
 * @param {Function|Map|null} detailCache
 * @param {{id?: string, url?: string, source?: string}} job
 * @returns {object|null} `{ jdText, postedAt?, location?, country?, ... }`
 */
export function lookupDetail(detailCache, job = {}) {
  if (!detailCache) return null;
  let hit = null;
  if (job.id) {
    hit = typeof detailCache === 'function' ? detailCache(job.id) : detailCache.get?.(job.id);
  }
  if (!hit?.jdText && job.url && typeof detailCache.byUrl === 'function') {
    hit = detailCache.byUrl(job.url, job.source);
  }
  return hit?.jdText ? hit : null;
}

/**
 * Hydrate normalized jobs from stored descriptions, in place.
 *
 * Location is restored as well as the text. A Workday list row collapses a
 * multi-location requisition to "2 Locations", which the adapter blanks; the
 * places were only ever on the detail endpoint. Hydrating the description but
 * not the location therefore left 3,955 stored Workday rows with a real JD and
 * an EMPTY location — invisible to the US-only gate, which is how two
 * Hyderabad requisitions reached the Apply tier. A stored location only fills a
 * blank (or a URL-derived primary place): whatever the listing states this run
 * is never overwritten.
 *
 * @param {object[]} jobs normalized jobs (mutated)
 * @param {Function|Map|null} detailCache
 * @returns {number} how many were hydrated
 */
export function hydrateFromDetailCache(jobs, detailCache) {
  if (!detailCache || !Array.isArray(jobs)) return 0;
  let reused = 0;
  for (const job of jobs) {
    if (!job || job.rawMetadata?.summaryOnly === false) continue;
    const cached = lookupDetail(detailCache, job);
    if (!cached) continue;
    applyCachedDetail(job, cached);
    reused += 1;
  }
  return reused;
}

/**
 * Merge one stored detail into a job, in place.
 * @param {object} job
 * @param {object} cached
 */
export function applyCachedDetail(job, cached) {
  job.rawMetadata = job.rawMetadata ?? {};
  job.jdText = cached.jdText;
  if (cached.postedAt) job.postedAt = cached.postedAt;
  // A location parsed from the URL path is only the PRIMARY place, so the
  // stored detail location (every place) may replace it too.
  const replaceable = !String(job.location ?? '').trim() || job.rawMetadata.locationFromUrl === true;
  if (replaceable && String(cached.location ?? '').trim()) {
    job.location = String(cached.location).trim();
    job.rawMetadata.locationReused = true;
    delete job.rawMetadata.locationFromUrl;
  }
  if (cached.country && !job.rawMetadata.country) job.rawMetadata.country = cached.country;
  job.rawMetadata.summaryOnly = false;
  job.rawMetadata.detailReused = true;
}

/**
 * Rebuild a job from its stored row, for sources whose job exists ONLY after a
 * detail read (iCIMS, Rippling: the listing has a title and a URL, and the
 * company, location and description all come from the detail).
 *
 * The stored id is reused verbatim so the row is refreshed rather than
 * duplicated. Returns null unless the cache hit carries an id.
 *
 * @param {object} cached a `createDetailCache` hit (with `id`)
 * @param {object} args
 * @param {string} args.source
 * @param {string} args.url listing URL (the canonical one this run saw)
 * @param {string} [args.title] listing title, used when the row has none
 * @param {object} [args.rawMetadata]
 * @returns {object|null} normalized job
 */
export function jobFromCachedDetail(cached, { source, url, title = '', rawMetadata = {} } = {}) {
  if (!cached?.id || !cached.jdText) return null;
  return normalizeJob({
    id: cached.id,
    source,
    company: cached.company ?? '',
    title: cached.title || title,
    location: cached.location ?? '',
    url: url || cached.url || '',
    jdText: cached.jdText,
    postedAt: cached.postedAt ?? null,
    rawMetadata: { ...rawMetadata, summaryOnly: false, detailReused: true },
  });
}

/**
 * Split what still needs a description into this run's budget and the rest,
 * best-first by title fit (priorities computed once — see `sortByTitleFit`).
 *
 * @template T
 * @param {T[]} items candidates that still need a detail read
 * @param {object} options
 * @param {number} options.budget max detail reads for this board
 * @param {object|null} [options.vocab] profile vocabulary; null keeps input order
 * @param {(item: T) => string} [options.titleOf]
 * @returns {{ budgeted: T[], unread: T[] }}
 */
export function planDetailBudget(items, { budget, vocab = null, titleOf = (x) => x?.title } = {}) {
  const list = Array.isArray(items) ? items : [];
  const cap = Number.isFinite(budget) ? Math.max(0, Math.trunc(budget)) : list.length;
  const ordered = vocab ? sortByTitleFit(list, titleOf, vocab) : [...list];
  return { budgeted: ordered.slice(0, cap), unread: ordered.slice(cap) };
}

/**
 * Build the pipeline's detail cache over a database handle.
 *
 * Returns a function `(jobId) => detail|null` with a `.byUrl(url, source)`
 * lookup. Reads the stored LOCATION alongside the text when the handle exposes
 * the raw SQLite connection (`db.db.prepare`), and falls back to
 * `getReusableDetail` (text + date only) otherwise — so it works against both
 * the current and a changed db.js.
 *
 * `byUrl` loads one `url -> id` map PER SOURCE on first use, and only for rows
 * that hold a real description, so the cost is paid once per run and only by
 * the sources that need it.
 *
 * @param {object} db Database wrapper (src/logging/db.js)
 * @returns {Function|null}
 */
export function createDetailCache(db) {
  if (!db) return null;
  const raw = db.db && typeof db.db.prepare === 'function' ? db.db : null;
  let byId = null;
  if (raw) {
    let stmt = null;
    byId = (id) => {
      try {
        stmt ??= raw.prepare(`
          SELECT id, jd_text AS jdText, posted_at AS postedAt, location, url, company, title
          FROM jobs
          WHERE id = ? AND length(trim(coalesce(jd_text, ''))) >= 200`);
        return stmt.get(id) ?? null;
      } catch {
        return null;
      }
    };
  } else if (typeof db.getReusableDetail === 'function') {
    byId = (id) => db.getReusableDetail(id);
  } else if (typeof db.getReusableWorkdayDetail === 'function') {
    byId = (id) => db.getReusableWorkdayDetail(id);
  }
  if (!byId) return null;

  const urlMaps = new Map();
  const cache = (id) => byId(id);
  cache.byUrl = (url, source) => {
    if (!raw || !url || !source) return null;
    let map = urlMaps.get(source);
    if (!map) {
      map = new Map();
      try {
        const rows = raw.prepare(`
          SELECT id, url FROM jobs
          WHERE source = ? AND trim(coalesce(url, '')) <> ''
            AND length(trim(coalesce(jd_text, ''))) >= 200`).all(source);
        for (const row of rows) {
          const key = urlKeyFor(row);
          if (key && !map.has(key)) map.set(key, row.id);
        }
      } catch { /* no map: behave as a miss */ }
      urlMaps.set(source, map);
    }
    const id = map.get(urlKeyFor({ url }));
    return id ? byId(id) : null;
  };
  return cache;
}
