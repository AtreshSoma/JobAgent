/**
 * Freshness-first job ranking.
 *
 * Deterministic comparator used to order queues, scored lists, and reports so
 * the human always sees the most actionable roles first. Sort priority:
 *
 *   1. posted within the last 24 hours  (freshest first)
 *   2. sponsorship feasibility          (Confirmed/Approved > Likely > Unconfirmed)
 *   3. score                            (higher first)
 *   4. source quality / direct ATS      (direct ATS boards before aggregators)
 *
 * Stable and side-effect free: ties fall through to the next key, and an equal
 * comparison returns 0 so callers can rely on a stable Array.prototype.sort.
 */

import { isWithinLast24Hours } from '../utils/dates.js';

/** Higher rank = more feasible sponsorship outcome. */
const SPONSORSHIP_RANK = Object.freeze({
  Approved: 3,
  Confirmed: 3,
  Likely: 2,
  Unconfirmed: 1,
});

/** Direct-ATS / first-party sources outrank aggregators on a tie. */
const DIRECT_ATS_SOURCES = Object.freeze(new Set([
  'greenhouse', 'lever', 'workday', 'careers', 'manual',
]));

/** Read postedAt from either the normalized (camelCase) or db (snake_case) shape. */
function postedOf(job) {
  return job?.postedAt ?? job?.posted_at ?? null;
}

function sponsorshipRank(status) {
  return SPONSORSHIP_RANK[status] ?? 0;
}

function sourceQualityRank(source) {
  return DIRECT_ATS_SOURCES.has(source) ? 2 : 1;
}

/**
 * Build a comparator that orders jobs freshest-first then by the remaining keys.
 * @param {Date|string|number} [now] reference clock (injectable for tests)
 * @returns {(a: object, b: object) => number}
 */
export function compareJobsForQueue(now = new Date()) {
  return (a, b) => {
    const freshA = isWithinLast24Hours(postedOf(a), now) ? 1 : 0;
    const freshB = isWithinLast24Hours(postedOf(b), now) ? 1 : 0;
    if (freshA !== freshB) return freshB - freshA;

    const sponA = sponsorshipRank(a?.sponsorship);
    const sponB = sponsorshipRank(b?.sponsorship);
    if (sponA !== sponB) return sponB - sponA;

    const scoreA = typeof a?.score === 'number' ? a.score : -1;
    const scoreB = typeof b?.score === 'number' ? b.score : -1;
    if (scoreA !== scoreB) return scoreB - scoreA;

    const srcA = sourceQualityRank(a?.source);
    const srcB = sourceQualityRank(b?.source);
    if (srcA !== srcB) return srcB - srcA;

    return 0;
  };
}

/**
 * Return a new array of jobs ordered freshest-first by {@link compareJobsForQueue}.
 * @param {object[]} jobs
 * @param {Date|string|number} [now]
 * @returns {object[]}
 */
export function sortJobsForQueue(jobs = [], now = new Date()) {
  return [...jobs].sort(compareJobsForQueue(now));
}
