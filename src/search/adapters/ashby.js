/**
 * Ashby connector — uses the OFFICIAL public Job Posting API.
 *   https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true
 *
 * No login, no scraping, no evasion. Reads the published job-board JSON only.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchJsonWithTimeout } from '../../utils/httpClient.js';
import { earlyTitleGate } from './atsSearch.js';

export const adapterId = 'ashby';

/** Default number of boards to fetch in parallel when ctx omits a ceiling. */
const DEFAULT_BOARD_CONCURRENCY = 8;

/** Every Ashby board shares this host — politeness must be keyed on it. */
const ASHBY_HOST = 'api.ashbyhq.com';

/**
 * @param {object} source jobboards source entry ({ boards: string[] })
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.boardConcurrency]
 * @param {number} [ctx.requestTimeoutMs]
 * @returns {Promise<{ jobs: object[], errors: Array<{board: string, error: string}> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const boards = Array.isArray(source.boards) ? source.boards : [];
  const concurrency = ctx.boardConcurrency ?? DEFAULT_BOARD_CONCURRENCY;
  const titleGate = earlyTitleGate(source, ctx);
  const jobs = [];
  const errors = [];

  const perBoard = await mapWithConcurrency(boards, concurrency, async (board) => {
    try {
      // No rate-limiter call here. It was keyed on the constant host string, so
      // every board shared ONE key: concurrent callers all read the same
      // `lastCall` before any of them wrote it, were released together, and
      // arrived as one burst — the limiter enforced no spacing at all and only
      // added dead latency. `hostGate` is the real politeness mechanism for
      // this host: it bounds in-flight requests, honors Retry-After, and trips
      // a breaker on repeated 429s. In-flight concurrency is unchanged.
      const url = `https://${ASHBY_HOST}/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
      const call = () => fetchJson(fetchImpl, url, requestTimeoutMs);
      const data = await withRetry(
        () => (hostGate ? hostGate.run(url, call) : call()),
        { maxRetries },
      );
      const mapped = (data.jobs ?? [])
        .filter((j) => j.isListed !== false && titleGate(j?.title))
        .map((j) => mapJob(j, board));
      return { jobs: mapped, error: null };
    } catch (err) {
      return {
        jobs: [],
        error: { board, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0 },
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
  // One deadline for headers AND body — see fetchJsonWithTimeout.
  return fetchJsonWithTimeout(fetchImpl, url, {}, requestTimeoutMs, 'Ashby');
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
