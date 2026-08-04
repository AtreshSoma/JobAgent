/**
 * Sponsorship classifier (Section 2).
 *
 * Classifies a job's sponsorship outlook using ONLY config-provided inputs
 * (scoring.sponsorship.affirmativePhrases / likelySponsors) plus the explicit
 * `willingToSponsor` flag a connector may set.
 *
 *   - Denied:      the JD explicitly refuses sponsorship
 *   - Confirmed:   willingToSponsor === true OR JD has an UN-NEGATED affirmative
 *   - Likely:      company matches a configured likely-sponsor name
 *   - Unconfirmed: no signal either way
 *
 * REGRESSION GUARD. Affirmative matching used to be plain phrase presence, which
 * is polarity-blind: the configured phrase "work visa sponsorship" matched
 * inside "This role is not eligible for work visa sponsorship", so the strongest
 * possible DENIAL was reported as "Confirmed" — green badge, +15 weighted score
 * points, and a pass through the sponsorship gate into auto-preparation. All 6
 * Humana rows labelled Confirmed were explicit refusals. Polarity now comes from
 * utils/sponsorshipLanguage.js, shared with the exclusion filter so the two can
 * never disagree about whether a posting sponsors.
 *
 * `Denied` exists as a status even though exclusionFilter normally discards such
 * jobs first: this classifier is also reachable for manually added URLs and for
 * configurations that soften the hard filters, and it must never call a refusal
 * "Unconfirmed" (which reads as "unknown, go verify") in those paths.
 */

import { normalizeText } from '../utils/textNormalize.js';
import {
  affirmativeSponsorshipHits,
  detectSponsorshipDenial,
} from '../utils/sponsorshipLanguage.js';

/** Canonical sponsorship statuses. */
export const SPONSORSHIP = Object.freeze({
  CONFIRMED: 'Confirmed',
  LIKELY: 'Likely',
  UNCONFIRMED: 'Unconfirmed',
  DENIED: 'Denied',
});

/**
 * @param {object} job normalized job (jdText, company, willingToSponsor?)
 * @param {object} [sponsorshipConfig] scoring.sponsorship
 * @param {string[]} [sponsorshipConfig.affirmativePhrases]
 * @param {string[]} [sponsorshipConfig.likelySponsors]
 * @returns {{ status: 'Confirmed'|'Likely'|'Unconfirmed'|'Denied', signals: string[] }}
 */
export function classifySponsorship(job = {}, sponsorshipConfig = {}) {
  const affirmative = sponsorshipConfig.affirmativePhrases ?? [];
  const likely = sponsorshipConfig.likelySponsors ?? [];

  const company = normalizeText(job.company);

  // An explicit refusal in the JD outranks everything, including a connector's
  // willingToSponsor flag: the posting itself is the more specific evidence.
  const denial = detectSponsorshipDenial(job.jdText);
  if (denial.denied) {
    return { status: SPONSORSHIP.DENIED, signals: denial.evidence.slice(0, 3) };
  }

  if (job.willingToSponsor === true) {
    return { status: SPONSORSHIP.CONFIRMED, signals: ['willingToSponsor flag'] };
  }

  const { affirmed, suppressed } = affirmativeSponsorshipHits(job.jdText, affirmative);
  if (affirmed.length) {
    return { status: SPONSORSHIP.CONFIRMED, signals: affirmed };
  }

  const likelyHits = likely.filter((name) => company.includes(normalizeText(name)));
  if (likelyHits.length) {
    return { status: SPONSORSHIP.LIKELY, signals: likelyHits };
  }

  // The JD talks about sponsorship but every mention was negated, and no strict
  // denial construction matched. Say so rather than reporting a bare
  // "Unconfirmed", so a human checking the row knows to read the JD.
  if (suppressed.length) {
    return {
      status: SPONSORSHIP.UNCONFIRMED,
      signals: [`mentions ${suppressed.join(', ')} only in a negated context`],
    };
  }

  return { status: SPONSORSHIP.UNCONFIRMED, signals: [] };
}
