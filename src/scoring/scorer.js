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

/**
 * Sources considered "direct ATS" for the directAtsAvailability category — a
 * posting we can apply to on the employer's own ATS, with no aggregator in the
 * way. This must track the discovery adapters in search/sources.js: when Ashby,
 * SmartRecruiters, Workday, and company careers pages were added as real
 * discovery sources, they kept scoring 0 here, quietly penalizing 43% of the
 * corpus against otherwise-identical Greenhouse/Lever roles.
 *
 * `manual` / `manual-url` are direct by definition: the human pasted the
 * employer's own application URL.
 */
const DIRECT_ATS_SOURCES = new Set([
  'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'careers',
  'manual', 'manual-url',
]);

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
  //
  // dataEngineeringStack folds in devopsInfra/dataQuality/genAI rather than
  // giving each its own weighted category: CI/CD, Kubernetes, data-quality
  // tooling, and LLM/RAG work are all measured as real, common asks on modern
  // data-platform postings (verified against 20k stored JDs: data quality in
  // 34%, CI/CD in 21%, observability 14%, LLM 11%, Kubernetes 10%), and the
  // candidate profile already lists this exact stack. Folding them into the
  // existing 12-point/3-match cap widens which real terms can satisfy it
  // without touching the weight allocation itself — a job full of modern
  // platform-engineering terms can now legitimately earn the same credit a
  // classic ETL/Spark/Kafka job always could, instead of scoring zero here for
  // not mentioning last decade's tool names.
  const dataEngineeringTerms = [
    ...(kw.dataEngineering ?? []), ...(kw.devopsInfra ?? []),
    ...(kw.dataQuality ?? []), ...(kw.genAI ?? []),
  ];
  // SATURATION: how many distinct keyword hits earn full marks for a category.
  //
  // These were hardcoded literals, and they saturated early enough that depth
  // was not rewarded over presence: a JD mentioning Azure, Databricks and Delta
  // Lake once each scored identically to a perfect stack match, and a mediocre
  // posting cleared 55 before any real fit was established. They are now config
  // (scoring.saturation), so a different candidate can tune matching without
  // editing JavaScript — the same argument as the declarative-categories work.
  //
  // titleFit stays at 1 deliberately: a title either names the role or it does
  // not, and that is genuinely binary.
  const sat = scoring.saturation ?? {};
  const fullAt = (key, fallback) => {
    const v = Number(sat[key]);
    return Number.isFinite(v) && v >= 1 ? v : fallback;
  };
  breakdown.titleFit = keywordCategory(titleText, kw.titles, weights.titleFit, fullAt('titleFit', 1), matchedAll);
  breakdown.azureFabricStack = keywordCategory(text, kw.azureFabric, weights.azureFabricStack, fullAt('azureFabricStack', 3), matchedAll);
  breakdown.dataEngineeringStack = keywordCategory(text, dataEngineeringTerms, weights.dataEngineeringStack, fullAt('dataEngineeringStack', 3), matchedAll);
  breakdown.biSemanticDepth = keywordCategory(text, kw.biSemantic, weights.biSemanticDepth, fullAt('biSemanticDepth', 2), matchedAll);
  breakdown.pythonSqlPyspark = keywordCategory(text, kw.languages, weights.pythonSqlPyspark, fullAt('pythonSqlPyspark', 2), matchedAll);
  breakdown.domainFit = keywordCategory(text, kw.domains, weights.domainFit, fullAt('domainFit', 1), matchedAll);

  // Seniority fit.
  breakdown.seniorityFit = scoreSeniority(job, text, candidate.seniority, weights.seniorityFit);

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
  const missingKeywords = computeMissing(text, candidate, kw, scoring.evidenceAliases);

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

/**
 * Seniority AND scope fit.
 *
 * Two corrections live here, both of which used to push the profile's best
 * matches DOWN the ranking:
 *
 * 1. LEVEL IS READ FROM THE TITLE, not the whole document. `detectSeniority`
 *    ran over title+JD, where `/\b(lead|manager)\b/` matches the ordinary verb:
 *    a posting saying "you will LEAD the design of our lakehouse" was scored as
 *    a Lead-level role, one rung above a senior candidate, and docked to 0.6 of
 *    the weight. Rich leadership language in a description — exactly what a
 *    senior engineer wants to see — cost 3.2 of 8 points. The body is still
 *    consulted, but only when the title states no level at all.
 *
 * 2. THE PENALTY IS ASYMMETRIC. Being one rung ABOVE the candidate's stated
 *    level is the normal next step and is treated as a full fit; being BELOW is
 *    the real mismatch. Symmetric distance punished "Lead Data Engineer" for a
 *    senior candidate exactly as hard as "Junior Data Engineer", which is
 *    backwards for someone moving toward technical leadership.
 *
 * Scope evidence (owning a platform, setting technical direction, mentoring)
 * tops the category up, so responsibility counts even when the title is
 * unremarkable. It can only ADD, never subtract.
 */
