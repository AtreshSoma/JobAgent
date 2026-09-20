/**
 * Amazon Jobs connector — the public search endpoint amazon.jobs itself calls.
 *
 *   GET www.amazon.jobs/en/search.json
 *       ?base_query={phrase}&offset={n}&result_limit={n}&sort=recent
 *
 * No key, no login, no cookie, no CSRF token, no special headers — verified
 * answering 200 to a plain identifying User-Agent. Same posture as every other
 * connector here: public JSON only, no scraping, no evasion.
 *
 * ROBOTS. www.amazon.jobs/robots.txt is short and explicit: under `User-agent: *`
 * the ONLY disallowed paths are the `/internal` locale variants. Neither
 * `/en/search.json` nor `/en/jobs/` is restricted, and no Crawl-delay is set.
 * Checked 2026-08-05.
 *
 * WHY THIS EXISTS. Amazon's careers site is a JS-rendered SPA with no sitemap
 * and no JobPosting JSON-LD, so it was previously recorded as having no public
 * feed. This endpoint is the same data the SPA renders from, and it covers the
 * whole amazon.jobs family — AWS, Whole Foods, Audible, Twitch, Zappos and the
 * rest all post here — so one connector reaches many employers, each carrying
 * its own `company_name`.
 *
 * TWO FIELD QUIRKS worth knowing, both handled below:
 *  1. There are two ids. `id` is a uuid; `id_icims` is the numeric one that
 *     appears in public URLs. Use `id_icims` for identity so a job's id matches
 *     what a human sees.
 *  2. `posted_date` is human prose with IRREGULAR internal spacing
 *     ("August  5, 2026" — two spaces). Whitespace is collapsed before parsing;
 *     without that, strict date parsers reject it and the job arrives undated,
 *     which the freshness stage then drops.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout, httpError, discoveryHeaders } from '../../utils/httpClient.js';
import { makeTitleGate, makeAgeGate } from './atsSearch.js';
import { searchTermsFor } from './workday.js';

export const adapterId = 'amazonJobs';

const HOST = 'www.amazon.jobs';

/** Server page size. 100 is accepted; the endpoint is offset-paged. */
const DEFAULT_PAGE_SIZE = 100;

/** Hard runaway guard on pagination per phrase. */
const MAX_PAGES = 20;

/** Result pages fetched in parallel when ctx omits a ceiling. */
const DEFAULT_PAGE_CONCURRENCY = 3;

/**
 * @param {object} source jobboards entry
 * @param {object} [source.options]
 * @param {string[]} [source.options.queries] overrides the derived search phrases
 * @param {string[]} [source.options.titles] overrides candidate.targetTitles for the gate
 * @param {boolean} [source.options.strictTitleMatch=true]
 * @param {number} [source.options.maxAgeDays]
 * @param {number} [source.options.maxPagesPerQuery]
 * @param {object} ctx adapter context
 * @returns {Promise<{ jobs: object[], errors: object[], cancelled: boolean }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const options = source.options ?? {};
  const pageConcurrency = ctx.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
  const pageSize = Number.isFinite(options.pageSize) && options.pageSize > 0
    ? Math.min(options.pageSize, DEFAULT_PAGE_SIZE)
    : DEFAULT_PAGE_SIZE;
  const maxPages = Number.isFinite(options.maxPagesPerQuery)
    ? Math.min(MAX_PAGES, Math.max(1, Math.trunc(options.maxPagesPerQuery)))
    : MAX_PAGES;

  // Phrases come from the candidate's own target titles by the same minimal
  // set-cover used for Workday and ORC, so the profile stays the single source
  // of truth rather than being copied into jobboards.json and drifting.
  const queries = Array.isArray(options.queries) && options.queries.length
    ? options.queries.map((q) => String(q ?? '').trim()).filter(Boolean)
    : searchTermsFor(ctx.candidate, options.maxSearchTerms);

  const titleGate = makeTitleGate({
    titles: options.titles ?? ctx.candidate?.targetTitles ?? [],
    strict: options.strictTitleMatch !== false,
    candidate: ctx.candidate ?? null,
  });
  const ageGate = makeAgeGate(options.maxAgeDays);

  const errors = [];
  let cancelled = false;

  if (!queries.length) {
    return {
      jobs: [],
      errors: [{
        note: 'amazonJobs source enabled but no search phrases available. Add target '
          + 'titles to config/candidate.json, or pin options.queries.',
      }],
      cancelled: false,
    };
  }

  const request = async (url) => {
    if (rateLimiter) await rateLimiter.wait(`amazonJobs:${HOST}`, source.rateLimitMs);
    const call = () => fetchJson(fetchImpl, url, requestTimeoutMs);
    return withRetry(() => (hostGate ? hostGate.run(url, call) : call()), { maxRetries });
  };

  /** Walk every page for ONE phrase. */
  const fetchQuery = async (query) => {
    const first = await request(searchUrl(query, 0, pageSize));
    const firstRows = Array.isArray(first?.jobs) ? first.jobs : [];
    // `hits` is the real total; the rows array only describes this page.
    const total = Number.isFinite(first?.hits) ? first.hits : firstRows.length;
    const pageCount = Math.min(maxPages, Math.max(1, Math.ceil(total / pageSize)));

    const offsets = [];
    for (let page = 1; page < pageCount; page += 1) offsets.push(page * pageSize);
    const rest = await mapWithConcurrency(offsets, pageConcurrency, async (offset) => {
      if (ctx.shouldCancel?.()) { cancelled = true; return { rows: [], error: null }; }
      try {
        const data = await request(searchUrl(query, offset, pageSize));
        return { rows: Array.isArray(data?.jobs) ? data.jobs : [], error: null };
      } catch (err) {
        if (err?.cancelled) { cancelled = true; return { rows: [], error: null }; }
        return {
          rows: [],
          error: {
            query, offset, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0,
          },
        };
      }
    });

    const found = [...firstRows];
    for (const r of rest) {
      if (!r) continue;
      found.push(...r.rows);
      if (r.error) errors.push(r.error);
    }
    return found;
  };

  // Each phrase is a separate search and the same requisition comes back under
  // more than one, so dedupe on the public numeric id.
  const rows = [];
  const seen = new Set();
  for (const query of queries) {
    if (ctx.shouldCancel?.()) { cancelled = true; break; }
    let found;
    try {
      found = await fetchQuery(query);
    } catch (err) {
      if (err?.cancelled) { cancelled = true; break; }
      errors.push({
        query, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0,
      });
      continue;
    }
    for (const row of found) {
      const id = String(row?.id_icims ?? row?.id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  }

  const jobs = rows
    .map((row) => mapJob(row))
    .filter((job) => titleGate(job.title) && ageGate(job.postedAt));

  return { jobs, errors, cancelled };
}

/** Build the public search URL for a phrase/offset. */
export function searchUrl(query, offset = 0, pageSize = DEFAULT_PAGE_SIZE) {
  const params = new URLSearchParams({
    base_query: query,
    offset: String(offset),
    result_limit: String(pageSize),
    sort: 'recent',
  });
  return `https://${HOST}/en/search.json?${params.toString()}`;
}

async function fetchJson(fetchImpl, url, requestTimeoutMs) {
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    { headers: discoveryHeaders({ Accept: 'application/json' }) },
    requestTimeoutMs,
  );
  if (!res.ok) throw httpError(res, 'Amazon Jobs', url);
  return res.json();
}

