/**
 * Lever connector — uses the OFFICIAL public postings API.
 *   https://api.lever.co/v0/postings/{company}?mode=json
 *
 * No login, no scraping, no evasion. Reads published postings JSON only.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';

export const adapterId = 'lever';

/**
 * @param {object} source jobboards source entry ({ boards: string[] })
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {{ wait: Function }} [ctx.rateLimiter]
 * @param {number} [ctx.maxRetries]
 * @returns {Promise<{ jobs: object[], errors: Array<{board: string, error: string}> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, maxRetries = 3 } = ctx;
  const boards = Array.isArray(source.boards) ? source.boards : [];
  const jobs = [];
  const errors = [];

  for (const company of boards) {
    try {
      if (rateLimiter) await rateLimiter.wait(`lever:${company}`, source.rateLimitMs);
      const url = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
      const data = await withRetry(() => fetchJson(fetchImpl, url), { maxRetries });
      for (const j of Array.isArray(data) ? data : []) {
        jobs.push(mapJob(j, company));
      }
    } catch (err) {
      errors.push({ board: company, error: err.message });
    }
  }
  return { jobs, errors };
}

async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    const e = new Error(`Lever HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** Map one Lever posting to the normalized shape. */
export function mapJob(j, company) {
  const postedAt = j.createdAt ? new Date(j.createdAt).toISOString() : null;
  return normalizeJob({
    source: 'lever',
    sourceJobId: String(j.id ?? ''),
    // The board slug is the canonical company; the Lever "team" category is kept
    // in rawMetadata only (it is a sub-team, not the employer name).
    company,
    title: j.text ?? '',
    location: j.categories?.location ?? '',
    url: j.hostedUrl ?? j.applyUrl ?? '',
    jdText: htmlToText(j.descriptionPlain ?? j.description ?? ''),
    postedAt,
    employmentType: j.categories?.commitment ?? '',
    rawMetadata: { company, team: j.categories?.team ?? null },
  });
}
