/**
 * Profile-driven role fit — "could this posting plausibly be for me?"
 *
 * WHY THIS EXISTS. Discovery used a single boolean title gate whose default for
 * an unrecognized title was REJECT, applied BEFORE the job description was ever
 * fetched. That is the wrong default in the wrong place, for two reasons:
 *
 *  1. A title gate is a COST control, not a relevance judgement. Relevance is
 *     decided by the scorer, where the title is worth 12 of ~110 points — the
 *     other ~90% comes from stack, seniority, domain and keyword alignment that
 *     only the DESCRIPTION can supply. Rejecting on the title alone throws the
 *     job away before the evidence that actually decides it has been read.
 *  2. Employers do not name roles the way a job seeker searches for them.
 *
 * Measured against 55,293 already-scored postings in the local database, the
 * old gate would have rejected 14.8% of everything scoring 60-74 and 46.8% of
 * everything scoring 50-59 — 148 postings at 60+ that the scorer itself judged
 * a good fit, among them "Databricks Senior Architect" (68), "Senior BI & AI
 * Engineer" (74) and "Senior Systems Engineer - Business Analytics Platforms"
 * (81). Those survived only because they arrived from adapters that happen not
 * to apply the gate; the identical role from a gated source vanished silently.
 *
 * THE FIX IS A THIRD ANSWER. Instead of accept/reject, a title resolves to:
 *
 *   accept  the title itself carries profile evidence — keep, and prefer it
 *           when a limited description budget is being spent
 *   defer   the title says nothing either way — KEEP IT and let the description
 *           and the scorer decide, because a title is not enough to convict
 *   reject  the title positively names a different profession — drop it
 *
 * Only `reject` drops a posting. "Unknown" is no longer fatal.
 *
 * EVERYTHING IS DERIVED FROM THE CANDIDATE PROFILE — `targetTitles`,
 * `technicalStack`, `domainExperience`, `seniority`. No employer names, no
 * hardcoded job titles. Editing config/candidate.json changes what matches, so
 * the same code serves a different candidate without modification.
 */

import { normalizeText } from '../utils/textNormalize.js';

/**
 * Role nouns — what a person IS. Deliberately includes leadership and advisory
 * nouns (lead/manager/director/head/principal/architect/consultant), because a
 * senior IC's next role is frequently titled with one of them and the old
 * regex recognized none of them.
 */
const ROLE_NOUNS = [
  'engineer', 'engineering', 'developer', 'architect', 'analyst', 'scientist',
  'consultant', 'specialist', 'administrator', 'programmer', 'modeler', 'modeller',
  'lead', 'manager', 'director', 'head', 'principal', 'staff', 'owner', 'expert',
];

/**
 * Domain words that place a role in the data/analytics family. Seeded from the
 * vocabulary any such profile implies, then EXTENDED at runtime with the words
 * actually present in the candidate's own target titles and domains.
 */
const DOMAIN_SEEDS = [
  'data', 'analytics', 'analytic', 'analysis', 'bi', 'business intelligence',
  'etl', 'elt', 'warehouse', 'warehousing', 'lakehouse', 'datalake', 'data lake',
  'pipeline', 'platform', 'reporting', 'report', 'insight', 'insights',
  'informatics', 'ingestion', 'integration', 'semantic', 'dimensional',
  'visualization', 'visualisation', 'dashboard', 'metrics', 'mdm',
  'master data', 'data quality', 'data governance', 'decision intelligence',
];

/**
 * Titles that belong to a clearly different profession. A title is rejected
 * ONLY when one of these is present AND the title carries no profile signal at
 * all — so "Data Engineer, Clinical Nursing Systems" survives on its data
 * signal while "Registered Nurse" does not.
 *
 * Kept deliberately short and unambiguous. Anything borderline belongs in
 * `defer`, where the description gets a say; a wrong reject is invisible and
 * permanent, a wrong defer merely costs one scoring pass.
 */
const OTHER_PROFESSIONS = [
  'nurse', 'nursing', 'physician', 'surgeon', 'dentist', 'pharmacist',
  'veterinar', 'therapist', 'caregiver', 'phlebotom', 'radiolog', 'sonograph',
  'attorney', 'paralegal', 'counsel', 'litigation',
  'driver', 'trucking', 'forklift', 'warehouse associate', 'warehouse worker',
  'janitor', 'custodian', 'housekeep', 'landscap', 'plumber', 'electrician',
  'welder', 'machinist', 'carpenter', 'mechanic', 'hvac', 'roofer',
  'chef', 'cook', 'barista', 'bartender', 'server', 'waiter', 'cashier',
  'teacher', 'professor', 'tutor', 'lecturer', 'librarian',
  'salon', 'stylist', 'barber', 'massage',
  'security guard', 'police', 'firefighter', 'paramedic',
  'recruiter', 'talent acquisition', 'payroll clerk',
  'social worker', 'chaplain', 'clergy',
  'flight attendant', 'pilot', 'deckhand',
];

