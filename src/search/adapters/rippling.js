/**
 * Rippling ATS connector — public job-board API, no key, no cost.
 *
 *   list   GET api.rippling.com/platform/api/ats/v1/board/{slug}/jobs
 *   detail GET api.rippling.com/platform/api/ats/v1/board/{slug}/jobs/{uuid}
 *
 * This is the unauthenticated JSON the vendor's own `ats.rippling.com/{slug}`
 * board calls to render itself — the same posture as the Greenhouse, Lever,
 * Ashby and Workday CXS feeds this codebase already reads. No login, no
 * scraping, no evasion; every request carries the identifying User-Agent.
 * api.rippling.com serves no robots.txt (404), so no directive is being ignored.
 *
 * WHY A SECOND REQUEST PER JOB. The list response is deliberately thin — uuid,
 * name, department, workLocation, url and nothing else. In particular it carries
 * NO posting date and NO description, which are exactly the two fields the rest
 * of the pipeline needs: without a date every row lands in the undated-review
 * bucket instead of being ranked by freshness, and without a description there
 * is nothing to score a fit against. The detail endpoint supplies both, plus the
 * real `companyName` (the slug is not it) and an `unlistedFromSearch` flag.
 *
 * That would be one request per job — 730 on the board this was measured
 * against — so the TITLE GATE RUNS FIRST, against the list's `name`. Only rows
 * that could plausibly be relevant cost a detail request, which turns a
 * 730-request board into a handful. `maxDetailFetches` is a hard backstop for a
 * board where the gate is loose or the titles unusually generic.
 *
 * What this adds over the company-first adapters already here: Rippling hosts
 * boards this codebase could not otherwise read at all, and the `url` it returns
 * is the employer's own ats.rippling.com application page — a DIRECT apply link,
 * not an aggregator hop that a human then has to trace back to the source.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchJsonWithTimeout, discoveryHeaders } from '../../utils/httpClient.js';
import { makeTitleGate, makeAgeGate } from './atsSearch.js';
import { profileVocabularyFor, sortByTitleFit } from '../../scoring/profileFit.js';
import { lookupDetail, jobFromCachedDetail } from '../detailBudget.js';

export const adapterId = 'rippling';

/** Every board lives on this one host, so politeness is keyed on it. */
const RIPPLING_HOST = 'api.rippling.com';

/** Boards fetched in parallel when ctx omits a ceiling. */
const DEFAULT_BOARD_CONCURRENCY = 4;

/** Detail requests in flight per board when ctx omits a ceiling. */
const DEFAULT_DETAIL_CONCURRENCY = 4;

/**
 * Hard ceiling on detail requests per board.
 *
 * The title gate is what normally keeps this small; this only bounds the damage
 * when a board's titles defeat it. Set it to 0 to emit list-only rows (no date,
 * no description) — which the freshness stage will send to undated review, so it
 * is rarely what you want.
 */
const DEFAULT_MAX_DETAIL_FETCHES = 40;

