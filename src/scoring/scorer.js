/**
 * Deterministic, explainable, configurable scoring engine.
 *
 * Produces a normalized 0-100 score from weighted categories defined entirely
 * in config/scoring.json. The same inputs always yield the same output.
 *
 * Categories (each capped at its configured weight):
 *   titleFit, seniorityFit, azureFabricStack, dataEngineeringStack,
 *   biSemanticDepth, pythonSqlPyspark, domainFit, sponsorshipFeasibility,
 *   geographyFit, freshness, directAtsAvailability,
 *   companySponsorshipLikelihood, resumeKeywordAlignment
 */

import { normalizeText, matchedPhrases } from '../utils/textNormalize.js';
import { ageInDays } from '../utils/dates.js';

/** Sources considered "direct ATS" for the directAtsAvailability category. */
const DIRECT_ATS_SOURCES = new Set(['greenhouse', 'lever', 'manual']);

/** Seniority ranking for seniorityFit. */
const SENIORITY_RANK = { junior: 1, mid: 2, senior: 3, lead: 4, staff: 4, principal: 5, manager: 4 };

/**
 * Score a single job.
 *
 * @param {object} job normalized job
 * @param {object} args
 * @param {object} args.scoring parsed config/scoring.json
 * @param {{status: string}} args.sponsorship classifier result
 * @param {object} [args.candidate] parsed config/candidate.json (for alignment + geo + seniority)
 * @param {string[]} [args.resumeKeywords] keywords present in the master resume (optional)
 * @param {Date} [args.now]
 * @returns {object} score result with breakdown, matched/missing keywords
 */
export function scoreJob(job = {}, { scoring, sponsorship, candidate = {}, resumeKeywords, now = new Date() } = {}) {
  const weights = scoring.weights;
  const kw = scoring.keywords;
  const text = normalizeText([job.title, job.jdText].join(' \n '));
  const titleText = normalizeText(job.title);

  const breakdown = {};
  const matchedAll = new Set();

  // Keyword-coverage categories.
  breakdown.titleFit = keywordCategory(titleText, kw.titles, weights.titleFit, 1, matchedAll);
  breakdown.azureFabricStack = keywordCategory(text, kw.azureFabric, weights.azureFabricStack, 3, matchedAll);
  breakdown.dataEngineeringStack = keywordCategory(text, kw.dataEngineering, weights.dataEngineeringStack, 3, matchedAll);
  breakdown.biSemanticDepth = keywordCategory(text, kw.biSemantic, weights.biSemanticDepth, 2, matchedAll);
  breakdown.pythonSqlPyspark = keywordCategory(text, kw.languages, weights.pythonSqlPyspark, 2, matchedAll);
  breakdown.domainFit = keywordCategory(text, kw.domains, weights.domainFit, 1, matchedAll);

  // Seniority fit.
  breakdown.seniorityFit = scoreSeniority(text, candidate.seniority, weights.seniorityFit);

  // Sponsorship feasibility.
  breakdown.sponsorshipFeasibility = scoreSponsorship(sponsorship?.status, weights.sponsorshipFeasibility);
  breakdown.companySponsorshipLikelihood = scoreCompanyLikelihood(sponsorship?.status, weights.companySponsorshipLikelihood);

  // Geography fit.
  breakdown.geographyFit = scoreGeography(job, candidate, weights.geographyFit);

  // Freshness.
  breakdown.freshness = scoreFreshness(job, scoring.freshness ?? {}, weights.freshness, now);

  // Direct ATS availability.
  breakdown.directAtsAvailability = {
    points: DIRECT_ATS_SOURCES.has(job.source) ? weights.directAtsAvailability : 0,
    weight: weights.directAtsAvailability,
    matched: DIRECT_ATS_SOURCES.has(job.source) ? [job.source] : [],
  };

  // Resume keyword alignment.
  breakdown.resumeKeywordAlignment = scoreResumeAlignment(
    text, candidate, resumeKeywords, weights.resumeKeywordAlignment,
  );

  const raw = Object.values(breakdown).reduce((s, b) => s + b.points, 0);
  const max = Object.values(weights).reduce((s, w) => s + w, 0);
  const total = max > 0 ? Math.round((raw / max) * 100) : 0;

  const matchedKeywords = [...matchedAll];
  const missingKeywords = computeMissing(text, candidate, kw);

  return {
    total,
    raw: round2(raw),
    max,
    breakdown,
    matchedKeywords,
    missingKeywords,
    sponsorship: sponsorship?.status ?? 'Unconfirmed',
  };
}

