/**
 * Adzuna connector — query-first discovery through the OFFICIAL Adzuna API.
 *
 * Adzuna is a job-search AGGREGATOR: it indexes postings from company sites,
 * ATS boards and other job boards, and exposes them through a documented public
 * REST API with a free developer key. That makes it the closest legitimate
 * substitute for the breadth the paid Apify actors were buying, at no per-run
 * cost and with none of the terms-of-service problems that scraping an
 * aggregator's HTML would create.
 *
 *   GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}
 *       ?app_id=&app_key=&what_phrase=&where=&results_per_page=&max_days_old=&sort_by=date
 *
 * Compliance posture:
 *   - Official documented API with YOUR credentials. No scraping, no evasion.
 *   - Adzuna's terms require that the user be sent to the advertiser via the
 *     `redirect_url` the API returns. This adapter therefore uses redirect_url
 *     verbatim as the job's apply URL and never tries to resolve or bypass it.
 *   - Credentials are sent as query parameters because the API accepts no other
 *     form. Every URL is stripped of its query string before it can appear in an
 *     error message or log line, so the key cannot leak that way.
 *
 * Free tier is roughly 1,000 calls/month. One call covers one title for one
 * page, so ~17 target titles polled once a day is ~510 calls — comfortably
 * inside it. `maxPages` and `maxQueries` exist to keep it that way.
 *
 * VERIFIED LIVE 2026-08-01 against a real key. Field mapping is correct — but
 * that same run exposed that `what_phrase` is NOT title-scoped: a "Data
 * Engineer" query returned 31,148 total matches (Adzuna's whole US corpus is
 * roughly that order of magnitude), and the page included "Accounts Payable
 * Administrator" and "IT Support Technical Instructor" — the phrase matches
 * somewhere in the full posting body, not just the title. A tighter phrase
 * fares better ("Business Intelligence Developer" -> 270, all on-target), but
 * short/generic titles need the same client-side title gate the atsSearch
 * adapter already built for the identical problem on Workable/SmartRecruiters
 * — reused here rather than reimplemented.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { getSecret } from '../../utils/credentialManager.js';
import { fetchWithTimeout, httpError, discoveryHeaders } from '../../utils/httpClient.js';
import { makeTitleGate, candidateQueryPhrases } from './atsSearch.js';

export const adapterId = 'adzuna';

const API_HOST = 'api.adzuna.com';

/** How many title queries to run in parallel against the one API host. */
const DEFAULT_QUERY_CONCURRENCY = 3;

/** Pages per query. Adzuna serves up to 50 results per page. */
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_RESULTS_PER_PAGE = 50;

