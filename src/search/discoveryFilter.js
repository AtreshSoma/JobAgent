/**
 * Discovery-level relevance classifier (permissive).
 *
 * Looks at a normalized job and the candidate profile and labels how well the
 * job matches the candidate's target roles / stack / location. It is DELIBERATELY
 * permissive and NON-DESTRUCTIVE:
 *
 *   - It NEVER discards a job. Hard discards are the job of exclusionFilter.
 *   - It returns one of three match levels so borderline jobs survive:
 *       'strong'   — title clearly matches AND multiple stack signals present
 *       'weak'     — some signal (title OR a stack hit) — kept for scoring
 *       'no_match' — no title/stack signal at all — kept but flagged for audit
 *
 * Inputs come only from config/candidate.json (+ optional scoring keywords).
 * Pure and deterministic: same job + config always yields the same result.
 */

import { normalizeText, matchedPhrases } from '../utils/textNormalize.js';

/** @typedef {{ match: 'strong'|'weak'|'no_match', signals: string[], reasons: string[] }} DiscoveryResult */

/** Flatten candidate.technicalStack into a flat list of stack terms. */
export function candidateStackTerms(candidate = {}) {
  const stack = candidate.technicalStack ?? {};
  return Object.values(stack)
    .flat()
    .filter((t) => typeof t === 'string' && t.trim().length > 0);
}

/** Seniority keywords used to detect a level signal in the JD/title. */
const SENIORITY_TERMS = {
  junior: ['junior', 'jr', 'entry level', 'entry-level', 'associate'],
  mid: ['mid level', 'mid-level', 'intermediate'],
  senior: ['senior', 'sr', 'sr.'],
  lead: ['lead', 'principal', 'staff', 'manager'],
};

/**
 * Classify how well a job matches the candidate's discovery targets.
 *
 * @param {object} job normalized job
 * @param {object} args
 * @param {object} args.candidate parsed config/candidate.json
 * @param {object} [args.scoring] parsed config/scoring.json (optional keyword boost)
 * @returns {DiscoveryResult}
 */
export function classifyDiscovery(job = {}, { candidate = {}, scoring = {} } = {}) {
  const signals = [];
  const reasons = [];

  const titleText = normalizeText(job.title);
  const bodyText = normalizeText([job.title, job.jdText].join(' \n '));

  // 1. Title relevance against configured target titles (+ generic role tokens).
  const targetTitles = Array.isArray(candidate.targetTitles) ? candidate.targetTitles : [];
  const titleHits = targetTitles.filter((t) => {
    const n = normalizeText(t);
    return n.length > 0 && titleText.includes(n);
  });
  // Generic role token fallback so "Staff Data Engineer" still reads as a title hit
  // even if it is not literally in targetTitles.
  const roleTokenHit = /\bdata engineer(ing)?\b|\banalytics engineer\b|\bplatform engineer\b/.test(titleText);
  const hasTitleSignal = titleHits.length > 0 || roleTokenHit;
  if (titleHits.length) {
    signals.push(`title:${titleHits.join('|')}`);
  } else if (roleTokenHit) {
    signals.push('title:role-token');
  } else {
    reasons.push('no target-title match');
  }

  // 2. Technical-stack signals from the candidate profile.
  const stackTerms = candidateStackTerms(candidate);
  const stackHits = matchedPhrases(bodyText, stackTerms);
  if (stackHits.length) {
    signals.push(`stack:${stackHits.slice(0, 8).join('|')}`);
  } else {
    reasons.push('no technical-stack signal');
  }

  // 3. Optional scoring-keyword reinforcement (does not change tier on its own).
  const scoringKw = collectScoringKeywords(scoring);
  const kwHits = matchedPhrases(bodyText, scoringKw);
  if (kwHits.length) signals.push(`keywords:${kwHits.slice(0, 6).join('|')}`);

  // 4. Seniority signal (informational; never downgrades).
  const wantSeniority = normalizeText(candidate.seniority);
  if (wantSeniority) {
    const terms = SENIORITY_TERMS[wantSeniority] ?? [wantSeniority];
    const senHit = terms.some((t) => bodyText.includes(normalizeText(t)));
    if (senHit) signals.push(`seniority:${wantSeniority}`);
  }

  // 5. Location note (informational only — exclusionFilter enforces hard geo rules).
  const prefs = candidate.locationPreferences ?? {};
  const loc = normalizeText(job.location);
  if (loc) {
    const excluded = (prefs.excludedLocations ?? []).some((x) => loc.includes(normalizeText(x)));
    if (excluded) reasons.push('location in candidate excludedLocations (deferred to exclusions)');
    else if (/remote/.test(loc) && prefs.remote) signals.push('location:remote');
  }

  // Permissive classification.
  let match;
  if (hasTitleSignal && stackHits.length >= 2) {
    match = 'strong';
  } else if (hasTitleSignal || stackHits.length >= 1) {
    match = 'weak';
  } else {
    match = 'no_match';
  }

  return { match, signals, reasons };
}

/** Gather a deduped keyword list from scoring.keywords.* arrays. */
function collectScoringKeywords(scoring = {}) {
  const kw = scoring.keywords ?? {};
  const all = [];
  for (const value of Object.values(kw)) {
    if (Array.isArray(value)) all.push(...value.filter((v) => typeof v === 'string'));
  }
  return [...new Set(all)];
}
