/**
 * Greenhouse connector — uses the OFFICIAL public Job Board API.
 *   https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *
 * No login, no scraping, no evasion. Reads published board JSON only.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';

export const adapterId = 'greenhouse';

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

  for (const token of boards) {
    try {
      if (rateLimiter) await rateLimiter.wait(`greenhouse:${token}`, source.rateLimitMs);
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
      const data = await withRetry(() => fetchJson(fetchImpl, url), { maxRetries });
      for (const j of data.jobs ?? []) {
        jobs.push(mapJob(j, token));
      }
    } catch (err) {
      errors.push({ board: token, error: err.message });
    }
  }
  return { jobs, errors };
}

async function fetchJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    const e = new Error(`Greenhouse HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** Map one Greenhouse job to the normalized shape. */
export function mapJob(j, token) {
  return normalizeJob({
    source: 'greenhouse',
    sourceJobId: String(j.id ?? ''),
    company: j.company_name ?? token,
    title: j.title ?? '',
    location: j.location?.name ?? '',
    url: j.absolute_url ?? '',
    jdText: htmlToText(j.content ?? ''),
    postedAt: j.updated_at ?? j.first_published ?? null,
    employmentType: '',
    rawMetadata: { board: token, departments: j.departments ?? [] },
  });
}
