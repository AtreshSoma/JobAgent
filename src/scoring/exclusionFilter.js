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
import { detectSponsorshipDenial } from '../utils/sponsorshipLanguage.js';
import { checkSearchConstraints } from './searchConstraints.js';
import { classifyEmployment } from './employmentClassifier.js';

/**
 * @param {object} job normalized job
 * @param {object} exclusions parsed config/exclusions.json
 * @param {object} [options]
 * @param {Date} [options.now] reference time for staleness
 * @param {object} [options.candidate] parsed config/candidate.json. Supplying it
 *   is what lets a candidate who needs no sponsorship keep the jobs that say
 *   sponsorship is unavailable — see `candidateNeedsSponsorship`.
 * @returns {{
 *   excluded: boolean,
 *   category: string|null,
 *   reason: string|null,
 *   matched: string[],
 *   flags: string[]
 * }}
 */
export function applyExclusions(job = {}, exclusions = {}, { now = new Date(), candidate = null } = {}) {
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
  //
  // IT IS ONLY A DENIAL IF THE CANDIDATE NEEDS SOMETHING. "We do not sponsor
  // work visas" is disqualifying for someone who needs sponsorship and simply
  // irrelevant to a citizen or permanent resident — but this rule discarded the
  // posting either way, so a candidate who explicitly stated they need no
  // sponsorship lost every job that mentioned the subject at all. The relaxation
  // requires an EXPLICIT `false`: an unstated requirement keeps the discard,
  // because the failure mode there is applying for a job the employer has
  // already said it cannot hire you for.
  if (candidateNeedsSponsorship(candidate) !== false) {
    const denial = matchedPhrases(text, exclusions.sponsorshipDenial ?? []);
    if (denial.length) return discard('sponsorship_denial', denial);
    const detected = detectSponsorshipDenial(text);
    if (detected.denied) return discard('sponsorship_denial', detected.evidence.slice(0, 2));
  }

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
  //
  // TWO LISTS, ONE TEST. `roleMismatch` is what the USER wrote. The shipped
  // file hardcoded "junior", "entry level", "internship" and "intern" there,
  // which is correct for a senior candidate and catastrophic for a new
  // graduate — every relevant posting hard-discarded before it could be
  // scored. Those level rules now come from `roleMismatchDerived`, written by
  // activating a search profile from its DESIRED seniority, so a graduate's
  // profile produces an empty list. Keeping them separate means switching
  // profiles never edits a phrase the user typed themselves.
  const role = matchedPhrases(roleText, [
    ...(exclusions.roleMismatch ?? []),
    ...(exclusions.roleMismatchDerived ?? []),
  ]);
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

  // 5c. THE CONSTRAINTS THE USER TYPED.
  //
  // Excluded employers, excluded terms, excluded locations, employment type,
  // minimum contract length and minimum salary were all collected by the search
  // profile and enforced by nothing — a user could rule out a staffing agency
  // and still be shown its postings at the top of the board. Every check is
  // positive-evidence-only, so a posting that states none of these is kept and
  // judged on fit. See src/scoring/searchConstraints.js.
  if (candidate) {
    // The employment category is computed LAZILY. Classifying costs a pass over
    // the whole JD, this runs once per posting per discovery run, and most
    // profiles state no employment preference at all — so the common case must
    // not pay for it.
    const constraint = checkSearchConstraints(job, candidate, {
      employmentCategory: () => classifyEmployment(job, exclusions.employmentTypes ?? {}).category,
    });
    if (constraint.violated) return discard(constraint.category, constraint.matched);
  }

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

/**
 * Does this candidate need visa sponsorship?
 *
 * TRI-STATE ON PURPOSE. `true` and `false` are statements the candidate made;
 * `null` means nobody has said, and the difference decides whether a job that
 * refuses sponsorship is disqualifying or irrelevant. Collapsing "not stated"
 * into either answer is a guess about someone's immigration status, so callers
 * test against `false` explicitly rather than for truthiness.
 *
 * @param {object|null} candidate parsed config/candidate.json
 * @returns {boolean|null}
 */
export function candidateNeedsSponsorship(candidate) {
  const value = candidate?.workAuthorization?.requiresSponsorship ?? candidate?.sponsorshipRequired;
  return typeof value === 'boolean' ? value : null;
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

/** Folded-term -> compiled boundary regex. Marker lists are fixed per run. */
const WORD_PATTERNS = new Map();

/**
 * Whole-word (token) match of `term` within already-normalized, ALREADY-FOLDED
 * `text`.
 *
 * PERFORMANCE. This compiled a RegExp and accent-folded BOTH strings on every
 * call, and `checkUsOnly` calls it once per configured marker (~150) per job —
 * so every posting paid ~300 NFD normalizations and ~150 compilations. The
 * location is now folded once per job by the caller, the marker once ever.
 */
function wordMatch(foldedText, term) {
  if (!term || !foldedText) return false;
  let re = WORD_PATTERNS.get(term);
  if (!re) {
    const folded = foldAccents(term);
    re = folded ? new RegExp(`(^|[^a-z0-9])${escapeRegex(folded)}([^a-z0-9]|$)`) : null;
    WORD_PATTERNS.set(term, re);
  }
  return re ? re.test(foldedText) : false;
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
/**
 * Location SENTENCES in a description: "based at our Hyderabad office",
 * "located in Bengaluru", "Location: Manila, Philippines". Deliberately
 * constructions that state where THIS role sits — never a bare mention, because
 * US employers routinely write "offices in India and the Philippines" in their
 * boilerplate (Capital One does, on US-located roles).
 */
const BODY_LOCATION_PATTERNS = [
  /\b(?:based|located|situated)\s+(?:at|in|out\s+of)\s+(?:our\s+|the\s+)?([a-z][a-z .,'-]{1,60}?)(?=\s+(?:office|campus|location|site|hub|center|centre)\b|[.;:()\n]|$)/g,
  /\b(?:work|job|primary|office)?\s*location\s*[:\-–]\s*([a-z][a-z .,'-]{1,60}?)(?=[.;()\n]|$)/g,
];

/**
 * The first description phrase that places the role outside the US, or null.
 *
 * Conservative on purpose — a wrong answer here deletes a real US job:
 *
 *   - only the constructions in BODY_LOCATION_PATTERNS count;
 *   - the captured place must match a configured foreign marker or a leading
 *     ISO country prefix;
 *   - ANY US signal in ANY captured place (a state, "United States", "remote")
 *     cancels the whole verdict, so "based in Hyderabad or Austin, Texas" stays.
 *
 * @param {string} jdText
 * @param {object} geo exclusions.geography
 * @returns {string|null}
 */
export function bodyLocationEvidence(jdText, geo = {}) {
  const text = foldAccents(normalizeText(jdText));
  if (!text) return null;
  const markers = [...(geo?.nonUsLocationMarkers ?? []), ...(geo?.nonUsCountryMarkers ?? [])]
    .map((m) => normalizeText(m)).filter(Boolean);
  let foreign = null;
  for (const pattern of BODY_LOCATION_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const place = m[1].trim();
      if (!place) continue;
      if (/\b(remote|anywhere|united states|usa|u\.s\.)\b/.test(place)) return null;
      const signal = usLocationSignal(place);
      if (signal.isUs && signal.strength !== 'abbreviation') return null;
      if (!foreign && (leadingForeignCountry(place) || markers.some((mk) => wordMatch(place, mk)))) {
        foreign = m[0].trim();
      }
    }
  }
  return foreign;
}

/** Country names/codes that mean the United States when stated explicitly. */



const US_COUNTRY_NAMES = new Set([
  'united states', 'united states of america', 'usa', 'us', 'u s a', 'u s',
]);

/**
 * Would this job survive the US-only gate? True when the gate is off.
 * Shared with the deduplicator so the copy it keeps is one this stage keeps.
 *
 * @param {object} job
 * @param {object|null} geo exclusions.geography
 * @returns {boolean}
 */
export function passesUsOnlyGate(job, geo) {
  if (!geo || geo.usOnly !== true) return true;
  return checkUsOnly(job, geo) === null;
}

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

  // Folded ONCE for every marker test below (see wordMatch).
  const loc = foldAccents(normalizeText(job.location));
  if (!loc) {
    // Unknown location: defer — UNLESS the description itself states, in a
    // location sentence, that the role sits somewhere outside the US. Measured:
    // 3,955 stored Workday rows with a read JD had an empty location and 193 of
    // them name India/Philippines cities; the only two Apply-tier Workday rows
    // were Accenture postings saying "This position is based at our Hyderabad
    // office." See bodyLocationEvidence for how narrow this is.
    const evidence = bodyLocationEvidence(job.jdText, geo);
    if (evidence) return discard('geography_mismatch', [`description places the role outside the US: "${evidence}"`]);
    return null;
  }

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
