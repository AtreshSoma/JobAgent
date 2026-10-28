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
import { usLocationSignal, leadingForeignCountry } from '../utils/usGeography.js';
import { detectSponsorshipDenial, neutralizeEitherWay } from '../utils/sponsorshipLanguage.js';

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
  // Role identity lives in the TITLE, not in the body prose (see checkRoleMismatch).
  const roleText = normalizeText([job.title, job.employmentType].join(' \n '));
  const flags = [];

  // 1. Sponsorship denial — always discards. Two independent detectors:
  // the config phrase list (explicit user control) and the polarity reader,
  // which recognizes the CONSTRUCTION "<negation> … sponsorship" and so catches
  // the long tail no fixed list can enumerate. Measured over 39,503 stored JDs,
  // the reader found 773 real refusals the list missed — including
  // "This role is not eligible for work visa sponsorship", the phrasing that was
  // instead being scored as Confirmed.
  // The config list is polarity-blind, so "with or without sponsorship" would
  // match its "without sponsorship" entry; that idiom is blanked first.
  const denial = matchedPhrases(neutralizeEitherWay(text), exclusions.sponsorshipDenial ?? []);
  if (denial.length) return discard('sponsorship_denial', denial);
  const detected = detectSponsorshipDenial(text);
  if (detected.denied) return discard('sponsorship_denial', detected.evidence.slice(0, 2));

  // 2. Security clearance — discard unless the requirement is soft or negated.
  const clearanceGate = checkClearance(text, exclusions);
  if (clearanceGate) return clearanceGate;

  // 3. Role mismatch.
  //
  // Scoped to the TITLE, because that is where a role's identity is stated.
  // REGRESSION GUARD: matching these phrases against the whole JD body made a
  // senior role disqualify itself for describing its own responsibilities —
  // "serve as a mentor to JUNIOR team members", "guide JUNIOR and mid-level
  // engineers", "new grads with strong INTERNSHIP experience". Measured over the
  // stored corpus, 2,502 of 2,748 role_mismatch discards (91%) matched ONLY in
  // the body, and they were silently deleted: "junior" alone cost 1,983 jobs,
  // including Senior/Lead Data Engineer and Data Platform Engineer postings that
  // are the exact target profile.
  //
  // `roleMismatchBody` keeps the handful of phrases that are genuine BODY
  // statements about scope ("frontend only", "mobile only") scanning the full text.
  const role = matchedPhrases(roleText, exclusions.roleMismatch ?? []);
  if (role.length) return discard('role_mismatch', role);
  const roleBody = matchedPhrases(text, exclusions.roleMismatchBody ?? []);
  if (roleBody.length) return discard('role_mismatch', roleBody);

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

/**
 * Phrases that make a clearance mention NON-disqualifying: the requirement is
 * optional, or it is explicitly waived.
 *
 * REGRESSION GUARD. `securityClearance` was matched as bare presence anywhere in
 * the JD, so a posting saying the clearance is optional was discarded exactly
 * like one demanding it. Measured over the stored corpus, 48 discards sat in
 * such a context — "secret or ts/sci clearance is a NICE TO HAVE for this role",
 * "candidates are NOT REQUIRED to hold an active clearance at the time of
 * application". These are the same polarity blindness that mislabelled
 * sponsorship, and they are checked in the clause AROUND the clearance mention
 * rather than document-wide, so an unrelated "preferred" elsewhere in a long JD
 * cannot wave through a hard clearance requirement.
 */
const CLEARANCE_SOFTENERS = [
  /\bnice\s+to\s+have\b/, /\bpreferred\b/, /\bpreferrable\b/, /\ba\s+plus\b/,
  /\bdesirable\b/, /\bdesired\b/, /\bnot\s+required\b/, /\bnot\s+necessary\b/,
  /\bno\s+clearance\s+(?:is\s+)?required\b/, /\bwithout\s+a\s+clearance\b/,
  /\boptional\b/, /\bbonus\b/, /\bideally\b/, /\bwillingness\s+to\s+obtain\b/,
];

/** Characters that end the clause a clearance softener must live inside. */
const SENTENCE_END = /[.;!?\n\r•·]/;

/**
 * Security-clearance gate. Returns a discard decision, or null when the
 * requirement is absent, config-allowed, or softened.
 */
function checkClearance(text, exclusions) {
  const clearance = matchedPhrases(text, exclusions.securityClearance ?? []);
  if (!clearance.length) return null;

  // Explicit config allowance still wins outright, document-wide.
  if (matchedPhrases(text, exclusions.clearanceAllowance ?? []).length) return null;

  // Otherwise every clearance mention must be softened for the job to survive.
  // One hard mention is enough to discard.
  for (const phrase of clearance) {
    const needle = normalizeText(phrase);
    let from = 0;
    for (;;) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      if (!CLEARANCE_SOFTENERS.some((re) => re.test(sentenceAround(text, idx, needle.length)))) {
        return discard('security_clearance', clearance);
      }
      from = idx + 1;
    }
  }
  return null;
}

