/**
 * Freshness filter (prioritize recent postings).
 *
 * Pure, deterministic, and config-driven. Given a list of normalized jobs and
 * the runtime freshness settings, it partitions jobs into kept vs dropped based
 * on a recency window, with an optional widening fallback to a 3-day window when
 * the strict window yields too few results.
 *
 * Modes (settings.jobFreshnessMode):
 *   LAST_24_HOURS (1d) | LAST_3_DAYS (3d) | LAST_7_DAYS (7d) | ALL (no limit)
 *
 * Rules:
 *   - A job's age is computed from `job.postedAt`. Unknown/unparseable dates are
 *     "undated". Undated jobs are NEVER mixed into the fresh `kept` results. They
 *     are routed to a separate `review` bucket only when includeUnknownDateJobs
 *     is true (for an UNKNOWN_DATE_REVIEW section a human can inspect); otherwise
 *     they are dropped.
 *   - When includeLast3DaysFallback is true and the number of kept *dated* jobs
 *     is below minResultsBeforeFallback, the window widens to 3 days (only if the
 *     primary window was stricter than 3 days). Undated handling is unchanged.
 *   - Nothing is fabricated; dates come straight from the source metadata.
 */

import { ageInDays } from '../utils/dates.js';
import { FRESHNESS_WINDOW_DAYS } from '../utils/credentialManager.js';

/**
 * The exact drop reason for a posting with no parseable date. Exported so the
 * pipeline can recognize it and avoid mislabeling it as "stale" — an unknown
 * date is not an old date, and the two need different follow-up from the user.
 */
export const UNDATED_REASON = 'unknown posting date';

/**
 * @typedef {object} FreshnessSettings
 * @property {string} jobFreshnessMode
 * @property {boolean} includeLast3DaysFallback
 * @property {number} minResultsBeforeFallback
 * @property {boolean} includeUnknownDateJobs
 */

/**
 * @param {object[]} jobs normalized jobs (each may have postedAt)
 * @param {FreshnessSettings} settings runtime freshness settings
 * @param {object} [options]
 * @param {Date} [options.now] reference time (default: now)
 * @param {(job: object) => ({days: number, reason?: string, requireTitleFit?: boolean}|null)} [options.windowFor]
 *   per-job catch-up window (audit D1). It can only WIDEN the configured window:
 *   a source not read completely since N days ago, or an employer the source
 *   has never listed, may admit postings older than the window. A window with
 *   `requireTitleFit` admits only jobs `titleFits` accepts.
 * @param {(job: object) => boolean} [options.titleFits]
 * @returns {{
 *   kept: object[],
 *   review: object[],
 *   dropped: Array<{ job: object, reason: string }>,
 *   mode: string,
 *   windowDays: number,
 *   effectiveWindowDays: number,
 *   fallbackUsed: boolean,
 *   counts: { datedFresh: number, undatedReview: number, stale: number, undatedDropped: number,
 *             caughtUp: number, backfilled: number }
 * }}
 */
export function applyFreshnessFilter(jobs = [], settings = {}, { now = new Date(), windowFor = null, titleFits = null } = {}) {
  const mode = settings.jobFreshnessMode ?? 'LAST_7_DAYS';
  const windowDays = FRESHNESS_WINDOW_DAYS[mode] ?? 7;
  // Undated jobs are opt-in and default OFF. They never join the fresh results.
  const includeUnknown = settings.includeUnknownDateJobs === true;
  const fallbackEnabled = settings.includeLast3DaysFallback !== false;
  const minResults = Number.isFinite(settings.minResultsBeforeFallback)
    ? settings.minResultsBeforeFallback
    : 10;

  // Precompute each job's age once.
  const ages = jobs.map((job) => ({ job, age: ageInDays(job.postedAt, now) }));
  const datedCount = (limit) => ages.filter((x) => x.age !== null && x.age <= limit).length;

  // Decide the effective window: widen to 3 days only when the fallback is on,
  // the primary window is stricter than 3 days, and we're under the threshold.
  let effectiveWindowDays = windowDays;
  let fallbackUsed = false;
  if (
    fallbackEnabled &&
    Number.isFinite(windowDays) &&
    windowDays < 3 &&
    datedCount(windowDays) < minResults
  ) {
    effectiveWindowDays = 3;
    fallbackUsed = true;
  }

  const kept = [];
  const review = [];
  const dropped = [];
  // caughtUp: older than the window, posted since the source's last complete
  // listing. backfilled: older than the window, from an employer the source had
  // never listed before. Both are a subset of datedFresh.
  const counts = { datedFresh: 0, undatedReview: 0, stale: 0, undatedDropped: 0, caughtUp: 0, backfilled: 0 };

  for (const { job, age } of ages) {
    if (age === null) {
      // Undated jobs are NEVER added to `kept`. They go to the review bucket
      // (when opted in) or are dropped — never mixed into fresh results.
      if (includeUnknown) {
        review.push(job);
        counts.undatedReview += 1;
      } else {
        dropped.push({ job, reason: UNDATED_REASON });
        counts.undatedDropped += 1;
      }
      continue;
    }
    if (age <= effectiveWindowDays) {
      kept.push(job);
      counts.datedFresh += 1;
      continue;
    }
    // A lower-bound date ("Posted 30+ Days Ago") says only that the posting is
    // at least that old, so it cannot prove the posting falls inside a wider
    // catch-up or backfill window (audit D7). Its detail read supplies the real
    // date; until then it is judged by the configured window alone.
    const lowerBound = job.rawMetadata?.postedAtLowerBound === true;
    const extra = !lowerBound && typeof windowFor === 'function' ? windowFor(job) : null;
    if (extra && Number.isFinite(extra.days) && age <= extra.days
      && (!extra.requireTitleFit || (typeof titleFits === 'function' && titleFits(job)))) {
      job.rawMetadata = {
        ...(job.rawMetadata ?? {}),
        admittedBy: extra.reason === 'new-source' ? 'new-source-backfill' : 'catch-up',
      };
      kept.push(job);
      counts.datedFresh += 1;
      if (extra.reason === 'new-source') counts.backfilled += 1;
      else counts.caughtUp += 1;
      continue;
    }
    dropped.push({ job, reason: `posted ${age}${lowerBound ? '+' : ''} day(s) ago (> ${effectiveWindowDays}d window)` });
    counts.stale += 1;
  }

  return { kept, review, dropped, mode, windowDays, effectiveWindowDays, fallbackUsed, counts };
}