/**
 * @param {object} source jobboards source entry
 * @param {object} source.options
 * @param {string} [source.options.appIdEnv='ADZUNA_APP_ID']
 * @param {string} [source.options.appKeyEnv='ADZUNA_APP_KEY']
 * @param {string} [source.options.country='us']
 * @param {string} [source.options.where='United States']
 * @param {string[]} [source.options.queries] overrides candidate.targetTitles
 * @param {number} [source.options.maxPages]
 * @param {number} [source.options.resultsPerPage]
 * @param {number} [source.options.maxDaysOld=7]
 * @param {object} ctx adapter context
 * @returns {Promise<{ jobs: object[], errors: object[], cancelled: boolean }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs, env } = ctx;
  const options = source.options ?? {};
  const country = options.country ?? 'us';
  const where = options.where ?? 'United States';
  const maxPages = Number.isFinite(options.maxPages) ? Math.max(1, options.maxPages) : DEFAULT_MAX_PAGES;
  const perPage = Number.isFinite(options.resultsPerPage)
    ? Math.min(50, Math.max(1, options.resultsPerPage))
    : DEFAULT_RESULTS_PER_PAGE;
  const maxDaysOld = Number.isFinite(options.maxDaysOld) ? Math.max(1, options.maxDaysOld) : 7;

  const jobs = [];
  const errors = [];
  let cancelled = false;

  const appId = getSecret(options.appIdEnv || 'ADZUNA_APP_ID', { env });
  const appKey = getSecret(options.appKeyEnv || 'ADZUNA_APP_KEY', { env });
  if (!appId || !appKey) {
    errors.push({
      error: 'Missing Adzuna credentials. Register a free key at '
        + 'https://developer.adzuna.com/ and set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env.',
      category: 'missing_credentials',
    });
    return { jobs, errors, cancelled };
  }

  // `what_phrase` matches anywhere in the posting, not just the title (see the
  // file header) — a bare "Data Engineer" query pulls in unrelated roles that
  // merely mention one somewhere in the body. Gate on title the same way
  // atsSearch does, using the same candidate.targetTitles as the query source.
  const queries = resolveQueries(options, ctx);

  const titleGate = makeTitleGate({
    // With no profile, gate on the QUERIES. They are the only statement of
    // intent available, and `what_phrase` matching the whole body means an
    // ungated run keeps things like "Accounts Payable Administrator" that merely
    // mention a query term. Falling back to an empty title list would disable
    // the gate entirely and admit exactly that noise.
    titles: ctx.candidate?.targetTitles ?? queries,
    strict: options.strictTitleMatch !== false,
    candidate: ctx.candidate ?? null,
  });
  if (queries.length === 0) {
    errors.push({
      error: 'Adzuna is enabled but has no queries. Add `options.queries`, or set '
        + '`targetTitles` in config/candidate.json (the default source of queries).',
    });
    return { jobs, errors, cancelled };
  }

  const concurrency = ctx.queryConcurrency ?? options.queryConcurrency ?? DEFAULT_QUERY_CONCURRENCY;
  const results = await mapWithConcurrency(queries, concurrency, async (query) => {
    if (ctx.shouldCancel?.()) { cancelled = true; return null; }
    const found = [];
    // Tracked so a failure can say WHICH page died. Everything paged in before
    // it is returned regardless, so the report must not imply the query was
    // lost wholesale.
    let page = 0;
    try {
      for (page = 1; page <= maxPages; page += 1) {
        if (ctx.shouldCancel?.()) { cancelled = true; break; }
        if (rateLimiter) await rateLimiter.wait(`adzuna:${API_HOST}`, source.rateLimitMs);

        const url = buildSearchUrl({
          country, page, appId, appKey, query, where, perPage, maxDaysOld,
        });
        const call = () => fetchJson(fetchImpl, url, requestTimeoutMs);
        const data = await withRetry(
          () => (hostGate ? hostGate.run(url, call) : call()),
          { maxRetries },
        );

        const rows = Array.isArray(data.results) ? data.results : [];
        for (const row of rows) {
          if (!titleGate(row.title)) continue;
          const job = mapJob(row, query);
          if (job) found.push(job);
        }
        // A short page means the result set is exhausted — stop paying calls
        // for pages the free tier would rather we spent on another title.
        if (rows.length < perPage) break;
      }
      return { jobs: found, error: null };
    } catch (err) {
      return {
        jobs: found,
        error: {
          query,
          error: err.message,
          status: err.status ?? null,
          attempts: err.attempts ?? 0,
          // The failure cost the REST of this query's pages, not the source and
          // not the pages already gathered — `found` above is still returned.
          // Saying so structurally is what stops the dashboard reporting
          // "results from adzuna are missing" over a run that kept 691 jobs.
          scope: 'query',
          page,
          keptFromQuery: found.length,
        },
      };
    }
  });

  for (const r of results) {
    if (!r) continue;
    jobs.push(...r.jobs);
    if (r.error) errors.push(r.error);
  }
  return { jobs, errors, cancelled };
}

/**
 * Build a search URL.
 *
 * `what_phrase` (not `what`) is used deliberately: `what` matches any of the
 * words, which for "Data Engineer" returns every posting containing "data" OR
 * "engineer". The phrase form is what makes the free call budget worth spending.
 *
 * @returns {string}
 */