/**
 * Business functions that share office vocabulary with data work but are a
 * different job. These matter more than they look: aggregator queries match the
 * whole posting body, not the title, so a "data engineer" search really does
 * return "Accounts Payable Administrator" (measured: one such query returned
 * 31,148 rows). Without an explicit reject these land in `defer` and are kept.
 *
 * As with every other reject list, a domain signal in the title overrides it —
 * "Sales Analytics Engineer" survives.
 */
const OTHER_BUSINESS_FUNCTIONS = [
  'accounts payable', 'accounts receivable', 'accountant', 'accounting',
  'bookkeep', 'auditor', 'tax ', 'treasury', 'billing', 'collections',
  'account executive', 'account manager', 'sales representative', 'salesperson',
  'business development', 'customer success', 'customer service',
  'call center', 'call centre', 'telemarket', 'merchandis', 'buyer',
  'marketing manager', 'brand manager', 'copywriter', 'social media',
  'human resources', 'hr generalist', 'benefits administrator',
  'office manager', 'administrative assistant', 'executive assistant',
  'receptionist', 'front desk', 'store manager', 'shift supervisor',
  'procurement', 'logistics coordinator', 'dispatcher', 'claims adjuster',
  'underwriter', 'loan officer', 'teller', 'real estate agent',
];

/**
 * Engineering specialisms that are real software work but a different craft.
 * These only reject when NO data/analytics signal is present, so
 * "Frontend Engineer, Analytics Platform" is kept.
 */
const OTHER_ENGINEERING = [
  'frontend', 'front end', 'front-end', 'ios', 'android', 'mobile',
  'game', 'gameplay', 'graphics', 'firmware', 'embedded', 'rf ',
  'mechanical', 'civil', 'chemical', 'aerospace', 'structural', 'geotechnical',
  'network engineer', 'field engineer', 'sales engineer', 'flight software',
];

/** Words that signal scope/leadership, used for ranking rather than gating. */
const LEADERSHIP_MARKERS = [
  'lead', 'leader', 'principal', 'staff', 'manager', 'director', 'head of',
  'head,', 'architect', 'owner', 'vp', 'chief',
];

/** Seniority vocabulary — never a domain signal, only a level signal. */
const SENIORITY_WORDS = new Set([
  'intern', 'junior', 'jr', 'entry', 'associate', 'mid', 'senior', 'sr',
  'lead', 'staff', 'principal', 'manager', 'director', 'head', 'vp', 'chief',
  'level', 'i', 'ii', 'iii', 'iv',
]);

/** Seniority ladder, low to high, for comparing against profile seniority. */
const SENIORITY_LADDER = [
  ['intern', 0], ['junior', 1], ['jr', 1], ['entry', 1], ['associate', 2],
  ['mid', 3], ['senior', 4], ['sr', 4], ['lead', 5], ['staff', 5],
  ['principal', 6], ['manager', 5], ['director', 7], ['head', 7], ['vp', 8],
];

/** Flatten any nested array/object of strings into a lowercase term list. */
function flattenTerms(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (t) out.push(t);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) flattenTerms(v, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) flattenTerms(v, out);
  }
  return out;
}

/**
 * Split a multi-word technology into the tokens worth matching on their own.
 *
 * "Azure Data Factory" should match a title saying "Azure", and "Power BI"
 * should match "Power BI" — but a bare "data" or "factory" is far too generic
 * to be treated as a technology hit, so single generic words are dropped.
 */
const GENERIC_TECH_TOKENS = new Set([
  'data', 'cloud', 'apache', 'microsoft', 'azure data', 'modeling', 'modelling',
  'architecture', 'pipelines', 'systems', 'design', 'testing', 'quality',
  'integration', 'streaming', 'engineering', 'analytics', 'reports', 'patterns',
  // Words that name a technology in this profile but something else entirely in
  // other engineering fields. "Fabric" is the costly one: as a bare token it
  // matched "Senior Verification Engineer - ARM Fabric Unit Level" (NVIDIA),
  // "Hardware Network Fabric Development Engineer" (HPE) and "Product Manager,
  // Agent Fabric" (Salesforce) — silicon interconnect and product names, not
  // Microsoft Fabric. Likewise "delta" (an airline), "lake", "event", "hub",
  // "spark", "factory", "studio". The multi-word phrases they come from
  // ("microsoft fabric", "delta lake", "azure data factory") survive intact and
  // are unambiguous, so nothing real is lost by dropping the bare token.
  'fabric', 'delta', 'lake', 'event', 'hub', 'spark', 'factory', 'studio',
  'bundles', 'actions', 'logic', 'apps', 'vector', 'feature', 'series',
  'lineage', 'observability', 'time', 'live', 'tables', 'gen2', 'onelake',
]);

