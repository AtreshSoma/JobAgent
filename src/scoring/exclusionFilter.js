/**
 * Hard exclusion filter (Section: NON-NEGOTIABLE FILTERS).
 *
 * Returns a discard decision for any job that matches a hard exclusion rule.
 * Rules are entirely config-driven (config/exclusions.json) — no phrases are
 * hardcoded here. A sponsorship-denial match ALWAYS discards.
 *
 * Categories, in priority order:
 *   1. sponsorship_denial
 *   2. security_clearance (unless a clearanceAllowance phrase is present)
 *   3. role_mismatch
 *   4. employment_mismatch
 *   5. geography_mismatch
 *   6. stale_posting
 */

import { normalizeText, matchedPhrases } from '../utils/textNormalize.js';
import { ageInDays } from '../utils/dates.js';

/**
 * @param {object} job normalized job
 * @param {object} exclusions parsed config/exclusions.json
 * @param {object} [options]
 * @param {Date} [options.now] reference time for staleness
 * @returns {{
 *   excluded: boolean,
 *   category: string|null,
 *   reason: string|null,
 *   matched: string[],
 *   flags: string[]
 * }}
 */
export function applyExclusions(job = {}, exclusions = {}, { now = new Date() } = {}) {
  const text = normalizeText([job.title, job.jdText, job.employmentType, job.location].join(' \n '));
  const flags = [];

  // 1. Sponsorship denial — always discards.
  const denial = matchedPhrases(text, exclusions.sponsorshipDenial ?? []);
  if (denial.length) return discard('sponsorship_denial', denial);

  // 2. Security clearance — discard unless an allowance phrase is present.
  const clearance = matchedPhrases(text, exclusions.securityClearance ?? []);
  if (clearance.length) {
    const allowed = matchedPhrases(text, exclusions.clearanceAllowance ?? []);
    if (allowed.length === 0) return discard('security_clearance', clearance);
  }

  // 3. Role mismatch.
  const role = matchedPhrases(text, exclusions.roleMismatch ?? []);
  if (role.length) return discard('role_mismatch', role);

  // 4. Employment mismatch.
  const employment = matchedPhrases(text, exclusions.employmentMismatch ?? []);
  if (employment.length) return discard('employment_mismatch', employment);

  // 5. Geography mismatch.
  const geography = matchedPhrases(text, exclusions.geographyMismatch ?? []);
  if (geography.length) return discard('geography_mismatch', geography);

  // 5b. US-only location gate (precise: inspects the location field only, with
  // word-boundary matching so US places like "New Mexico" / "Indianapolis" are
  // never mistaken for "Mexico" / "India"). Opt-in via exclusions.geography.usOnly.
  const usGate = checkUsOnly(job, exclusions.geography);
  if (usGate) return usGate;

  // 6. Staleness.
  const stale = exclusions.staleness ?? {};
  const age = ageInDays(job.postedAt, now);
  if (age !== null) {
    if (Number.isFinite(stale.skipOlderThanDays) && age > stale.skipOlderThanDays) {
      return discard('stale_posting', [`posted ${age} days ago`]);
    }
    const applicants = job.applicantCount ?? 0;
    if (
      Number.isFinite(stale.flagOlderThanDays) &&
      Number.isFinite(stale.highApplicantThreshold) &&
      age > stale.flagOlderThanDays &&
      applicants > stale.highApplicantThreshold
    ) {
      flags.push('low_priority_high_applicants');
    }
  }

  return { excluded: false, category: null, reason: null, matched: [], flags };
}

function discard(category, matched) {
  return {
    excluded: true,
    category,
    reason: `${category}: ${matched.join('; ')}`,
    matched,
    flags: [],
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word (token) match of `term` within already-normalized `text`. */
function wordMatch(text, term) {
  if (!term) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`).test(text);
}

/**
 * US-only location gate. Returns a discard decision when the job's location
 * clearly names a non-US country/city AND carries no US signal; otherwise null.
 * Unknown/blank locations are never discarded here (kept for scoring).
 *
 * @param {object} job normalized job
 * @param {object} [geo] exclusions.geography config
 *   { usOnly: boolean, usLocationMarkers: string[], nonUsLocationMarkers: string[] }
 */
function checkUsOnly(job, geo = {}) {
  if (!geo || geo.usOnly !== true) return null;
  const loc = normalizeText(job.location);
  if (!loc) return null; // unknown location -> defer, do not hard-discard

  // An explicit US signal always wins (protects "New Mexico", "Washington", etc.).
  const usMarkers = geo.usLocationMarkers ?? [];
  if (usMarkers.some((m) => wordMatch(loc, normalizeText(m)))) return null;

  const foreign = (geo.nonUsLocationMarkers ?? [])
    .filter((m) => wordMatch(loc, normalizeText(m)));
  if (foreign.length) {
    return discard('geography_mismatch', [`location not in US: ${job.location}`]);
  }
  return null;
}
