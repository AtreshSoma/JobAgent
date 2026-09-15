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

  // KEYWORD CATEGORIES ARE DECLARATIVE.
  //
  // These were six hardcoded JavaScript identifiers — azureFabricStack,
  // dataEngineeringStack, biSemanticDepth, pythonSqlPyspark, domainFit and a
  // titleFit that read a fixed keyword list. Together they own 64 of the 110
  // available points, so any candidate outside that one stack could not reach
  // them at all. Measured against perfectly-matching postings, with a floor of
  // 50: a registered nurse scored 21, a frontend engineer 26, an accountant 27
  // and a marketing manager 27, while the profile the vocabulary was written
  // for scored 78. Their theoretical ceiling was 53 — a flawless match barely
  // cleared the discard line. Discovery already worked for all of them; only
  // scoring did not.
  //
  // `scoring.categories` replaces them with an iterated array, so a second user
  // expresses their own field in config instead of editing this file. A
  // category draws its terms from one of three places:
  //
  //   from: 'targetTitles'    -> candidate.targetTitles   (follows the profile)
  //   from: 'technicalStack'  -> candidate.technicalStack (follows the profile)
  //   keywords / keywordSet   -> an explicit list in scoring.json
  //
  // The first two matter as much as the array does: titleFit used to read
  // `scoring.keywords.titles`, so adding a target title changed what was
  // SEARCHED for but not what was SCORED, and the two silently disagreed.
  const categories = resolveCategories(scoring, candidate);
  for (const category of categories) {
    breakdown[category.id] = keywordCategory(
      category.match === 'title' ? titleText : text,
      category.terms, category.weight, category.fullAt, matchedAll,
    );
  }

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
  // The denominator is the STRUCTURAL weights plus whatever categories were
  // declared. It cannot be `Object.values(weights)`: on a legacy config the
  // categories derive their weights from that same object, so summing both
  // counted every keyword category twice and deflated every score (a strong
  // match fell from 78 to 52 against an unchanged 75 threshold).
  const max = STRUCTURAL_WEIGHTS.reduce((s, k) => s + (Number(weights[k]) || 0), 0)
    + categories.reduce((s, c) => s + c.weight, 0);
  const total = max > 0 ? Math.round((raw / max) * 100) : 0;

  const matchedKeywords = [...matchedAll];
  const missingKeywords = computeMissing(text, candidate, kw, scoring.evidenceAliases, categories);

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

/** Fixed, non-keyword categories. Their weights stay in `scoring.weights`. */
export const STRUCTURAL_WEIGHTS = Object.freeze([
  'seniorityFit', 'sponsorshipFeasibility', 'companySponsorshipLikelihood',
  'geographyFit', 'freshness', 'directAtsAvailability', 'resumeKeywordAlignment',
]);

/** Flatten `candidate.technicalStack` into a term list. */
function stackTerms(candidate) {
  const stack = candidate?.technicalStack ?? {};
  return Object.values(stack).flat().filter((t) => typeof t === 'string' && t.trim());
}

/**
 * Resolve a category's match terms.
 *
 * `from` binds a category to the PROFILE so editing the profile changes
 * scoring; `keywords` / `keywordSet` keep it an explicit vocabulary in
 * scoring.json. Both are supported because some categories are genuinely about
 * the candidate (their titles, their stack) and some are about the market
 * (domains, compliance words) which no profile field carries.
 */
function categoryTerms(category, scoring, candidate) {
  if (category.from === 'targetTitles') {
    return (candidate?.targetTitles ?? []).filter(Boolean);
  }
  if (category.from === 'technicalStack') {
    return stackTerms(candidate);
  }
  if (Array.isArray(category.keywords)) return category.keywords;
  // `keywordSet` may name one set or several, which is how the legacy
  // dataEngineeringStack folded four lists into one category.
  const sets = [].concat(category.keywordSet ?? []);
  return sets.flatMap((name) => scoring?.keywords?.[name] ?? []);
}

/**
 * The keyword categories to score, declarative if configured and otherwise
 * synthesized from the legacy shape.
 *
 * The fallback is not politeness: `scoring.json` files predating
 * `categories` must keep scoring IDENTICALLY, or every stored score in a
 * 100k-row database silently changes meaning on upgrade.
 *
 * @param {object} scoring parsed config/scoring.json
 * @param {object} candidate parsed config/candidate.json
 * @returns {Array<{id, label, weight, fullAt, match, terms}>}
 */