/**
 * Parse Amazon's human posting date into ISO-8601.
 *
 * The field arrives as prose with irregular internal spacing — "August  5,
 * 2026" carries two spaces after the month. Collapsing whitespace first is what
 * makes it parseable; left alone, a strict parser returns NaN, the job arrives
 * undated, and the freshness filter drops undated jobs by default. So this
 * quirk is the difference between a job being found and silently vanishing.
 *
 * Never invents a date: unparseable input returns null.
 *
 * @param {unknown} value e.g. "August  5, 2026"
 * @returns {string|null} ISO-8601, or null
 */
export function parsePostedDate(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  // Anchor to UTC, not the machine's zone. `Date.parse("August 5, 2026")`
  // returns LOCAL midnight, so the same posting resolved to a different instant
  // on a developer's laptop than in CI — and near a month boundary, a different
  // DATE. A posting date carries no time of day, so UTC midnight is the honest
  // reading and the only reproducible one.
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS.indexOf(m[1].toLowerCase().slice(0, 3));
    if (month !== -1) {
      return new Date(Date.UTC(Number(m[3]), month, Number(m[2]))).toISOString();
    }
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Map one amazon.jobs search row to the normalized shape.
 * @param {object} row raw search record
 * @returns {object} normalized job
 */
export function mapJob(row = {}) {
  // `job_path` is the record's own public path — build the URL from it rather
  // than assembling a slug, because a wrong slug 302s while the real one is 200.
  const path = String(row.job_path ?? '').trim();
  const id = String(row.id_icims ?? row.id ?? '');
  const url = path
    ? new URL(path, `https://${HOST}`).href
    : `https://${HOST}/en/jobs/${encodeURIComponent(id)}`;

  const jdText = htmlToText([
    row.description,
    row.basic_qualifications,
    row.preferred_qualifications,
  ].filter(Boolean).join('\n\n'));

  return normalizeJob({
    source: 'amazonJobs',
    sourceJobId: id,
    // amazon.jobs hosts the whole family (AWS, Audible, Twitch, Whole Foods...),
    // so the row's own company_name is the employer — not a constant "Amazon".
    company: String(row.company_name ?? 'Amazon'),
    title: row.title ?? '',
    location: String(row.normalized_location ?? row.location ?? ''),
    url,
    jdText,
    postedAt: parsePostedDate(row.posted_date),
    employmentType: String(row.job_schedule_type ?? ''),
    rawMetadata: {
      jobCategory: row.job_category ?? null,
      jobFamily: row.job_family ?? null,
      businessCategory: row.business_category ?? null,
      isIntern: row.is_intern === true,
      // `url_next_step` resolves to a login wall; the public listing above is
      // the right link for a human, so the apply-side URL is kept for reference
      // only and never used as the job's url.
      nextStepUrl: row.url_next_step ?? null,
    },
  });
}