/** The sentence containing [index, index+length). */
function sentenceAround(text, index, length) {
  let start = index;
  while (start > 0 && !SENTENCE_END.test(text[start - 1])) start -= 1;
  let end = index + length;
  while (end < text.length && !SENTENCE_END.test(text[end])) end += 1;
  return text.slice(start, end);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fold accents so a marker list written in ASCII still matches the real string.
 *
 * Employer location fields carry native spelling — "São Paulo", "Zürich",
 * "Bogotá", "Malmö". A marker list cannot reasonably be maintained in both
 * forms, and without folding, every accented city silently failed to match and
 * the posting survived a filter that was configured to reject it.
 *
 * @param {string} text
 * @returns {string}
 */
function foldAccents(text) {
  return String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Whole-word (token) match of `term` within already-normalized `text`. */
function wordMatch(text, term) {
  if (!term) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(foldAccents(term))}([^a-z0-9]|$)`)
    .test(foldAccents(text));
}

/**
 * US-only location gate. Returns a discard decision when the job's location
 * clearly names a non-US country/city AND carries no US signal; otherwise null.
 * Unknown/blank locations are never discarded here (kept for scoring).
 *
 * The US signal comes from `utils/usGeography.js`, which knows all 50 states,
 * DC, and the territories by name and USPS code. Before that, the signal was a
 * five-entry marker list, so every US city sharing a name with a foreign one —
 * Dublin OH, Vienna VA, Ontario CA, Athens GA, Cambridge MA and many more —
 * matched the foreign list, matched nothing on the US list, and was discarded
 * before it could be scored. That is 15 of 39 sampled real US locations.
 *
 * @param {object} job normalized job
 * @param {object} [geo] exclusions.geography config
 *   { usOnly, usLocationMarkers, nonUsLocationMarkers, nonUsCountryMarkers }
 */
/** Country names/codes that mean the United States when stated explicitly. */



const US_COUNTRY_NAMES = new Set([
  'united states', 'united states of america', 'usa', 'us', 'u s a', 'u s',
]);

function checkUsOnly(job, geo = {}) {
  if (!geo || geo.usOnly !== true) return null;

  // AN EXPLICIT COUNTRY FIELD IS DECISIVE and is checked before anything else.
  //
  // Some ATS APIs state the country outright (Workday's per-job detail returns
  // `country: "Philippines"`). That is ground truth, and it settles the
  // question that string-matching a location string can only ever guess at —
  // no marker list, however long, can enumerate every city on earth. The case
  // that forced this: a Manulife requisition whose stored location was the
  // literal placeholder "2 Locations", so there was no city to match, no
  // country to match, and the role reached the board despite `usOnly: true`.
  const rawCountry = String(job.rawMetadata?.country ?? job.country ?? '').trim();
  const stated = rawCountry.toLowerCase();
  if (stated) {
    if (US_COUNTRY_NAMES.has(stated)) return null;
    // The field is ISO-3166 alpha-2 and providers honour it. Verified live
    // against SmartRecruiters: a New York posting is `country: "us"` with the
    // state in `region`, while Toronto is `country: "ca"` and Hyderabad is
    // `"in"`. So a two-letter code that happens to look like a USPS state code
    // still means the COUNTRY, and "ca" is Canada.
    //
    // The one guard worth keeping is a genuine contradiction: a location that
    // spells out a US state ("California") or says "United States" outright,
    // against a non-US country code, is bad data rather than a foreign role, so
    // the job is kept for a human to judge. A bare abbreviation is NOT such a
    // signal — reading "CA" out of "Toronto, CA" and calling it California is
    // circular, and doing so let every Canadian posting through.
    const contradiction = usLocationSignal(job.location);
    if (contradiction.isUs && contradiction.strength !== 'abbreviation') return null;
    return discard('geography_mismatch', [`country is ${rawCountry}, not US`]);
  }

  const loc = normalizeText(job.location);
  if (!loc) return null; // unknown location -> defer, do not hard-discard

  // A leading ISO country prefix is checked FIRST and is conclusive, because it
  // is the one case where the state-abbreviation reader is actively wrong
  // rather than merely uncertain: "IN-KA-BANGALORE" registers as Indiana, and
  // the abbreviation branch below would then demand a foreign country NAME to
  // overrule it — which a city like Bangalore never supplies. Every offshore
  // Workday posting in that format therefore passed the gate.
  const prefix = leadingForeignCountry(job.location);
  if (prefix) {
    return discard('geography_mismatch', [`location not in US: ${job.location} (${prefix.country})`]);
  }

  const signal = usLocationSignal(job.location);
  // A spelled-out state or a national marker is conclusive.
  if (signal.isUs && signal.strength !== 'abbreviation') return null;

  // Any extra marker the user configured also wins outright.
  const usMarkers = geo.usLocationMarkers ?? [];
  if (usMarkers.some((m) => wordMatch(loc, normalizeText(m)))) return null;

  const foreign = (geo.nonUsLocationMarkers ?? [])
    .filter((m) => wordMatch(loc, normalizeText(m)));
  if (!foreign.length) return null;

  // A bare two-letter code is the one ambiguous case ("Berlin, DE" is Germany,
  // not Delaware), so an explicitly named foreign COUNTRY outranks it. Against
  // a foreign CITY, the state code still wins: "Ontario, CA" is California.
  if (signal.strength === 'abbreviation') {
    const countries = (geo.nonUsCountryMarkers ?? [])
      .filter((m) => wordMatch(loc, normalizeText(m)));
    if (!countries.length) return null;
    return discard('geography_mismatch', [`location not in US: ${job.location}`]);
  }
  return discard('geography_mismatch', [`location not in US: ${job.location}`]);
}