export function resolveCategories(scoring = {}, candidate = {}) {
  const sat = scoring.saturation ?? {};
  const fullAt = (key, fallback) => {
    const v = Number(sat[key]);
    return Number.isFinite(v) && v >= 1 ? v : fallback;
  };

  if (Array.isArray(scoring.categories) && scoring.categories.length) {
    return scoring.categories
      .filter((c) => c && c.id && Number(c.weight) > 0)
      .map((c) => ({
        id: String(c.id),
        label: c.label ?? c.id,
        weight: Number(c.weight),
        fullAt: Math.max(1, Number(c.fullAt) || 1),
        match: c.match === 'title' ? 'title' : 'text',
        terms: categoryTerms(c, scoring, candidate),
      }));
  }

  // ── legacy shape ──────────────────────────────────────────────────────
  const w = scoring.weights ?? {};
  const kw = scoring.keywords ?? {};
  return [
    { id: 'titleFit', label: 'Title fit', weight: w.titleFit ?? 0, fullAt: fullAt('titleFit', 1), match: 'title', terms: kw.titles ?? [] },
    { id: 'azureFabricStack', label: 'Azure / Fabric stack', weight: w.azureFabricStack ?? 0, fullAt: fullAt('azureFabricStack', 3), match: 'text', terms: kw.azureFabric ?? [] },
    {
      id: 'dataEngineeringStack',
      label: 'Data engineering stack',
      weight: w.dataEngineeringStack ?? 0,
      fullAt: fullAt('dataEngineeringStack', 3),
      match: 'text',
      terms: [...(kw.dataEngineering ?? []), ...(kw.devopsInfra ?? []), ...(kw.dataQuality ?? []), ...(kw.genAI ?? [])],
    },
    { id: 'biSemanticDepth', label: 'BI / semantic depth', weight: w.biSemanticDepth ?? 0, fullAt: fullAt('biSemanticDepth', 2), match: 'text', terms: kw.biSemantic ?? [] },
    { id: 'pythonSqlPyspark', label: 'Languages', weight: w.pythonSqlPyspark ?? 0, fullAt: fullAt('pythonSqlPyspark', 2), match: 'text', terms: kw.languages ?? [] },
    { id: 'domainFit', label: 'Domain fit', weight: w.domainFit ?? 0, fullAt: fullAt('domainFit', 1), match: 'text', terms: kw.domains ?? [] },
  ].filter((c) => c.weight > 0);
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
export function computeMissing(text, candidate, kw, evidenceAliases = {}, categories = null) {
  // A GAP NEEDS A VOCABULARY THE CANDIDATE DOES NOT OWN.
  //
  // "Missing" means: this JD asks for something you cannot evidence. Finding
  // those requires a candidate-INDEPENDENT list of skill terms to look for. The
  // candidate's own stack cannot supply it — every term found that way is by
  // definition one they already have, so the answer is always "no gaps". (That
  // circularity was briefly introduced here while making scoring profile-driven,
  // and is the reason this comment exists.)
  //
  // So the vocabulary is the market one: every list under `scoring.keywords`,
  // plus any category that declares an explicit vocabulary rather than binding
  // to the profile. A category bound to `targetTitles` or `technicalStack` is
  // deliberately excluded.
  //
  // CONSEQUENCE, stated plainly: gap analysis is only as good as
  // `scoring.keywords`. A user in another field who leaves those lists as the
  // shipped data-engineering vocabulary will see few or no gaps — not because
  // they have none, but because nothing is looking for theirs.
  // `titles` and `domains` are excluded on principle: a job title is not a skill
  // you can be missing, and neither is an industry. Including them reported
  // "data engineer" as a gap on a data-engineering role.
  const NOT_SKILLS = new Set(['titles', 'domains']);
  const marketVocabulary = Object.entries(kw ?? {})
    .filter(([name]) => !NOT_SKILLS.has(name))
    .flatMap(([, list]) => list ?? []);
  const declaredVocabulary = (categories ?? [])
    .filter((c) => c.match !== 'title' && !c.from)
    .flatMap((c) => c.terms ?? []);
  const important = [...marketVocabulary, ...declaredVocabulary]
    .filter((t) => typeof t === 'string' && t.trim());
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