/**
 * @param {object} source jobboards source entry
 * @param {string[]} source.boards Rippling board slugs (the `{slug}` in
 *   `ats.rippling.com/{slug}`)
 * @param {object} [source.options]
 * @param {string[]} [source.options.titles] overrides candidate.targetTitles
 * @param {boolean} [source.options.strictTitleMatch=true] false = keep every
 *   posting on the board (and pay a detail request for each, up to the budget)
 * @param {number} [source.options.maxDetailFetches]
 * @param {number} [source.options.maxAgeDays] zombie-requisition guard
 * @param {object} ctx adapter context
 * @returns {Promise<{ jobs: object[], errors: object[], cancelled: boolean }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const options = source.options ?? {};
  const boards = Array.isArray(source.boards) ? source.boards.filter(Boolean) : [];
  const boardConcurrency = ctx.boardConcurrency ?? DEFAULT_BOARD_CONCURRENCY;
  const detailConcurrency = ctx.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
  const maxDetailFetches = Number.isFinite(options.maxDetailFetches)
    ? Math.max(0, options.maxDetailFetches)
    : DEFAULT_MAX_DETAIL_FETCHES;

  // Titles live in config/candidate.json so the list is not duplicated — and
  // then drifted — into jobboards.json. Same resolution order as atsSearch.
  const titleGate = makeTitleGate({
    titles: options.titles ?? ctx.candidate?.targetTitles ?? [],
    strict: options.strictTitleMatch !== false,
    candidate: ctx.candidate ?? null,
  });
  const ageGate = makeAgeGate(options.maxAgeDays);
  const vocab = profileVocabularyFor(ctx.candidate);
  const detailCache = ctx.detailCache ?? ctx.workdayDetailCache ?? null;

  const jobs = [];
  const errors = [];
  let cancelled = false;
  let reused = 0;

  const request = async (url) => {
    if (rateLimiter) await rateLimiter.wait(`rippling:${RIPPLING_HOST}`, source.rateLimitMs);
    const call = () => fetchJson(fetchImpl, url, requestTimeoutMs);
    return withRetry(() => (hostGate ? hostGate.run(url, call) : call()), { maxRetries });
  };

  const perBoard = await mapWithConcurrency(boards, boardConcurrency, async (slug) => {
    if (ctx.shouldCancel?.()) return { jobs: [], error: null, cancelled: true };
    const base = `https://${RIPPLING_HOST}/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs`;
    let listing;
    try {
      listing = await request(base);
    } catch (err) {
      return {
        jobs: [],
        error: {
          board: slug, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0,
        },
      };
    }
    const rows = Array.isArray(listing) ? listing : [];

    // Gate on the list's own title before spending a request on the detail.
    //
    // A posting read on an earlier run is rebuilt from its stored row — looked
    // up by URL, because a Rippling job id includes the company name only the
    // detail returns — and costs no request. The budget then lands on postings
    // never read before, so coverage grows run over run instead of re-buying
    // the same top-ranked titles.
    const fromCache = [];
    const candidates = [];
    for (const row of rows.filter((r) => titleGate(r?.name))) {
      const hit = row?.url ? lookupDetail(detailCache, { url: row.url, source: 'rippling' }) : null;
      const job = hit ? jobFromCachedDetail(hit, {
        source: 'rippling', url: row.url, title: row.name, rawMetadata: { board: slug },
      }) : null;
      if (job && ageGate(job.postedAt)) fromCache.push(job);
      else if (!job) candidates.push(row);
    }
    // Best-first: certain matches are enriched before speculative ones.
    if (vocab) {
      candidates.splice(0, candidates.length, ...sortByTitleFit(candidates, (row) => row?.name, vocab));
    }
    const budgeted = maxDetailFetches > 0 ? candidates.slice(0, maxDetailFetches) : [];
    const dropped = candidates.length - budgeted.length;

    const detailErrors = [];
    const detailed = await mapWithConcurrency(budgeted, detailConcurrency, async (row) => {
      if (ctx.shouldCancel?.()) { cancelled = true; return null; }
      const uuid = String(row?.uuid ?? '').trim();
      if (!uuid) return null;
      try {
        const full = await request(`${base}/${encodeURIComponent(uuid)}`);
        // A board can carry reqs it does not publish in its own search. Reading
        // one is not forbidden, but treating it as a live opening would be wrong.
        if (full?.unlistedFromSearch === true) return null;
        if (!ageGate(full?.createdOn ?? null)) return null;
        return mapJob(full, { slug, row });
      } catch (err) {
        detailErrors.push({
          board: slug, jobId: uuid, error: err.message,
          status: err.status ?? null, attempts: err.attempts ?? 0,
        });
        return null;
      }
    });

    const found = detailed.filter(Boolean);
    // Say what was left behind rather than letting a truncated board read as a
    // fully-covered one.
    if (dropped > 0) {
      detailErrors.push({
        board: slug, degraded: true, count: dropped,
        error: `${dropped} title match(es) on the "${slug}" board went unread: the `
          + `per-board detail budget (maxDetailFetches=${maxDetailFetches}) was reached. `
          + 'Raise it, or narrow options.titles, to cover them.',
      });
    }
    return { jobs: [...fromCache, ...found], errors: detailErrors, reused: fromCache.length };
  });

  for (const r of perBoard) {
    if (!r) continue;
    if (r.cancelled) { cancelled = true; continue; }
    jobs.push(...(r.jobs ?? []));
    reused += Number(r.reused) || 0;
    if (r.error) errors.push(r.error);
    if (Array.isArray(r.errors)) errors.push(...r.errors);
  }
  return { jobs, errors, cancelled, reused };
}

async function fetchJson(fetchImpl, url, requestTimeoutMs) {
  // One deadline for headers AND body — see fetchJsonWithTimeout.
  return fetchJsonWithTimeout(fetchImpl, url, { headers: discoveryHeaders({ Accept: 'application/json' }) }, requestTimeoutMs, 'Rippling');
}

/**
 * Rippling splits the posting into `description.company` (boilerplate about the
 * employer, identical across that board's reqs) and `description.role` (the
 * actual requisition). Both are kept, role FIRST, because the scorer reads the
 * head of the text and leading company boilerplate would push the requirements
 * out of the part that decides the fit.
 * @param {object} description
 * @returns {string}
 */
export function descriptionText(description) {
  if (!description || typeof description !== 'object') return htmlToText(String(description ?? ''));
  const parts = [description.role, description.company]
    .map((part) => htmlToText(String(part ?? '')).trim())
    .filter(Boolean);
  return parts.join('\n\n');
}

/** Map a Rippling detail payload to the normalized shape. */
export function mapJob(full = {}, { slug = '', row = {} } = {}) {
  const locations = Array.isArray(full.workLocations) ? full.workLocations.filter(Boolean) : [];
  // The list row's workLocation is a {label, id} object; the detail's
  // workLocations is a plain string array. Prefer the detail, fall back to the
  // list's label so a location is never lost to shape differences.
  const location = locations.length
    ? locations.join('; ')
    : String(row?.workLocation?.label ?? '');

  return normalizeJob({
    source: 'rippling',
    sourceJobId: String(full.uuid ?? row?.uuid ?? ''),
    // `companyName` is the employer's real name; the slug is a URL token and
    // makes for a poor company label (and a poor dedup key).
    company: full.companyName || slug,
    title: full.name ?? row?.name ?? '',
    location,
    // The employer's own ATS application page — a direct apply link, which is
    // what the board is expected to carry wherever one exists.
    url: full.url ?? row?.url ?? '',
    jdText: descriptionText(full.description),
    postedAt: full.createdOn ?? null,
    employmentType: String(full.employmentType?.id ?? full.employmentType?.label ?? ''),
    rawMetadata: {
      board: slug,
      department: full.department?.label ?? row?.department?.label ?? null,
      workLocations: locations,
    },
  });
}
