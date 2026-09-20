/**
 * "Was this score produced by the configuration that is loaded right now?"
 *
 * WHY THIS EXISTS. Discovery is incremental: a job whose record has not
 * materially changed and already carries a score is skipped rather than scored
 * again. `materiallyUnchanged` compares the POSTING — company, title, location,
 * URL, description, date, employment type — and nothing else, so it answered
 * "nothing changed" even when everything about the person doing the searching
 * had. Measured: switching a test candidate from engineering to nursing left a
 * previously scored engineering job showing 94/100, with zero jobs rescored.
 * The board presented one candidate's verdicts as the current candidate's.
 *
 * A score is a function of the job AND the configuration that judged it, so
 * "unchanged" has to mean both. This module reduces the judging half to one
 * short string that is stored beside the score, and the incremental skip
 * requires it to match.
 *
 * WHAT GOES IN. Only inputs that can change a score or a tier. Including more
 * would rescore the corpus over edits that cannot alter a verdict — expensive
 * and, in a 100k-row database, noticeable. Including less would leave a stale
 * verdict on the board, which is the bug.
 */

import { createHash } from 'node:crypto';

/** Sort object keys recursively so key ORDER can never change a fingerprint. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  return value ?? null;
}

/**
 * A short, stable fingerprint of everything that decides a job's score + tier.
 *
 * @param {object} config loadConfig() bundle
 * @returns {string} 16 hex characters
 */
export function scoringFingerprint(config = {}) {
  const candidate = config.candidate ?? {};
  const scoring = config.scoring ?? {};
  const exclusions = config.exclusions ?? {};

  const material = {
    // WHO is being scored. The active profile id alone would not do it: a
    // profile can be edited in place, and candidate.json can also be written
    // directly, so the inputs themselves are fingerprinted.
    profileId: config.profile?.id ?? null,
    targetTitles: candidate.targetTitles ?? [],
    technicalStack: candidate.technicalStack ?? {},
    seniority: candidate.seniority ?? null,
    domainExperience: candidate.domainExperience ?? [],
    locationPreferences: candidate.locationPreferences ?? {},
    certifications: candidate.certifications ?? [],
    // Tri-state, and it now changes both the sponsorship categories and the
    // tier gate — so it must change the fingerprint.
    requiresSponsorship: candidate.workAuthorization?.requiresSponsorship
      ?? candidate.sponsorshipRequired ?? null,
    salaryPreference: candidate.salaryPreference ?? {},
    employmentPreferences: candidate.employmentPreferences ?? {},
    prohibited: candidate.prohibited ?? {},

    // HOW it is judged.
    weights: scoring.weights ?? {},
    categories: scoring.categories ?? null,
    keywords: scoring.keywords ?? {},
    marketSkills: scoring.marketSkills ?? [],
    tiers: scoring.tiers ?? {},
    sponsorshipGate: scoring.sponsorshipGate ?? {},
    freshness: scoring.freshness ?? {},
    evidenceAliases: scoring.evidenceAliases ?? {},

    // WHAT IS THROWN AWAY BEFORE JUDGING. An exclusion change does not alter a
    // score, but it does alter whether the row should be on the board at all.
    exclusions: {
      sponsorshipDenial: exclusions.sponsorshipDenial ?? [],
      securityClearance: exclusions.securityClearance ?? [],
      clearanceAllowance: exclusions.clearanceAllowance ?? [],
      roleMismatch: exclusions.roleMismatch ?? [],
      roleMismatchDerived: exclusions.roleMismatchDerived ?? [],
      roleMismatchBody: exclusions.roleMismatchBody ?? [],
      employmentMismatch: exclusions.employmentMismatch ?? [],
      geographyMismatch: exclusions.geographyMismatch ?? [],
      geography: exclusions.geography ?? {},
      staleness: exclusions.staleness ?? {},
    },
  };

  return createHash('sha1')
    .update(JSON.stringify(stable(material)))
    .digest('hex')
    .slice(0, 16);
}
