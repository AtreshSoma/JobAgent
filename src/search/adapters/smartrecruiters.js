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
import { fetchWithTimeout } from '../../utils/httpClient.js';

export const adapterId = 'smartrecruiters';

const PAGE_LIMIT = 100;

/** Default number of companies to fetch in parallel when ctx omits a ceiling. */
const DEFAULT_BOARD_CONCURRENCY = 8;

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
  const { fetchImpl = fetch, rateLimiter, maxRetries = 3, requestTimeoutMs } = ctx;
  const companies = Array.isArray(source.boards) ? source.boards : [];
  const concurrency = ctx.boardConcurrency ?? DEFAULT_BOARD_CONCURRENCY;
  const jobs = [];
  const errors = [];

  const perCompany = await mapWithConcurrency(companies, concurrency, async (company) => {
    try {
      if (rateLimiter) await rateLimiter.wait(`smartrecruiters:${company}`, source.rateLimitMs);
      const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?limit=${PAGE_LIMIT}`;
      const data = await withRetry(() => fetchJson(fetchImpl, url, requestTimeoutMs), { maxRetries });
      return { jobs: (data.content ?? []).map((p) => mapPosting(p, company)), error: null };
    } catch (err) {
      return { jobs: [], error: { company, error: err.message } };
    }
  });

  for (const r of perCompany) {
    if (!r) continue;
    jobs.push(...r.jobs);
    if (r.error) errors.push(r.error);
  }
  return { jobs, errors };
}

async function fetchJson(fetchImpl, url, requestTimeoutMs) {
  const res = await fetchWithTimeout(fetchImpl, url, {}, requestTimeoutMs);
  if (!res.ok) {
    const e = new Error(`SmartRecruiters HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
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
