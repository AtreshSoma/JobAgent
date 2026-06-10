/**
 * Job lifecycle status vocabulary.
 *
 * Every discovered job moves through a well-defined set of states. These labels
 * are written into the output artifacts (found/scored/queued_jobs.json) and the
 * jobs table so a human can see exactly what happened to each job and where it
 * currently sits in the pipeline.
 *
 * Flow (happy path):
 *   found -> scored -> queued -> prepared -> assist_started -> ready_for_submit
 *         -> submitted
 *
 * Off-ramps:
 *   found -> hard_discarded          (exclusion rule matched)
 *   found -> unknown_date_review     (no posting date; held for human review)
 *   scored -> near_miss              (scored below the queue threshold)
 *   assist_started -> assist_blocked (captcha/login/mfa/unknown question/etc.)
 *   any -> failed                    (unexpected error)
 */

export const LIFECYCLE = Object.freeze({
  FOUND: 'found',
  HARD_DISCARDED: 'hard_discarded',
  UNKNOWN_DATE_REVIEW: 'unknown_date_review',
  SCORED: 'scored',
  NEAR_MISS: 'near_miss',
  QUEUED: 'queued',
  PREPARED: 'prepared',
  ASSIST_STARTED: 'assist_started',
  ASSIST_BLOCKED: 'assist_blocked',
  READY_FOR_SUBMIT: 'ready_for_submit',
  SUBMITTED: 'submitted',
  SKIPPED: 'skipped',
  FAILED: 'failed',
});

/** All known lifecycle values (handy for validation/tests). */
export const LIFECYCLE_VALUES = Object.freeze(Object.values(LIFECYCLE));

import { TIERS } from './scoring/explainScore.js';

/**
 * Tiers that are "queued" — strong enough to warrant action (packet build /
 * assisted apply). Near miss is intentionally excluded unless config opts in.
 */
export const QUEUED_TIERS = Object.freeze([TIERS.PRIORITY, TIERS.APPLY, TIERS.QUEUE]);

/**
 * Is this tier strong enough to be queued for action?
 * @param {string} tier explainScore tier
 * @param {object} [scoring] config/scoring.json (reads scoring.queue.includeNearMiss)
 * @returns {boolean}
 */
export function isQueuedTier(tier, scoring = {}) {
  if (QUEUED_TIERS.includes(tier)) return true;
  if (tier === TIERS.NEAR_MISS && scoring?.queue?.includeNearMiss === true) return true;
  return false;
}

/**
 * Derive the lifecycle status for a scored (non-excluded) job from its tier.
 * @param {string} tier
 * @param {object} [scoring]
 * @returns {string} a LIFECYCLE value
 */
export function lifecycleForTier(tier, scoring = {}) {
  if (tier === TIERS.DISCARD) return LIFECYCLE.SCORED; // scored but below near-miss
  if (isQueuedTier(tier, scoring)) return LIFECYCLE.QUEUED;
  if (tier === TIERS.NEAR_MISS) return LIFECYCLE.NEAR_MISS;
  return LIFECYCLE.SCORED;
}
