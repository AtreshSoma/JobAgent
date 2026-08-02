/**
 * SmartRecruiters connector — uses the OFFICIAL public Posting API.
 *   https://api.smartrecruiters.com/v1/companies/{company}/postings
 *
 * No login, no scraping, no evasion. Reads published posting JSON only. The
 * list endpoint omits the full description; we keep discovery to one request
 * per company page and synthesize a compact jdText from the available fields
 * (title, function, industry, type, location). Scoring still works because the
 * title/discovery filters carry most signal; the human reviews the real posting.
 */

import { normalizeJob } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout, httpError, discoveryHeaders } from '../../utils/httpClient.js';

export const adapterId = 'smartrecruiters';

/** Postings per request. 100 is the maximum the API serves in one page. */
const PAGE_LIMIT = 100;

/**
 * Hard ceiling on postings read per company, across all pages.
 *
 * This adapter used to issue exactly ONE request per company and keep whatever
 * the first 100 postings happened to be. That silently truncated every large
 * employer: ServiceNow publishes 442 postings and Experian 495, so more than
 * two thirds of both boards were never seen. Worse, it was invisible — the
 * window rotates as postings are added, so the database slowly accumulated
 * different first-100 slices and looked like healthy coverage.
 *
 * The API honors `offset`, so we now page until `totalFound` is reached. The
 * ceiling exists only to stop a runaway loop on a pathological board.
 */
const DEFAULT_MAX_POSTINGS_PER_COMPANY = 1000;

/** Default number of companies to fetch in parallel when ctx omits a ceiling. */
const DEFAULT_BOARD_CONCURRENCY = 8;

/** Every SmartRecruiters company shares this host — key politeness on it. */
const SMARTRECRUITERS_HOST = 'api.smartrecruiters.com';

/**
 * @param {object} source jobboards source entry ({ boards: string[] } — SmartRecruiters company identifiers)
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {{ wait: Function }} [ctx.rateLimiter]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.boardConcurrency]
 * @param {number} [ctx.requestTimeoutMs]
 * @returns {Promise<{ jobs: object[], errors: Array<{company: string, error: string}> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const companies = Array.isArray(source.boards) ? source.boards : [];
  const concurrency = ctx.boardConcurrency ?? DEFAULT_BOARD_CONCURRENCY;
  const maxPostings = Number.isFinite(source.maxPostingsPerCompany)
    ? Math.max(0, source.maxPostingsPerCompany)
    : DEFAULT_MAX_POSTINGS_PER_COMPANY;
  const jobs = [];
  const errors = [];
  let cancelled = false;

  const perCompany = await mapWithConcurrency(companies, concurrency, async (company) => {
    if (ctx.shouldCancel?.()) { cancelled = true; return null; }
    const collected = [];
    try {
      // Page until the API says we have them all. Pages are sequential because
      // each one's necessity depends on the previous page's `totalFound`.
      for (let offset = 0; offset < maxPostings;) {
        if (ctx.shouldCancel?.()) { cancelled = true; break; }
        if (rateLimiter) await rateLimiter.wait(`smartrecruiters:${SMARTRECRUITERS_HOST}`, source.rateLimitMs);
        const limit = Math.min(PAGE_LIMIT, maxPostings - offset);
        const url = `https://${SMARTRECRUITERS_HOST}/v1/companies/${encodeURIComponent(company)}`
          + `/postings?limit=${limit}&offset=${offset}`;
        const call = () => fetchJson(fetchImpl, url, requestTimeoutMs);
        const data = await withRetry(
          () => (hostGate ? hostGate.run(url, call) : call()),
          { maxRetries },
        );
        const page = Array.isArray(data.content) ? data.content : [];
        collected.push(...page);
        // An empty or short page means the board is exhausted; without this a
        // board whose `totalFound` over-reports would loop to the ceiling.
        if (page.length === 0 || page.length < limit) break;
        offset += page.length;
        const total = Number(data.totalFound);
        if (Number.isFinite(total) && offset >= total) break;
      }
      return { jobs: collected.map((p) => mapPosting(p, company)), error: null };
    } catch (err) {
      return {
        // Keep whatever pages already succeeded — a failure on page 4 must not
        // discard pages 1-3.
        jobs: collected.map((p) => mapPosting(p, company)),
        error: { company, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0 },
      };
    }
  });

  for (const r of perCompany) {
    if (!r) continue;
    jobs.push(...r.jobs);
    if (r.error) errors.push(r.error);
  }
  return { jobs, errors, cancelled };
}

async function fetchJson(fetchImpl, url, requestTimeoutMs) {
  const res = await fetchWithTimeout(fetchImpl, url, { headers: discoveryHeaders() }, requestTimeoutMs);
  if (!res.ok) throw httpError(res, 'SmartRecruiters', url);
  return res.json();
}

/** Map one SmartRecruiters posting (list shape) to the normalized form. */
export function mapPosting(p, company) {
  const loc = p.location ?? {};
  const locationLabel = [loc.city, loc.region, loc.country?.toUpperCase()]
    .filter(Boolean).join(', ');
  const jdBits = [
    p.name,
    p.typeOfEmployment?.label,
    p.experienceLevel?.label,
    p.function?.label,
    p.industry?.label,
    loc.remote ? 'Remote' : locationLabel,
  ].filter(Boolean);
  return normalizeJob({
    source: 'smartrecruiters',
    sourceJobId: String(p.id ?? p.refNumber ?? ''),
    company: p.company?.name ?? company,
    title: p.name ?? '',
    location: loc.remote ? (locationLabel ? `Remote — ${locationLabel}` : 'Remote') : locationLabel,
    url: `https://jobs.smartrecruiters.com/${encodeURIComponent(p.company?.identifier ?? company)}/${encodeURIComponent(p.id ?? '')}`,
    jdText: jdBits.join('. '),
    postedAt: p.releasedDate ?? null,
    employmentType: p.typeOfEmployment?.label ?? '',
    rawMetadata: { company, refNumber: p.refNumber ?? null, experienceLevel: p.experienceLevel?.label ?? null },
  });
}
