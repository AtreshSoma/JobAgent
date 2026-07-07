/**
 * Greenhouse connector — uses the OFFICIAL public Job Board API.
 *   https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *
 * No login, no scraping, no evasion. Reads published board JSON only.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout } from '../../utils/httpClient.js';

export const adapterId = 'greenhouse';

/** Default number of boards to fetch in parallel when ctx omits a ceiling. */
const DEFAULT_BOARD_CONCURRENCY = 8;

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
  const { fetchImpl = fetch, rateLimiter, maxRetries = 3, requestTimeoutMs } = ctx;
  const boards = Array.isArray(source.boards) ? source.boards : [];
  const concurrency = ctx.boardConcurrency ?? DEFAULT_BOARD_CONCURRENCY;
  const jobs = [];
  const errors = [];

  // Boards are independent public endpoints — fetch them in parallel (bounded).
  const perBoard = await mapWithConcurrency(boards, concurrency, async (token) => {
    try {
      if (rateLimiter) await rateLimiter.wait(`greenhouse:${token}`, source.rateLimitMs);
      const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`;
      const data = await withRetry(() => fetchJson(fetchImpl, url, requestTimeoutMs), { maxRetries });
      return { jobs: (data.jobs ?? []).map((j) => mapJob(j, token)), error: null };
    } catch (err) {
      return { jobs: [], error: { board: token, error: err.message } };
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
  if (!res.ok) {
    const e = new Error(`Greenhouse HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * Greenhouse's board API returns `content` as HTML-ESCAPED markup
 * (e.g. "&lt;p&gt;…&lt;/p&gt;"). Decode entities once — but only when the
 * payload has escaped tags and no real ones — so htmlToText can strip the
 * markup instead of leaving literal "<p>" tags in the JD text.
 * @param {string} content
 * @returns {string}
 */
export function unescapeHtmlPayload(content) {
  const s = String(content ?? '');
  if (!s || /<[a-z][\s\S]*>/i.test(s) || !/&lt;\s*\/?\s*[a-z]/i.test(s)) return s;
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
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
    jdText: htmlToText(unescapeHtmlPayload(j.content ?? '')),
    postedAt: j.updated_at ?? j.first_published ?? null,
    employmentType: '',
    rawMetadata: { board: token, departments: j.departments ?? [] },
  });
}
