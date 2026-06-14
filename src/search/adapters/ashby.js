/**
 * Ashby connector — uses the OFFICIAL public Job Posting API.
 *   https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true
 *
 * No login, no scraping, no evasion. Reads the published job-board JSON only.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout } from '../../utils/httpClient.js';

export const adapterId = 'ashby';

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

  const perBoard = await mapWithConcurrency(boards, concurrency, async (board) => {
    try {
      if (rateLimiter) await rateLimiter.wait(`ashby:${board}`, source.rateLimitMs);
      const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
      const data = await withRetry(() => fetchJson(fetchImpl, url, requestTimeoutMs), { maxRetries });
      const mapped = (data.jobs ?? [])
        .filter((j) => j.isListed !== false)
        .map((j) => mapJob(j, board));
      return { jobs: mapped, error: null };
    } catch (err) {
      return { jobs: [], error: { board, error: err.message } };
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
    const e = new Error(`Ashby HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/** Map one Ashby posting to the normalized shape. */
export function mapJob(j, board) {
  const locations = [j.location, ...(j.secondaryLocations ?? []).map((l) => l?.location)]
    .filter(Boolean).join('; ');
  return normalizeJob({
    source: 'ashby',
    sourceJobId: String(j.id ?? ''),
    company: j.organizationName ?? board,
    title: j.title ?? '',
    location: j.isRemote ? (locations ? `Remote — ${locations}` : 'Remote') : locations,
    url: j.jobUrl ?? j.applyUrl ?? '',
    jdText: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ''),
    postedAt: j.publishedAt ?? null,
    employmentType: j.employmentType ?? '',
    rawMetadata: {
      board,
      department: j.department ?? '',
      team: j.team ?? '',
      compensation: j.compensation?.compensationTierSummary ?? null,
    },
  });
}