export function buildSearchUrl({
  country, page, appId, appKey, query, where, perPage, maxDaysOld,
}) {
  const url = new URL(`https://${API_HOST}/v1/api/jobs/${encodeURIComponent(country)}/search/${page}`);
  url.searchParams.set('app_id', appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('results_per_page', String(perPage));
  url.searchParams.set('what_phrase', query);
  if (where) url.searchParams.set('where', where);
  if (Number.isFinite(maxDaysOld)) url.searchParams.set('max_days_old', String(maxDaysOld));
  url.searchParams.set('sort_by', 'date');
  url.searchParams.set('content-type', 'application/json');
  return url.href;
}

/** Queries come from explicit config, else the profile's search phrases. */
function resolveQueries(options, ctx) {
  const explicit = Array.isArray(options.queries) ? options.queries : null;
  const list = explicit ?? candidateQueryPhrases(ctx.candidate);
  const seen = new Set();
  const out = [];
  for (const q of list) {
    const trimmed = String(q ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  const max = Number.isFinite(options.maxQueries) ? Math.max(0, options.maxQueries) : out.length;
  return out.slice(0, max);
}

/**
 * Map one Adzuna result to the normalized job shape.
 *
 * Field names follow Adzuna::API::Response::Job and its ::Ad base:
 * id, created, title, description (truncated to 500 chars), full_description,
 * redirect_url, company.display_name, location.{display_name,area[]},
 * contract_type, contract_time, salary_min/max.
 *
 * @param {object} row raw result
 * @param {string} [query] provenance
 * @returns {object|null}
 */
export function mapJob(row, query = '') {
  if (!row || typeof row !== 'object') return null;
  const title = String(row.title ?? '').trim();
  // Adzuna's terms require sending the user through redirect_url; it is the only
  // apply URL we may use, so a row without one is unusable rather than guessable.
  const url = String(row.redirect_url ?? '').trim();
  if (!title || !url) return null;

  const description = row.full_description ?? row.description ?? '';
  const salary = formatSalary(row);

  return normalizeJob({
    source: 'adzuna',
    sourceJobId: String(row.id ?? ''),
    company: row.company?.display_name ?? '',
    title,
    location: formatLocation(row.location),
    url,
    jdText: htmlToText(String(description)).slice(0, 20000),
    postedAt: row.created ?? null,
    employmentType: [row.contract_time, row.contract_type].filter(Boolean).join(', '),
    rawMetadata: {
      provider: 'adzuna',
      query,
      category: row.category?.label ?? null,
      // `description` is capped at 500 chars by the API; when that is all we
      // got, say so rather than let the scorer treat a blurb as a full JD.
      summaryOnly: !row.full_description,
      ...(salary ? { compensation: salary } : {}),
    },
  });
}

/** "Austin, Texas, US" from the location object's area chain. */
function formatLocation(location) {
  if (!location || typeof location !== 'object') return '';
  const display = typeof location.display_name === 'string' ? location.display_name.trim() : '';
  if (display) return display;
  const area = Array.isArray(location.area) ? location.area.filter(Boolean) : [];
  // `area` is ordered broadest-first (country -> region -> city); reverse it so
  // the label reads the way every other adapter's does.
  return area.slice().reverse().join(', ');
}

/** Human salary range, skipping Adzuna's predicted (not advertised) figures. */
function formatSalary(row) {
  if (row.salary_is_predicted === true || row.salary_is_predicted === '1') return '';
  const min = Number(row.salary_min);
  const max = Number(row.salary_max);
  const fmt = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
  if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0) {
    return min === max ? fmt(min) : `${fmt(min)} - ${fmt(max)}`;
  }
  if (Number.isFinite(min) && min > 0) return `${fmt(min)}+`;
  return '';
}

async function fetchJson(fetchImpl, url, requestTimeoutMs) {
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    { headers: discoveryHeaders({ Accept: 'application/json' }) },
    requestTimeoutMs,
  );
  // The credentials live in the query string because the API takes them no other
  // way — so it must never reach an error message intact.
  if (!res.ok) throw httpError(res, 'Adzuna', stripQuery(url));
  return res.json();
}

/** Remove the query string (and therefore the key) before logging a URL. */
export function stripQuery(url) {
  const i = String(url).indexOf('?');
  return i === -1 ? String(url) : String(url).slice(0, i);
}