function scoreSeniority(job, text, candidateSeniority, weight) {
  if (!candidateSeniority) return { points: 0, weight, matched: [] };
  const want = SENIORITY_RANK[candidateSeniority] ?? 3;
  const matched = [];

  // Title first — that is where a level is actually declared. Lowercased,
  // because `detectSeniority` matches lowercase patterns with no `i` flag and a
  // raw "Junior Data Engineer" would otherwise detect nothing, fall through to
  // the body, and pick up the VERB "lead" — scoring a junior role as a step up.
  let detected = detectSeniority(String(job?.title ?? '').toLowerCase());
  if (detected === null) detected = detectSeniority(text);

  let factor;
  if (detected === null) {
    factor = 0.6;
    matched.push('seniority unstated');
  } else if (detected >= want) {
    // At or above level. One rung up is a lateral/step-up move, not a misfit;
    // far above (a VP role for a senior IC) still tapers.
    const up = detected - want;
    factor = up <= 1 ? 1 : up === 2 ? 0.75 : 0.4;
    matched.push(up === 0 ? 'seniority match' : `seniority +${up} (step up)`);
  } else {
    const down = want - detected;
    factor = down === 1 ? 0.5 : 0.15;
    matched.push(`seniority -${down} (below level)`);
  }

  // Scope top-up: platform ownership and technical leadership are part of what
  // this profile is looking for and were previously worth nothing at all.
  const scope = scopeBonus(text);
  if (scope.bonus > 0) matched.push(...scope.matched);
  const points = Math.min(weight, weight * factor + weight * scope.bonus);
  return { points: round2(points), weight, matched };
}

/** Ownership/leadership evidence, worth up to 25% of the seniority weight. */
function scopeBonus(text) {
  const matched = [];
  let bonus = 0;
  if (/\b(own|owns|ownership of|accountable for|responsible for)\b[\w\s,]{0,40}\b(platform|architecture|pipeline|warehouse|lakehouse|roadmap|strategy|data estate)\b/.test(text)) {
    matched.push('platform ownership'); bonus += 0.15;
  }
  if (/\b(mentor|mentoring|coach|technical direction|lead a team|lead the team|guide engineers|set standards|define best practices)\b/.test(text)) {
    matched.push('technical leadership'); bonus += 0.10;
  }
  return { bonus: Math.min(0.25, bonus), matched };
}

function detectSeniority(text) {
  if (/\b(principal|staff)\b/.test(text)) return 5;
  if (/\b(lead|manager)\b/.test(text)) return 4;
  if (/\b(senior|sr\.?)\b/.test(text)) return 3;
  if (/\b(junior|jr\.?|entry)\b/.test(text)) return 1;
  if (/\bmid[- ]?level\b/.test(text)) return 2;
  return null;
}

/**
 * Sponsorship feasibility points. `Denied` scores ZERO — below Unconfirmed,
 * which still earns partial credit for being merely unknown. An explicit refusal
 * is worse than silence, so it must never out-score it.
 */
function scoreSponsorship(status, weight) {
  const factor = { Confirmed: 1, Approved: 1, Likely: 0.7, Unconfirmed: 0.35, Denied: 0 }[status] ?? 0;
  return { points: round2(weight * factor), weight, matched: [status ?? 'Unconfirmed'] };
}

function scoreCompanyLikelihood(status, weight) {
  const factor = { Confirmed: 1, Approved: 1, Likely: 1, Unconfirmed: 0.2, Denied: 0 }[status] ?? 0;
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

/**
 * Important JD keywords NOT evidenced by the candidate profile (tailoring gaps).
 *
 * A term counts as evidenced when the profile contains the term itself OR any
 * of its configured aliases (scoring.evidenceAliases) — so "ADF" in a JD is
 * never reported as a gap when the profile lists "Azure Data Factory", and
 * "lakehouse" is evidenced by "Delta Lake"/"Databricks" experience. Without
 * this, the same skill could appear in BOTH matchedKeywords (found in the JD)
 * and missingKeywords (alias not substring-matched in the profile), which
 * reads as a contradiction on the dashboard.
 */
export function computeMissing(text, candidate, kw, evidenceAliases = {}) {
  const important = [
    ...(kw.azureFabric ?? []), ...(kw.dataEngineering ?? []),
    ...(kw.languages ?? []), ...(kw.biSemantic ?? []),
    ...(kw.devopsInfra ?? []), ...(kw.dataQuality ?? []), ...(kw.genAI ?? []),
  ];
  const inJd = new Set(matchedPhrases(text, important).map((p) => normalizeText(p)));
  const profileText = normalizeText([
    ...candidateStackTerms(candidate),
    ...(candidate.certifications ?? []),
    ...(candidate.domainExperience ?? []),
  ].join(' '));
  const aliases = new Map(
    Object.entries(evidenceAliases ?? {}).map(([term, list]) => [
      normalizeText(term),
      (Array.isArray(list) ? list : []).map((a) => normalizeText(a)),
    ]),
  );
  const evidenced = (term) =>
    profileText.includes(term) || (aliases.get(term) ?? []).some((a) => a && profileText.includes(a));
  const missing = [];
  for (const term of inJd) {
    if (!evidenced(term)) missing.push(term);
  }
  return missing;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
