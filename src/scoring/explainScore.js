/**
 * Tier assignment + human-readable explanation for a score result.
 *
 * Tier thresholds come from config (scoring.tiers). The sponsorship gate is
 * enforced here: a job may NOT be marked Apply or Priority unless its
 * sponsorship status is in scoring.sponsorshipGate.allowApplyWhen. When the raw
 * score would qualify for Apply/Priority but sponsorship is not allowed, the job
 * is downgraded to "Queue for review" (never silently applied).
 */

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
 * @returns {{ tier: string, sponsorshipGated: boolean, explanation: string }}
 */
export function explainScore(scoreResult, scoring, { userApproved = false } = {}) {
  const { total, sponsorship } = scoreResult;
  const tiers = scoring.tiers;
  const allow = new Set(scoring.sponsorshipGate?.allowApplyWhen ?? ['Confirmed', 'Likely', 'Approved']);
  const sponsorshipOk = userApproved || allow.has(sponsorship);

  let tier = rawTier(total, tiers);
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

/** Raw tier purely from score thresholds. */
export function rawTier(total, tiers) {
  if (total >= tiers.priority) return TIERS.PRIORITY;
  if (total >= tiers.apply) return TIERS.APPLY;
  if (total >= tiers.queue) return TIERS.QUEUE;
  if (total >= tiers.nearMiss) return TIERS.NEAR_MISS;
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
