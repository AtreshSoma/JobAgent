/**
 * Tier assignment + human-readable explanation for a score result.
 *
 * Tier thresholds come from config (scoring.tiers). The sponsorship gate is
 * enforced here: a job may NOT be marked Apply or Priority unless its
 * sponsorship status is in scoring.sponsorshipGate.allowApplyWhen. When the raw
 * score would qualify for Apply/Priority but sponsorship is not allowed, the job
 * is downgraded to "Queue for review" (never silently applied).
 */

import { candidateNeedsSponsorship } from './exclusionFilter.js';

/** Canonical tier labels. */
export const TIERS = Object.freeze({
  PRIORITY: 'Priority',
  APPLY: 'Apply',
  QUEUE: 'Queue',
  NEAR_MISS: 'Near miss',
  DISCARD: 'Discard',
});

/**
 * @param {object} scoreResult output of scoreJob
 * @param {object} scoring parsed config/scoring.json
 * @param {object} [options]
 * @param {boolean} [options.userApproved=false] explicit per-job user approval
 * @param {object} [options.candidate] parsed config/candidate.json — supplying it
 *   is what stops the gate holding back a candidate who needs no sponsorship
 * @returns {{ tier: string, sponsorshipGated: boolean, explanation: string }}
 */
export function explainScore(scoreResult, scoring, {
  userApproved = false, titleVerdict = null, candidate = null,
} = {}) {
  const { total, sponsorship } = scoreResult;
  const tiers = scoring.tiers;
  const allow = new Set(scoring.sponsorshipGate?.allowApplyWhen ?? ['Confirmed', 'Likely', 'Approved']);
  // THE GATE ASKS A QUESTION ONLY SOME CANDIDATES HAVE.
  //
  // It exists so nobody auto-applies to an employer who may be unable to hire
  // them — a real risk when you need sponsorship, and no risk at all when you
  // do not. Applied unconditionally it held every strong match for a citizen or
  // permanent resident in "Queue for review" purely because the posting never
  // mentioned visas, which is most postings. An EXPLICIT `false` clears it;
  // unstated keeps the gate, because the gate is the cautious answer.
  const needsSponsorship = candidateNeedsSponsorship(candidate);
  const sponsorshipOk = userApproved || needsSponsorship === false || allow.has(sponsorship);

  let tier = rawTier(total, tiers, titleVerdict);
  let sponsorshipGated = false;

  if ((tier === TIERS.PRIORITY || tier === TIERS.APPLY) && !sponsorshipOk) {
    tier = TIERS.QUEUE;
    sponsorshipGated = true;
  }

  return {
    tier,
    sponsorshipGated,
    explanation: buildExplanation(scoreResult, tier, { sponsorshipGated, sponsorshipOk }),
  };
}

/**
 * Score at or above which a Queue-tier row must have been downgraded by the
 * sponsorship gate. Mirrors config/scoring.json `tiers.apply`.
 *
 * Consumers that only see a DB row (the dashboard data layer, the auto-apply
 * precheck) cannot re-run explainScore, so they derive "was this gated?" from
 * tier + score. That derivation needs the real threshold: hardcoding 75 meant
 * editing tiers.apply silently misclassified every gated row.
 */
export const DEFAULT_APPLY_THRESHOLD = 75;
let applyThreshold = DEFAULT_APPLY_THRESHOLD;

/**
 * Point the gate derivation at the live config threshold. Called once at
 * startup with a loaded config; safe to call repeatedly.
 * @param {number} threshold config.scoring.tiers.apply
 * @returns {number} the threshold now in effect
 */
export function configureGateThreshold(threshold) {
  const n = Number(threshold);
  if (Number.isFinite(n) && n > 0 && n <= 100) applyThreshold = n;
  return applyThreshold;
}

/** The gate threshold currently in effect (diagnostics/tests). */
export function gateThreshold() {
  return applyThreshold;
}

/**
 * Was this job's tier downgraded to Queue by the sponsorship gate?
 *
 * The ONLY path to an Apply-scoring row sitting in Queue is the gate above
 * (raw Apply/Priority, sponsorship not Confirmed/Likely/Approved), so the flag
 * is recoverable for every historical row without a schema migration.
 *
 * A row whose sponsorship is `Denied` is NOT "gated": the gate means "we do not
 * know yet — go verify", and this drives a "verify sponsorship" call to action.
 * An employer that has already refused in writing leaves nothing to verify, so
 * such a row must never be counted as a strong fit awaiting a check.
 *
 * @param {{tier?: string|null, score?: number|null, sponsorship?: string|null}} job
 *   jobs-table row or board row
 * @returns {boolean}
 */
export function isSponsorshipGated(job = {}) {
  return job.tier === TIERS.QUEUE
    && job.sponsorship !== 'Denied'
    && typeof job.score === 'number'
    && job.score >= applyThreshold;
}

/**
 * Raw tier purely from score thresholds.
 *
 * `titleVerdict` raises the bar for a posting that reached scoring only because
 * its TITLE was unrecognized rather than recognized (see
 * `src/scoring/profileFit.js`). Discovery no longer rejects an unfamiliar
 * title — that recovered 147 genuinely strong roles the old gate threw away —
 * but keeping every such posting at the same near-miss bar put ~830 extra rows
 * on the board, most of them 50-59 speculative matches. Requiring a deferred
 * title to clear the QUEUE threshold instead keeps the full recall gain on
 * strong roles (99.9% of everything scoring 60+) while roughly halving the
 * extra board volume: content evidence has to be stronger when the title
 * offered none.
 *
 * @param {number} total
 * @param {object} tiers config/scoring.json tiers
 * @param {'accept'|'defer'|'reject'|null} [titleVerdict]
 */
export function rawTier(total, tiers, titleVerdict = null) {
  if (total >= tiers.priority) return TIERS.PRIORITY;
  if (total >= tiers.apply) return TIERS.APPLY;
  if (total >= tiers.queue) return TIERS.QUEUE;
  // Only the near-miss band is gated on title evidence. Anything at or above
  // the queue threshold has already proven itself on content alone.
  if (total >= tiers.nearMiss && titleVerdict !== 'defer') return TIERS.NEAR_MISS;
  return TIERS.DISCARD;
}

function buildExplanation(scoreResult, tier, { sponsorshipGated }) {
  const { total, breakdown, matchedKeywords, missingKeywords, sponsorship } = scoreResult;
  const top = Object.entries(breakdown)
    .map(([name, b]) => ({ name, points: b.points, weight: b.weight }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 4)
    .map((c) => `${c.name} ${c.points}/${c.weight}`)
    .join(', ');

  const parts = [
    `Score ${total}/100 -> ${tier}.`,
    `Sponsorship: ${sponsorship}.`,
    `Top contributors: ${top}.`,
  ];
  if (matchedKeywords?.length) {
    parts.push(`Matched: ${matchedKeywords.slice(0, 10).join(', ')}.`);
  }
  if (missingKeywords?.length) {
    parts.push(`Gaps vs profile: ${missingKeywords.slice(0, 8).join(', ')}.`);
  }
  if (sponsorshipGated) {
    parts.push('Downgraded to Queue: score qualified for Apply/Priority but sponsorship is not Confirmed/Likely/Approved.');
  }
  return parts.join(' ');
}
