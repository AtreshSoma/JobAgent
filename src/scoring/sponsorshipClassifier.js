/**
 * Sponsorship classifier (Section 2).
 *
 * Classifies a job's sponsorship outlook using ONLY config-provided inputs
 * (scoring.sponsorship.affirmativePhrases / likelySponsors) plus the explicit
 * `willingToSponsor` flag a connector may set.
 *
 *   - Confirmed:   willingToSponsor === true OR JD has an affirmative phrase
 *   - Likely:      company matches a configured likely-sponsor name
 *   - Unconfirmed: no signal either way
 *
 * A hard "No" is handled by exclusionFilter (sponsorship_denial), which discards
 * before scoring — so this classifier never needs to emit "No".
 */

import { normalizeText, matchedPhrases } from '../utils/textNormalize.js';

/**
 * @param {object} job normalized job (jdText, company, willingToSponsor?)
 * @param {object} [sponsorshipConfig] scoring.sponsorship
 * @param {string[]} [sponsorshipConfig.affirmativePhrases]
 * @param {string[]} [sponsorshipConfig.likelySponsors]
 * @returns {{ status: 'Confirmed'|'Likely'|'Unconfirmed', signals: string[] }}
 */
export function classifySponsorship(job = {}, sponsorshipConfig = {}) {
  const affirmative = sponsorshipConfig.affirmativePhrases ?? [];
  const likely = sponsorshipConfig.likelySponsors ?? [];

  const jd = normalizeText(job.jdText);
  const company = normalizeText(job.company);

  if (job.willingToSponsor === true) {
    return { status: 'Confirmed', signals: ['willingToSponsor flag'] };
  }

  const affirmativeHits = matchedPhrases(jd, affirmative);
  if (affirmativeHits.length) {
    return { status: 'Confirmed', signals: affirmativeHits };
  }

  const likelyHits = likely.filter((name) => company.includes(normalizeText(name)));
  if (likelyHits.length) {
    return { status: 'Likely', signals: likelyHits };
  }

  return { status: 'Unconfirmed', signals: [] };
}