/**
 * Build the matching vocabulary for a candidate profile.
 *
 * Pure and memo-friendly: the same profile always yields the same vocabulary,
 * so callers can build it once per run.
 *
 * @param {object} candidate parsed config/candidate.json
 * @returns {{domain: string[], tech: string[], titles: string[], seniority: number}}
 */
export function buildProfileVocabulary(candidate = {}) {
  const titles = (candidate.targetTitles ?? []).map((t) => normalizeText(t)).filter(Boolean);

  // Domain words the profile itself uses, on top of the family seeds.
  //
  // Seniority and role words must NOT leak in here. Target titles contain
  // "Senior", "Lead" and role nouns, and admitting them made the domain test
  // fire on any title containing the word "senior" — which accepted "Senior
  // Quality Engineer - Automation Engineering" as a data role and collapsed
  // rejection of genuinely irrelevant work from 96% to 8%.
  const domain = new Set(DOMAIN_SEEDS);
  for (const t of titles) {
    for (const word of t.split(/[^a-z0-9+#]+/)) {
      if (word.length <= 2) continue;
      if (ROLE_NOUNS.includes(word)) continue;
      if (SENIORITY_WORDS.has(word)) continue;
      domain.add(word);
    }
  }
  for (const d of candidate.domainExperience ?? []) {
    const norm = normalizeText(d);
    // Industry experience ("Insurance", "Government Reporting") describes WHERE
    // the work was, not what the role is. As a gate term it would accept every
    // insurance job on the board, so it is kept for ranking and left out of the
    // accept test.
    if (norm && norm.split(/\s+/).length > 1) domain.add(norm);
  }

  // Technologies: the whole phrase, plus its distinctive multi-char tokens.
  const tech = new Set();
  for (const term of flattenTerms(candidate.technicalStack)) {
    const clean = term.replace(/\(.*?\)/g, '').trim();
    if (clean.length > 1 && !GENERIC_TECH_TOKENS.has(clean)) tech.add(clean);
    for (const token of clean.split(/[^a-z0-9+#.]+/)) {
      if (token.length >= 4 && !GENERIC_TECH_TOKENS.has(token)) tech.add(token);
    }
  }
  for (const cert of candidate.certifications ?? []) {
    const m = /\b(dp|az|pl|da|ai|ms)-?\d{3}\b/i.exec(String(cert));
    if (m) tech.add(m[0].toLowerCase());
  }

  return {
    domain: [...domain],
    tech: [...tech],
    titles,
    seniority: seniorityRank(candidate.seniority ?? 'senior'),
  };
}

/** Whole-word presence test against already-normalized text. */
function hasTerm(text, term) {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

/** Position on the seniority ladder for a piece of text, or -1. */
export function seniorityRank(text) {
  const t = normalizeText(text);
  let best = -1;
  for (const [word, rank] of SENIORITY_LADDER) {
    if (hasTerm(t, word) && rank > best) best = rank;
  }
  return best;
}

/**
 * Decide what a TITLE alone justifies doing with a posting.
 *
 * @param {string} title
 * @param {object} vocab from `buildProfileVocabulary`
 * @returns {{verdict: 'accept'|'defer'|'reject', signals: string[]}}
 */
export function classifyTitleFit(title, vocab) {
  const raw = String(title ?? '').trim();
  if (!raw) return { verdict: 'defer', signals: ['no-title'] };
  // Normalize punctuation to spaces so an en dash, comma or slash can never
  // break a match. The old regex used a literal character class that excluded
  // the en dash, which alone cost every title written "BI – Reporting Engineer".
  const t = normalizeText(raw).replace(/[^a-z0-9+#]+/g, ' ').trim();
  const signals = [];

  // 1. A configured target title, verbatim, is decisive.
  for (const want of vocab.titles) {
    if (want && t.includes(want)) { signals.push(`title:${want}`); return { verdict: 'accept', signals }; }
  }

  // 2. A technology from the candidate's own stack is a strong signal on its
  //    own — "Databricks Senior Architect" names no domain word and no target
  //    title, yet is unmistakably in profile.
  const techHit = vocab.tech.find((term) => hasTerm(t, term));
  if (techHit) { signals.push(`tech:${techHit}`); return { verdict: 'accept', signals }; }

  // 3. A domain word plus any role noun, in EITHER order. Order-dependence is
  //    what made the old regex miss "Engineer, IT Data" and "Lead, Analytics".
  const domainHit = vocab.domain.find((term) => hasTerm(t, term));
  const roleHit = ROLE_NOUNS.find((noun) => hasTerm(t, noun));
  if (domainHit && roleHit) {
    signals.push(`domain:${domainHit}`, `role:${roleHit}`);
    return { verdict: 'accept', signals };
  }

  // 4. Positively another profession, with no profile signal to redeem it.
  const otherProfession = OTHER_PROFESSIONS.find((p) => t.includes(p));
  if (otherProfession && !domainHit) {
    return { verdict: 'reject', signals: [`other-profession:${otherProfession}`] };
  }
  const otherEng = OTHER_ENGINEERING.find((p) => t.includes(p));
  if (otherEng && !domainHit) {
    return { verdict: 'reject', signals: [`other-engineering:${otherEng}`] };
  }
  const otherBiz = OTHER_BUSINESS_FUNCTIONS.find((p) => t.includes(p));
  if (otherBiz && !domainHit) {
    return { verdict: 'reject', signals: [`other-function:${otherBiz}`] };
  }

  // 5. Unknown. NOT a rejection — the description decides.
  if (domainHit) signals.push(`domain:${domainHit}`);
  if (roleHit) signals.push(`role:${roleHit}`);
  return { verdict: 'defer', signals: signals.length ? signals : ['unknown-title'] };
}

/**
 * Rank a posting's title by how confidently it fits, for spending a limited
 * description budget best-first.
 *
 * Broadening what is ELIGIBLE without changing how the budget is SPENT would
 * simply trade good fetches for speculative ones. Ordering by confidence keeps
 * the extra recall close to free: certain matches are enriched first and the
 * deferred tail only consumes whatever budget is left over.
 *
 * @param {string} title
 * @param {object} vocab
 * @returns {number} higher is more worth spending a fetch on
 */
export function titleFitPriority(title, vocab) {
  const { verdict, signals } = classifyTitleFit(title, vocab);
  if (verdict === 'reject') return -1;
  if (verdict === 'defer') return 0;
  // Among accepts, an exact configured title beats a bare technology mention.
  if (signals.some((s) => s.startsWith('title:'))) return 3;
  if (signals.some((s) => s.startsWith('tech:'))) return 2;
  return 1;
}

/**
 * Evidence of scope and ownership, read from the full posting.
 *
 * The profile is a senior IC moving toward platform ownership and technical
 * leadership, and none of that was represented anywhere in scoring — a role
 * that says "own the data platform roadmap and mentor engineers" ranked
 * identically to one that says "write SQL to spec". This is deliberately
 * evidence-based: each signal names the phrase that produced it, so a reader
 * can audit why a job ranked where it did.
 *
 * @param {{title?: string, jdText?: string}} job
 * @param {object} vocab
 * @returns {{leadership: boolean, ownership: boolean, seniorityRank: number,
 *            techHits: string[], domainHits: string[], signals: string[]}}
 */
export function assessScope(job = {}, vocab = { tech: [], domain: [] }) {
  const title = normalizeText(job.title).replace(/[^a-z0-9+#]+/g, ' ');
  const body = normalizeText(job.jdText).replace(/[^a-z0-9+#]+/g, ' ');
  const both = `${title} ${body}`;
  const signals = [];

  const leadership = LEADERSHIP_MARKERS.some((m) => hasTerm(title, m.trim()))
    || /\b(mentor|mentoring|lead a team|technical leadership|set the technical direction|own the roadmap)\b/.test(body);
  if (leadership) signals.push('leadership-scope');

  const ownership = /\b(own(s|ership)?|architect|design|build out|stand up|establish|drive)\b[\w\s]{0,40}\b(platform|architecture|pipeline|warehouse|lakehouse|roadmap|strategy|framework)\b/.test(body);
  if (ownership) signals.push('platform-ownership');

  const techHits = vocab.tech.filter((term) => hasTerm(both, term));
  const domainHits = vocab.domain.filter((term) => hasTerm(both, term));

  return {
    leadership,
    ownership,
    seniorityRank: seniorityRank(job.title),
    techHits,
    domainHits,
    signals,
  };
}