/** Points = weight * min(1, matched/fullAt). */
function keywordCategory(text, keywords = [], weight = 0, fullAt = 1, sink) {
  const matched = matchedPhrases(text, keywords);
  for (const m of matched) sink?.add(m);
  const coverage = Math.min(1, matched.length / Math.max(1, fullAt));
  return { points: round2(weight * coverage), weight, matched };
}

function scoreSeniority(text, candidateSeniority, weight) {
  if (!candidateSeniority) return { points: 0, weight, matched: [] };
  const want = SENIORITY_RANK[candidateSeniority] ?? 3;
  // Detect seniority signal in the JD/title.
  const detected = detectSeniority(text);
  if (detected === null) return { points: round2(weight * 0.6), weight, matched: ['seniority unstated'] };
  const diff = Math.abs(detected - want);
  const factor = diff === 0 ? 1 : diff === 1 ? 0.6 : 0.2;
  return { points: round2(weight * factor), weight, matched: [`seniority delta ${diff}`] };
}

function detectSeniority(text) {
  if (/\b(principal|staff)\b/.test(text)) return 5;
  if (/\b(lead|manager)\b/.test(text)) return 4;
  if (/\b(senior|sr\.?)\b/.test(text)) return 3;
  if (/\b(junior|jr\.?|entry)\b/.test(text)) return 1;
  if (/\bmid[- ]?level\b/.test(text)) return 2;
  return null;
}

function scoreSponsorship(status, weight) {
  const factor = { Confirmed: 1, Approved: 1, Likely: 0.7, Unconfirmed: 0.35 }[status] ?? 0;
  return { points: round2(weight * factor), weight, matched: [status ?? 'Unconfirmed'] };
}

function scoreCompanyLikelihood(status, weight) {
  const factor = { Confirmed: 1, Approved: 1, Likely: 1, Unconfirmed: 0.2 }[status] ?? 0;
  return { points: round2(weight * factor), weight, matched: [status ?? 'Unconfirmed'] };
}

function scoreGeography(job, candidate, weight) {
  const prefs = candidate.locationPreferences ?? {};
  const loc = normalizeText(job.location);
  const matched = [];
  let factor = 0.5; // unknown location: neutral

  if (/remote/.test(loc)) {
    if (prefs.remote) { factor = 1; matched.push('remote'); }
  } else if (loc) {
    const excluded = (prefs.excludedLocations ?? []).some((x) => loc.includes(normalizeText(x)));
    if (excluded) { factor = 0; matched.push('excluded location'); }
    else if (prefs.onsite || prefs.hybrid) { factor = 0.8; matched.push('onsite/hybrid ok'); }
    else { factor = 0.4; matched.push('onsite, candidate prefers remote'); }
  }
  return { points: round2(weight * factor), weight, matched };
}

function scoreFreshness(job, freshness, weight, now) {
  const age = ageInDays(job.postedAt, now);
  if (age === null) return { points: round2(weight * 0.5), weight, matched: ['posted date unknown'] };
  const flagDays = freshness.flagOlderThanDays ?? 7;
  const skipDays = freshness.skipOlderThanDays ?? 14;
  let factor;
  if (age <= flagDays) factor = 1;
  else if (age <= skipDays) factor = 0.5;
  else factor = 0;
  return { points: round2(weight * factor), weight, matched: [`${age} days old`] };
}

function scoreResumeAlignment(text, candidate, resumeKeywords, weight) {
  const profileTerms = resumeKeywords && resumeKeywords.length
    ? resumeKeywords
    : candidateStackTerms(candidate);
  if (profileTerms.length === 0) return { points: 0, weight, matched: [] };
  const matched = matchedPhrases(text, profileTerms);
  const coverage = Math.min(1, matched.length / Math.max(1, Math.min(8, profileTerms.length)));
  return { points: round2(weight * coverage), weight, matched };
}

/** Flatten the candidate technical stack into a term list. */
export function candidateStackTerms(candidate = {}) {
  const stack = candidate.technicalStack ?? {};
  return Object.values(stack).flat().filter((t) => typeof t === 'string');
}

/** Important JD keywords absent from the candidate profile (tailoring gaps). */
function computeMissing(text, candidate, kw) {
  const important = [
    ...(kw.azureFabric ?? []), ...(kw.dataEngineering ?? []),
    ...(kw.languages ?? []), ...(kw.biSemantic ?? []),
  ];
  const inJd = new Set(matchedPhrases(text, important).map((p) => p.toLowerCase()));
  const profileText = normalizeText([
    ...candidateStackTerms(candidate),
    ...(candidate.certifications ?? []),
    ...(candidate.domainExperience ?? []),
  ].join(' '));
  const missing = [];
  for (const term of inJd) {
    if (!profileText.includes(term)) missing.push(term);
  }
  return missing;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
