/**
 * Lever connector — uses the OFFICIAL public postings API.
 *   https://api.lever.co/v0/postings/{company}?mode=json
 *
 * No login, no scraping, no evasion. Reads published postings JSON only.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout, httpError } from '../../utils/httpClient.js';

export const adapterId = 'lever';

/** Default number of boards to fetch in parallel when ctx omits a ceiling. */
const DEFAULT_BOARD_CONCURRENCY = 8;

/** Every Lever board shares this host — politeness must be keyed on it. */
const LEVER_HOST = 'api.lever.co';

/**
 * @param {object} source jobboards source entry ({ boards: string[] })
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {{ wait: Function }} [ctx.rateLimiter]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.boardConcurrency]
 * @param {number} [ctx.requestTimeoutMs]
 * @returns {Promise<{ jobs: object[], errors: Array<{board: string, error: string}> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const boards = Array.isArray(source.boards) ? source.boards : [];
  const concurrency = ctx.boardConcurrency ?? DEFAULT_BOARD_CONCURRENCY;
  const jobs = [];
  const errors = [];

  const perBoard = await mapWithConcurrency(boards, concurrency, async (company) => {
    try {
      if (rateLimiter) await rateLimiter.wait(`lever:${LEVER_HOST}`, source.rateLimitMs);
      const url = `https://${LEVER_HOST}/v0/postings/${encodeURIComponent(company)}?mode=json`;
      const call = () => fetchJson(fetchImpl, url, requestTimeoutMs);
      const data = await withRetry(
        () => (hostGate ? hostGate.run(url, call) : call()),
        { maxRetries },
      );
      const list = Array.isArray(data) ? data : [];
      return { jobs: list.map((j) => mapJob(j, company)), error: null };
    } catch (err) {
      return {
        jobs: [],
        error: { board: company, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0 },
      };
    }
  });

  for (const r of perBoard) {
    if (!r) continue;
    jobs.push(...r.jobs);
    if (r.error) errors.push(r.error);
  }
  return { jobs, errors };
}

async function fetchJson(fetchImpl, url, requestTimeoutMs) {
  const res = await fetchWithTimeout(fetchImpl, url, {}, requestTimeoutMs);
  if (!res.ok) throw httpError(res, 'Lever', url);
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
