/**
 * Role families — the shared vocabulary that lets one code path serve any
 * profession.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two questions decide whether this tool works for a second candidate, and
 * both were previously answered with lists written from ONE candidate's point
 * of view:
 *
 *   1. "Is this posting in my field?"  `profileFit.js` answered it with a
 *      hardcoded data/analytics domain vocabulary plus three absolute reject
 *      lists (OTHER_PROFESSIONS / OTHER_BUSINESS_FUNCTIONS / OTHER_ENGINEERING).
 *      Measured: a marketing profile ACCEPTED "ETL Developer" and "Lakehouse
 *      Platform Engineer" (the data vocabulary was injected into every profile)
 *      while REJECTING "Brand Manager"; an accounting profile REJECTED
 *      "Accounting Manager". The candidate's own adjacent roles were thrown
 *      away and the previous candidate's were kept.
 *
 *   2. "What should I search for?"  Discovery searched the literal strings in
 *      `targetTitles` and nothing else, so a role named differently by the
 *      employer was never found.
 *
 * Both are answered here from `config/role_families.json`, which is DATA. Every
 * family runs through the same uniform code below — there is no branch on any
 * particular profession, and no family is the default. Adding or correcting a
 * field means editing that JSON file, never this one.
 *
 * THE REJECT TEST IS SYMMETRIC. A title is only rejected when its own family is
 * confidently identified AND the candidate has no signal in that family. "Not
 * data engineering" is not a reason; "positively a different family from
 * yours" is. Anything below the confidence threshold defers to the description,
 * because a wrong reject is silent and permanent while a wrong defer costs one
 * scoring pass.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeText } from '../utils/textNormalize.js';

/** Where the taxonomy lives, relative to a project root. */
export const ROLE_FAMILIES_FILE = join('config', 'role_families.json');

/**
 * Repo root, two levels up from src/profile. Resolved here rather than imported
 * from loadConfig so that the pure matching code carries no dependency on the
 * config loader (which reads .env and validates every schema on import).
 */
export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Kind weights used when the taxonomy does not state its own. */
const DEFAULT_WEIGHTS = Object.freeze({ role: 6, domain: 3, skill: 2, head: 1 });

/**
 * A term's score is its kind weight times its word count, capped at three.
 *
 * Specificity is the whole point: "accounts payable" says far more about a role
 * than "payable" does, and a one-word domain hit like "product" says less than
 * "product marketing". Without this, the reject threshold could not
 * simultaneously catch "Accounts Payable Administrator" (a different function,
 * worth rejecting for an engineer) and spare "Technical Program Manager" (an
 * adjacent role, worth deferring for a product manager). With it, they score 7
 * and 4 against a threshold of 6.
 */
const MAX_TERM_WORDS = 3;

/**
 * Score a title's family must reach before a REJECT is allowed. One whole role
 * phrase ("registered nurse" = 12) or one two-word domain term ("accounts
 * payable" = 6) clears it; a bare head noun plus a single generic domain word
 * does not.
 */
export const REJECT_CONFIDENCE = 6;

/**
 * Minimum score for a family to count as one of the CANDIDATE's own, and the
 * fraction of their top family it must also reach.
 *
 * Both exist to stop ONE incidental term dragging in a whole field. A product
 * manager listing "A/B Testing" matched the marketing family's skill list and
 * was admitted to marketing at a ratio of 0.15, which then accepted every brand
 * and campaign posting on the board. Requiring a quarter of the top family's
 * score keeps a second family only when there is real, repeated evidence for it.
 */
const PROFILE_FAMILY_MIN = 6;
const PROFILE_FAMILY_RATIO = 0.25;

/**
 * Two role tokens refer to the same thing when they share a prefix this long.
 *
 * Purely morphological and profession-neutral — it is the difference between
 * an accountant being offered "Accounting Manager" and being offered nothing
 * at all, and it does the same for nurse/nursing, market/marketing,
 * engineer/engineering and regulatory/regulation. Four characters is short
 * enough to catch nurse/nursing and long enough that data/date do not relate.
 */
const TOKEN_PREFIX_MATCH = 4;

/**
 * Seniority prefixes, low to high. Used to strip a level off a role before
 * comparing roles, and to generate level variations of a target role.
 * Profession-neutral: every field uses some subset of these words.
 */
export const SENIORITY_LEVELS = Object.freeze([
  { key: 'intern', rank: 0, labels: ['Intern'] },
  { key: 'entry', rank: 1, labels: ['Junior', 'Entry Level'] },
  { key: 'associate', rank: 2, labels: ['Associate'] },
  { key: 'mid', rank: 3, labels: [''] },
  { key: 'senior', rank: 4, labels: ['Senior'] },
  { key: 'lead', rank: 5, labels: ['Lead', 'Staff'] },
  { key: 'principal', rank: 6, labels: ['Principal'] },
  { key: 'director', rank: 7, labels: ['Director of', 'Head of'] },
  { key: 'executive', rank: 8, labels: ['VP', 'Vice President of'] },
]);

/** Words that state a LEVEL rather than a role, stripped before comparison. */
const SENIORITY_WORDS = new Set([
  'intern', 'junior', 'jr', 'entry', 'level', 'associate', 'mid', 'senior', 'sr',
  'lead', 'staff', 'principal', 'director', 'head', 'chief', 'vp', 'vice',
  'president', 'of', 'i', 'ii', 'iii', 'iv', 'v',
]);

/** Connective words that carry no role identity. */
const STOPWORDS = new Set([
  'and', 'or', 'the', 'a', 'an', 'for', 'to', 'in', 'at', 'with', 'on', 'by',
  ...SENIORITY_WORDS,
]);

/**
 * A head noun used by this many families or more is a GENERIC craft marker
 * rather than the name of a profession.
 *
 * Measured against config/role_families.json: `engineer` heads 8 families,
 * `analyst` and `manager` 11 each, while `nurse`, `accountant`, `chef` and
 * `electrician` head exactly one. The split is read from the taxonomy rather
 * than listed here, so adding a family cannot leave this stale.
 */
const GENERIC_HEAD_MIN_FAMILIES = 3;

/**
 * What a generic head noun says about the KIND of work, independent of field.
 *
 * Only the generic heads need an entry: a profession-specific head (nurse,
 * accountant, welder) is its own craft by definition, because nobody holds that
 * title while doing a different job. This is the distinction that keeps
 * "Analytics Manager" away from someone who asked for "Analytics Engineer"
 * while still offering "Nurse Practitioner" to a Registered Nurse.
 */
const GENERIC_HEAD_CRAFT = Object.freeze({
  engineer: 'build', architect: 'build', developer: 'build', designer: 'build',
  analyst: 'analyze',
  technician: 'operate', administrator: 'operate',
  // ONE class for the roles that RUN a function rather than build or analyze
  // for it. Coordinator, specialist, manager and director are the same kind of
  // work at four different LEVELS, and level is judged separately below — so
  // they belong together here and are told apart by `HEAD_LEVEL`. Splitting
  // them by craft instead would have said a Regulatory Affairs Specialist and a
  // Regulatory Affairs Manager do different jobs, which is plainly wrong.
  coordinator: 'coordinate', specialist: 'coordinate', associate: 'coordinate',
  manager: 'coordinate', director: 'coordinate', lead: 'coordinate', officer: 'coordinate',
});

/**
 * How senior a generic head noun is, on its own small ladder.
 *
 * Distinct from `SENIORITY_LEVELS`, which reads a PREFIX ("Senior", "Staff").
 * This reads the head noun itself, which is how a whole family of roles states
 * level without any prefix at all: Coordinator -> Specialist -> Manager ->
 * Director. Heads absent from this map are individual contributors and take
 * the default, so Engineer, Developer and Architect all compare equal.
 *
 * Without it, "Marketing Coordinator" and "Marketing Manager" read as the same
 * role, and a new graduate's personalized search offered them management jobs.
 */
const HEAD_LEVEL = Object.freeze({
  assistant: 1, associate: 1, coordinator: 1, clerk: 1,
  specialist: 2, analyst: 2, technician: 2,
  manager: 3, lead: 3,
  director: 4, officer: 4,
});

/** Level of an unranked head — an individual contributor. */
const DEFAULT_HEAD_LEVEL = 2;

/** How far apart two head levels may be and still be the same ask. */
const HEAD_LEVEL_BAND = 1;

let cached = null;

/**
 * Load the taxonomy from a project root, with an in-process cache.
 *
 * @param {string} root project root
 * @param {{reload?: boolean}} [options]
 * @returns {{families: object, weights: object}}
 */
export function loadRoleFamilies(root = DEFAULT_ROOT, { reload = false } = {}) {
  const path = join(root ?? DEFAULT_ROOT, ROLE_FAMILIES_FILE);
  if (!reload && cached && cached.path === path) return cached.taxonomy;
  if (!existsSync(path)) {
    // A missing taxonomy must never be fatal: every consumer treats an empty
    // one as "no family is known", which degrades to DEFER everywhere rather
    // than to a wrong accept or a wrong reject.
    const empty = { families: {}, weights: DEFAULT_WEIGHTS };
    cached = { path, taxonomy: empty };
    return empty;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const taxonomy = normalizeTaxonomy(parsed);
  cached = { path, taxonomy };
  return taxonomy;
}

/** Accept an already-parsed taxonomy object (tests, dashboard, injected config). */
export function normalizeTaxonomy(raw = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(raw.weights ?? {}) };
  const families = {};
  for (const [id, family] of Object.entries(raw.families ?? {})) {
    if (!family || typeof family !== 'object') continue;
    families[id] = {
      id,
      label: String(family.label ?? id),
      roles: cleanTerms(family.roles),
      heads: cleanTerms(family.heads),
      domain: cleanTerms(family.domain),
      skills: cleanTerms(family.skills),
    };
  }
  return { families, weights };
}

/** Normalize a list of taxonomy terms: lowercased, deduped, non-empty. */
function cleanTerms(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const term = normalizeText(raw);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * Do two role tokens refer to the same thing? Exact, or a shared prefix long
 * enough to be a morphological variant rather than a coincidence.
 */
export function tokensRelate(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length < TOKEN_PREFIX_MATCH || b.length < TOKEN_PREFIX_MATCH) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i >= TOKEN_PREFIX_MATCH;
}

/** Whole-word presence test against already-normalized text. */
function hasTerm(text, term) {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(text);
}

/** Normalize free text for matching: punctuation becomes space. */
export function matchText(value) {
  return normalizeText(value).replace(/[^a-z0-9+#/&.()-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A term's contribution: kind weight x word count, capped. */
function termScore(term, weight) {
  const words = Math.min(MAX_TERM_WORDS, term.split(/\s+/).length);
  return weight * words;
}

/**
 * Score every family against a piece of text.
 *
 * @param {string} text anything — a job title, a JD, a whole profile flattened
 * @param {object} taxonomy from `loadRoleFamilies`
 * @param {{kinds?: string[]}} [options] which term kinds to consider
 * @returns {Array<{id, label, score, matched: string[]}>} highest score first
 */
export function scoreFamilies(text, taxonomy = { families: {}, weights: DEFAULT_WEIGHTS }, { kinds } = {}) {
  const haystack = matchText(text);
  if (!haystack) return [];
  const use = kinds ?? ['roles', 'domain', 'skills', 'heads'];
  const weightOf = { roles: 'role', domain: 'domain', skills: 'skill', heads: 'head' };
  const out = [];
  for (const family of Object.values(taxonomy.families ?? {})) {
    let score = 0;
    const matched = [];
    for (const kind of use) {
      const weight = taxonomy.weights?.[weightOf[kind]] ?? DEFAULT_WEIGHTS[weightOf[kind]] ?? 1;
      for (const term of family[kind] ?? []) {
        if (!hasTerm(haystack, term)) continue;
        score += termScore(term, weight);
        matched.push(term);
      }
    }
    if (score > 0) out.push({ id: family.id, label: family.label, score, matched });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * The families a CANDIDATE belongs to.
 *
 * Deliberately inclusive — every family admitted here is one more family whose
 * postings will never be rejected, and the cost of an extra family is a few
 * deferred titles while the cost of a missing one is silent deletion.
 *
 * Intent outranks background. What someone is searching FOR decides which
 * postings are theirs; what they have DONE only reinforces it and can never be
 * the only thing consulted, or a career-changer's new field would score zero.
 *
 * @param {object} profile a normalized profile (see ./model.js) or a legacy
 *   candidate.json — both are read through the same field probes
 * @param {object} taxonomy
 * @returns {Array<{id, label, score, matched: string[], source: string}>}
 */
export function profileFamilies(profile = {}, taxonomy) {
  const intent = profile.searchIntent ?? {};
  const background = profile.background ?? {};

  // An explicitly chosen family is authoritative and skips inference entirely.
  const explicit = (intent.roleFamilies ?? []).filter((id) => taxonomy?.families?.[id]);
  if (explicit.length) {
    return explicit.map((id) => ({
      id, label: taxonomy.families[id].label, score: Infinity, matched: [], source: 'explicit',
    }));
  }

  const targetRoles = [...(intent.targetRoles ?? []), ...(profile.targetTitles ?? [])];
  const intentSkills = [...(intent.skillsToKeep ?? []), ...(intent.skillsToGrow ?? [])];
  const backgroundText = [
    ...(background.currentRoles ?? []), ...(background.earlierRoles ?? []),
    ...(background.skills ?? []), ...(background.industries ?? []),
    ...(background.certifications ?? []),
  ];
  // Legacy candidate.json carries the same evidence under different names.
  const legacyText = [
    ...flatten(profile.technicalStack), ...(profile.certifications ?? []),
    ...(profile.domainExperience ?? []),
  ];

  // Target roles are scored on their own and doubled, so a role the person
  // wants outweighs a long history in the field they are leaving.
  const fromIntent = scoreFamilies([...targetRoles, ...intentSkills].join(' . '), taxonomy);
  const fromBackground = scoreFamilies([...backgroundText, ...legacyText].join(' . '), taxonomy);

  const merged = new Map();
  const add = (rows, factor, source) => {
    for (const row of rows) {
      const prev = merged.get(row.id);
      const score = row.score * factor;
      if (prev) {
        prev.score += score;
        prev.matched = [...new Set([...prev.matched, ...row.matched])];
        if (!prev.source.includes(source)) prev.source += `+${source}`;
      } else {
        merged.set(row.id, { ...row, score, source });
      }
    }
  };
  add(fromIntent, 2, 'intent');
  add(fromBackground, 1, 'background');

  const rows = [...merged.values()].sort((a, b) => b.score - a.score);
  if (!rows.length) return [];
  const top = rows[0].score;
  return rows.filter((r) => r.score >= PROFILE_FAMILY_MIN && r.score >= top * PROFILE_FAMILY_RATIO);
}

/** Flatten a nested object/array of strings. */
function flatten(value, out = []) {
  if (!value) return out;
  if (typeof value === 'string') { if (value.trim()) out.push(value); return out; }
  if (Array.isArray(value)) { for (const v of value) flatten(v, out); return out; }
  if (typeof value === 'object') for (const v of Object.values(value)) flatten(v, out);
  return out;
}

/**
 * Which family does a POSTING TITLE belong to, and confidently enough to act on?
 *
 * @param {string} title
 * @param {object} taxonomy
 * @returns {{families: Array, confident: Array, top: object|null}}
 */
export function titleFamilies(title, taxonomy) {
  // Skills are included: "Databricks Architect" and "Epic Analyst" name no
  // domain word yet state their family unmistakably.
  const families = scoreFamilies(title, taxonomy);
  return {
    families,
    confident: families.filter((f) => f.score >= REJECT_CONFIDENCE),
    top: families[0] ?? null,
  };
}

/* ───────────────────────── title expansion ───────────────────────── */

/** Split a role into tokens, dropping punctuation. */
export function roleTokens(role) {
  return matchText(role).split(/\s+/).filter(Boolean);
}

/** Tokens that carry role identity — not seniority, not connectives. */
export function significantTokens(role) {
  return roleTokens(role).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** A role with any leading/trailing seniority words removed. */
export function stripSeniority(role) {
  const tokens = roleTokens(role);
  let start = 0;
  let end = tokens.length;
  while (start < end && SENIORITY_WORDS.has(tokens[start])) start += 1;
  while (end > start && SENIORITY_WORDS.has(tokens[end - 1])) end -= 1;
  const core = tokens.slice(start, end);
  return core.length ? core.join(' ') : tokens.join(' ');
}

/**
 * Acronyms that must stay upper-case when a normalized role is presented.
 *
 * These become literal search strings and dashboard labels, so "Bi Engineer"
 * is not merely ugly — it is the phrase that gets sent to a job board.
 */
export const ROLE_ACRONYMS = new Set([
  'BI', 'SQL', 'ETL', 'ELT', 'AI', 'ML', 'QA', 'QC', 'UX', 'UI', 'HR', 'IT',
  'SRE', 'DBA', 'CRM', 'ERP', 'SEO', 'SEM', 'API', 'VP', 'SVP', 'EVP', 'PMO',
  'CTO', 'CIO', 'CEO', 'CFO', 'COO', 'PM', 'GIS', 'NLP', 'LLM', 'AWS', 'GCP',
  'SAP', 'MDM', 'RN', 'LPN', 'NP', 'PA', 'EHR', 'EMR', 'ICU', 'ER', 'FP&A',
  'CPA', 'CFA', 'AML', 'KYC', 'GRC', 'SOC', 'IOS',
]);

/** Title-case a normalized role for display and for writing into a profile. */
export function presentRole(role, acronyms = ROLE_ACRONYMS) {
  return String(role ?? '').split(/\s+/).map((word) => {
    if (acronyms.has(word.toUpperCase())) return word.toUpperCase();
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

/** Rank of a seniority key on the ladder, or null. */
export function seniorityRank(key) {
  const found = SENIORITY_LEVELS.find((l) => l.key === normalizeText(key));
  return found ? found.rank : null;
}

/**
 * Split every head noun in the taxonomy into GENERIC craft markers and
 * PROFESSION-SPECIFIC names, by how many families use each one.
 *
 * @param {object} taxonomy
 * @returns {{generic: Set<string>, specific: Set<string>}}
 */
export function headIndex(taxonomy = { families: {} }) {
  const count = new Map();
  for (const def of Object.values(taxonomy.families ?? {})) {
    for (const head of def.heads ?? []) count.set(head, (count.get(head) ?? 0) + 1);
  }
  const generic = new Set();
  const specific = new Set();
  for (const [head, n] of count) {
    (n >= GENERIC_HEAD_MIN_FAMILIES ? generic : specific).add(head);
  }
  return { generic, specific };
}

/**
 * The craft a role belongs to: what KIND of work it is, not which field.
 *
 * A profession-specific head wins wherever it appears, so "Clinical Nurse
 * Specialist" is nursing rather than a generic `specialist`. Otherwise the
 * right-most generic head decides, which is where English puts the head noun
 * ("Data Platform Engineer" -> engineer -> build).
 *
 * @param {string} role a normalized, seniority-stripped role
 * @param {{generic: Set<string>, specific: Set<string>}} idx from `headIndex`
 * @returns {{craft: string|null, head: string}}
 */
export function craftOfRole(role, idx) {
  // READ THE ROLE AS WRITTEN, not seniority-stripped. `stripSeniority` removes
  // trailing level words, and several head nouns ARE level words — "Regulatory
  // Affairs Associate" strips to "regulatory affairs", which has no head at
  // all and would be classified as no craft and silently dropped.
  const tokens = roleTokens(role).filter((t) => t.length > 1);
  for (const token of tokens) {
    if (idx.specific.has(token)) {
      return { craft: `practice:${token}`, head: token, level: HEAD_LEVEL[token] ?? DEFAULT_HEAD_LEVEL };
    }
  }
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (idx.generic.has(tokens[i])) {
      return {
        craft: GENERIC_HEAD_CRAFT[tokens[i]] ?? `head:${tokens[i]}`,
        head: tokens[i],
        level: HEAD_LEVEL[tokens[i]] ?? DEFAULT_HEAD_LEVEL,
      };
    }
  }
  return { craft: null, head: tokens[tokens.length - 1] ?? '', level: DEFAULT_HEAD_LEVEL };
}

/**
 * Acronym <-> phrase equivalences the taxonomy states about itself.
 *
 * A family that lists both "business intelligence" and "bi" as domain terms is
 * declaring them the same thing, so a profile evidencing "Power BI" should be
 * offered "Business Intelligence Engineer". Derived rather than listed, so it
 * works for "master data management"/"mdm" and anything added later.
 *
 * @param {Array} families
 * @param {object} taxonomy
 * @returns {Map<string, string>}
 */
export function domainAcronyms(families = [], taxonomy = { families: {} }) {
  const terms = new Set();
  for (const family of families) {
    for (const term of taxonomy.families?.[family.id]?.domain ?? []) terms.add(term);
  }
  const pairs = new Map();
  for (const term of terms) {
    const words = term.split(/\s+/);
    if (words.length < 2) continue;
    const acronym = words.map((w) => w[0]).join('');
    if (terms.has(acronym)) { pairs.set(term, acronym); pairs.set(acronym, term); }
  }
  return pairs;
}

/**
 * Vocabulary the profile can actually EVIDENCE, from its own skills, history
 * and stated roles — never from the family at large.
 *
 * This is what stops a family's whole vocabulary from being treated as the
 * candidate's. Someone whose stack is Azure/Databricks/Power BI evidences "bi"
 * but not "machine learning", so "Machine Learning Engineer" is not one of
 * their adjacent roles even though it sits in the same family.
 *
 * @param {object} profile normalized profile or candidate config
 * @param {Array} families
 * @param {object} taxonomy
 * @returns {Set<string>}
 */
export function profileEvidence(profile = {}, families = [], taxonomy = { families: {} }) {
  const intent = profile.searchIntent ?? {};
  const background = profile.background ?? {};
  const blob = normalizeText([
    ...(intent.skillsToKeep ?? []), ...(intent.skillsToGrow ?? []),
    ...(intent.targetRoles ?? []), ...(profile.targetTitles ?? []),
    ...flattenStrings(background.skills), ...flattenStrings(profile.technicalStack),
    ...(background.industries ?? []), ...(profile.domainExperience ?? []),
    ...(background.certifications ?? []), ...(profile.certifications ?? []),
    ...(background.roles ?? []).map((r) => `${r?.title ?? ''} ${r?.summary ?? ''}`),
    ...(profile.workHistory ?? []).map((r) => `${r?.title ?? ''} ${r?.summary ?? ''}`),
  ].join(' '));

  const evidence = new Set();
  for (const family of families) {
    const def = taxonomy.families?.[family.id] ?? {};
    for (const term of [...(def.domain ?? []), ...(def.skills ?? [])]) {
      if (!hasTerm(blob, term)) continue;
      evidence.add(term);
      for (const word of term.split(/\s+/)) if (word.length > 1) evidence.add(word);
    }
  }
  return evidence;
}

/** Collect strings out of an array or an object-of-arrays. */
function flattenStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) flattenStrings(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) flattenStrings(v, out);
  return out;
}

/**
 * Expand target roles into the title variations an employer might actually use.
 *
 * This is the "role families -> title variations" step. It is uniform across
 * every field: a sibling role in one of the candidate's own families counts as
 * a variation when it shares a SIGNIFICANT token with one of their target
 * roles. No profession is special-cased.
 *
 *   Data Engineer              -> Data Analyst, Data Architect, Data Scientist,
 *                                 Data Platform Engineer, Analytics Engineer
 *   Regulatory Affairs Spec.   -> Regulatory Affairs Manager/Associate,
 *                                 Regulatory Submissions Manager
 *   Marketing Manager          -> Digital/Content/Product Marketing Manager,
 *                                 Brand Manager, Campaign Manager
 *
 * Seniority variants are generated from the DESIRED level, not the level in the
 * resume — someone targeting a step up must not be searched for at their
 * current level.
 *
 * @param {object} args
 * @param {string[]} args.targetRoles the roles the candidate wants
 * @param {Array} args.families the candidate's families (from `profileFamilies`)
 * @param {object} args.taxonomy
 * @param {string} [args.seniority] desired seniority key
 * @param {number} [args.maxVariations]
 * @returns {{roles: string[], bySource: object}} expanded roles, most relevant first
 */
export function expandRoleTitles({
  targetRoles = [], families = [], taxonomy = { families: {} },
  seniority = '', maxVariations = 40, profile = {},
} = {}) {
  const wanted = [...new Set(targetRoles.map((r) => stripSeniority(r)).filter(Boolean))];
  const wantedKeys = new Set(wanted);

  const idx = headIndex(taxonomy);
  const acronyms = domainAcronyms(families, taxonomy);
  const evidence = profileEvidence(profile, families, taxonomy);

  // WHAT THE CANDIDATE ACTUALLY ASKED FOR, in two parts.
  //
  // `wantedCrafts` is the KIND of work — build, analyze, lead, or one specific
  // practice. `targetSubjects` is the SUBJECT matter, with generic head nouns
  // held out: "engineer" is not subject matter, "data" is.
  // Craft and level are read from the roles AS TYPED, because both live in the
  // head noun and `wanted` has had its level words stripped.
  const wantedShapes = targetRoles.map((r) => craftOfRole(r, idx)).filter((s) => s.craft);
  const wantedCrafts = new Set(wantedShapes.map((s) => s.craft));
  const targetSubjects = new Set();
  for (const role of wanted) {
    for (const token of significantTokens(role)) {
      if (!idx.generic.has(token)) targetSubjects.add(token);
    }
  }

  /*
   * TWO TESTS, BOTH REQUIRED. A sibling in the candidate's own family is only
   * a variation of THEIR role when it matches on both axes.
   *
   * This replaced a single test — "shares any significant token with a target
   * role" — which was far too weak to carry the weight put on it. `targetTitles`
   * is what the title gate accepts on VERBATIM and decisively, so every entry
   * here becomes a first-class match. Measured on this profile, three stated
   * roles (Senior Data Engineer, Data Engineer, Analytics Engineer) expanded to
   * 23 titles, because one shared token was enough and "data" is shared by the
   * whole family: it admitted Data Coordinator, Data Steward, Database
   * Administrator, Quantitative Analyst, Reporting Analyst and Data Analyst —
   * junior, governance, ops and finance-quant roles that a senior data engineer
   * never asked for and which then flooded discovery.
   *
   *   1. CRAFT. A senior IC who asked to BUILD is not asking to analyze, to
   *      manage, or to administer. This is what separates Data Platform
   *      Engineer (build) from Analytics Manager (lead) and Data Analyst
   *      (analyze) without naming any of them.
   *   2. SUBJECT. At least one non-head token must be something the profile
   *      itself can evidence — shared with a stated role, present in their own
   *      skills, or the taxonomy's own acronym for one. This is what separates
   *      Data Warehouse Engineer from Machine Learning Engineer for someone who
   *      has never done ML: both build, only one is their subject.
   *
   * Symmetric by construction. A Registered Nurse gets Nurse Practitioner and
   * Clinical Nurse Specialist (same practice, evidenced subject) and not Case
   * Manager; a Marketing Manager gets Digital/Content/Product Marketing Manager
   * and not SEO Specialist.
   */
  const siblings = [];
  for (const family of families) {
    const def = taxonomy.families?.[family.id];
    if (!def) continue;
    for (const role of def.roles) {
      const core = stripSeniority(role);
      if (!core || wantedKeys.has(core)) continue;
      const tokens = significantTokens(core);
      // A one-token remnant is not a searchable role. Stripping seniority off
      // "Director of Product" leaves "product", which as a search phrase
      // matches every product-adjacent posting on the board.
      if (tokens.length < 2) continue;

      const shape = craftOfRole(role, idx);
      if (shape.craft === null || !wantedCrafts.has(shape.craft)) continue;
      // Same craft, but is it the same ASK? A Marketing Coordinator is not
      // asking to be a Marketing Manager, and offering it is the same failure
      // as offering a different field — a role they did not ask for, presented
      // as one they did. Level PREFIXES are handled separately, below.
      const sameLevel = wantedShapes.some(
        (w) => w.craft === shape.craft && Math.abs(w.level - shape.level) <= HEAD_LEVEL_BAND,
      );
      if (!sameLevel) continue;

      const subjects = tokens.filter((t) => !idx.generic.has(t));
      const reason = subjectEvidence(subjects, { targetSubjects, evidence, acronyms });
      if (!reason) continue;

      // Support ranks the survivors: how many of the stated roles this one
      // reads as a variation of.
      let support = 0;
      for (const want of wanted) {
        const wantTokens = new Set(significantTokens(want));
        if (subjects.some((s) => [...wantTokens].some((w) => tokensRelate(s, w)))) support += 1;
      }
      /*
       * KEEP THE HEAD NOUN IN THE TITLE.
       *
       * Several head nouns are also level words, so stripping the level strips
       * the head: "Regulatory Affairs Associate" becomes "Regulatory Affairs",
       * which names a department rather than a job and, as a title, matches
       * every posting the department ever files. When that happens the role as
       * WRITTEN is the honest variation, so use it.
       */
      const coreHasHead = significantTokens(core)
        .some((tok) => idx.generic.has(tok) || idx.specific.has(tok));
      siblings.push({
        role: coreHasHead ? core : normalizeText(role),
        support, family: family.id, reason,
      });
    }
  }
  siblings.sort((a, b) => b.support - a.support || a.role.localeCompare(b.role));

  const variations = [];
  const seen = new Set(wantedKeys);
  for (const { role } of siblings) {
    if (seen.has(role) || variations.length >= maxVariations) continue;
    seen.add(role);
    variations.push(role);
  }

  // Level variations of the target roles themselves, at the DESIRED level.
  const levelled = [];
  const rank = seniorityRank(seniority);
  if (rank !== null) {
    const band = SENIORITY_LEVELS.filter((l) => Math.abs(l.rank - rank) <= 1);
    for (const core of wanted) {
      for (const level of band) {
        for (const label of level.labels) {
          const variant = label ? `${normalizeText(label)} ${core}` : core;
          if (seen.has(variant)) continue;
          seen.add(variant);
          levelled.push(variant);
        }
      }
    }
  }

  /*
   * ANCHORS vs ADJACENT. The stated roles and their level variations are what
   * the candidate actually asked for; the family siblings are the ways an
   * employer might name the same work. Both are recognized, but only anchors
   * are decisive — see `classifyTitleFit` — and only anchors become search
   * PHRASES, so an adjacent title can never widen what is asked of a board.
   */
  const anchors = [...wanted, ...levelled];
  return {
    roles: [...wanted, ...variations, ...levelled],
    anchors,
    adjacent: variations,
    bySource: { targets: wanted, familySiblings: variations, seniorityVariants: levelled },
  };
}

/**
 * Can the profile evidence what this role is ABOUT?
 *
 * @param {string[]} subjects the role's non-head tokens
 * @param {{targetSubjects: Set<string>, evidence: Set<string>, acronyms: Map}} ctx
 * @returns {string|null} the reason it matched, or null
 */
function subjectEvidence(subjects, { targetSubjects, evidence, acronyms }) {
  for (const subject of subjects) {
    for (const want of targetSubjects) {
      if (tokensRelate(subject, want)) return `shared:${subject}`;
    }
    if (evidence.has(subject)) return `evidence:${subject}`;
    const alias = acronyms.get(subject);
    if (alias && evidence.has(alias)) return `alias:${subject}`;
  }
  // A multi-word subject the taxonomy abbreviates: "business intelligence"
  // is "bi", which a profile listing Power BI evidences.
  if (subjects.length > 1) {
    const alias = acronyms.get(subjects.join(' '));
    if (alias && evidence.has(alias)) return `alias:${subjects.join(' ')}`;
  }
  return null;
}

/* ───────────────────────── search queries ───────────────────────── */

/**
 * Build the free-text phrases discovery should actually send to a board.
 *
 * Boards narrow as tokens are added (measured on Workday's public CXS search:
 * "data" 115 hits, "data engineer" 51, a nine-word query 0), so the job is a
 * small SET COVER — the fewest phrases such that every target role shares a
 * phrase. That much was already true.
 *
 * What was wrong was how a phrase was CHOSEN: the trailing two tokens of the
 * title. That is right for "Senior Data Engineer" -> "data engineer" and wrong
 * for "Regulatory Affairs Specialist" -> "affairs specialist", which drops the
 * one word that identifies the field and keeps the one every field shares.
 *
 * So a phrase is now built around the FAMILY-IDENTIFYING term:
 *
 *   - the longest matching domain term of 2+ words IS the phrase, because a
 *     multi-word domain term is already both specific and level-agnostic
 *     ("regulatory affairs", "business intelligence", "supply chain")
 *   - a single-word domain term is too broad alone, so it takes the role's head
 *     noun with it ("data" + engineer -> "data engineer")
 *   - with no domain term matched, the trailing two tokens are used as before
 *
 * @param {object} args
 * @param {string[]} args.targetRoles
 * @param {Array} args.families candidate families
 * @param {object} args.taxonomy
 * @param {number} [args.maxTerms]
 * @returns {string[]} phrases, most valuable first
 */
export function buildSearchPhrases({ targetRoles = [], families = [], taxonomy = { families: {} }, maxTerms = 4 } = {}) {
  const cap = Number.isFinite(maxTerms) ? Math.max(0, Math.trunc(maxTerms)) : 4;
  if (cap === 0) return [];

  const roles = targetRoles.map((r) => stripSeniority(r)).filter(Boolean);
  if (!roles.length) return [];

  // Domain vocabulary drawn ONLY from the candidate's own families, longest
  // first so "regulatory affairs" is preferred over "regulatory".
  const domainTerms = [];
  for (const family of families) {
    for (const term of taxonomy.families?.[family.id]?.domain ?? []) domainTerms.push(term);
  }
  domainTerms.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length);

  // How central each token is across the target list — the tiebreak, so the
  // chosen phrase is the one most representative of what this person wants.
  const freq = new Map();
  for (const role of roles) {
    for (const token of new Set(significantTokens(role))) {
      freq.set(token, (freq.get(token) ?? 0) + 1);
    }
  }

  const entries = roles.map((role) => ({ role, tokens: new Set(significantTokens(role)) }))
    .filter((e) => e.tokens.size > 0);
  if (!entries.length) return [];

  const candidates = [];
  const seen = new Set();
  for (const { role } of entries) {
    const tokens = significantTokens(role);
    const phrase = phraseForRole(role, tokens, domainTerms);
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    candidates.push({
      phrase,
      tokens: new Set(phrase.split(/\s+/)),
      weight: phrase.split(/\s+/).reduce((s, t) => s + (freq.get(t) ?? 0), 0),
    });
  }

  const uncovered = new Set(entries.keys());
  const chosen = [];
  while (chosen.length < cap && uncovered.size) {
    let best = null;
    for (const c of candidates) {
      if (chosen.includes(c.phrase)) continue;
      let covers = 0;
      for (const i of uncovered) {
        if ([...c.tokens].some((t) => entries[i].tokens.has(t))) covers += 1;
      }
      if (covers === 0) continue;
      if (!best || covers > best.covers || (covers === best.covers && c.weight > best.c.weight)) {
        best = { c, covers };
      }
    }
    if (!best) break;
    chosen.push(best.c.phrase);
    for (const i of [...uncovered]) {
      if ([...best.c.tokens].some((t) => entries[i].tokens.has(t))) uncovered.delete(i);
    }
  }
  return chosen;
}

/** The phrase that best represents one role. See `buildSearchPhrases`. */
function phraseForRole(role, tokens, domainTerms) {
  const text = role;
  const domain = domainTerms.find((term) => hasTerm(text, term));
  if (domain) {
    const words = domain.split(/\s+/);
    if (words.length >= 2) return domain;
    const head = tokens[tokens.length - 1];
    if (head && head !== domain) return `${domain} ${head}`;
    return domain;
  }
  if (tokens.length <= 2) return tokens.join(' ');
  return tokens.slice(-2).join(' ');
}

/* ───────────────────────── the reject test ───────────────────────── */

/**
 * Is this posting title plausibly in the candidate's field?
 *
 * The one place the accept / defer / reject decision is made, so discovery, the
 * title gate and the dashboard can never disagree about it.
 *
 *   accept  the title carries the candidate's own family signal
 *   defer   the title says nothing decisive — KEEP IT, the description decides
 *   reject  the title confidently names a DIFFERENT family, and carries no
 *           subject-matter signal from the candidate's families at all
 *
 * The last clause is what keeps a cross-disciplinary role: "Lakehouse Platform
 * Engineer" is confidently an infrastructure title, but "lakehouse" is data
 * vocabulary, so a data candidate keeps it. HEAD NOUNS DO NOT COUNT as that
 * signal — "engineer", "analyst", "manager" and "administrator" are shared by
 * most families by design, and letting them spare a title kept "Accounts
 * Payable Administrator" for an engineer, which is the exact noise the gate
 * exists to remove.
 *
 * @param {string} title
 * @param {Array} families the candidate's families (from `profileFamilies`)
 * @param {object} taxonomy
 * @returns {{verdict: 'accept'|'defer'|'reject', signals: string[],
 *            titleFamily: string|null, profileFamily: string|null}}
 */
export function classifyTitleAgainstFamilies(title, families = [], taxonomy = { families: {} }) {
  const raw = String(title ?? '').trim();
  if (!raw) return { verdict: 'defer', signals: ['no-title'], titleFamily: null, profileFamily: null };

  const own = new Set(families.map((f) => f.id));
  if (!own.size) {
    // No family could be inferred for this candidate. Rejecting on that basis
    // would delete the whole board, so everything defers.
    return { verdict: 'defer', signals: ['no-profile-family'], titleFamily: null, profileFamily: null };
  }

  const scored = scoreFamilies(raw, taxonomy);
  const mine = scored.filter((f) => own.has(f.id));

  // Subject-matter signal for one of the candidate's families: a role phrase,
  // a domain term or a skill — never a head noun.
  const subjectMatter = scoreFamilies(raw, taxonomy, { kinds: ['roles', 'domain', 'skills'] })
    .filter((f) => own.has(f.id));

  if (subjectMatter.length) {
    const best = subjectMatter[0];
    const confident = scored.filter((f) => f.score >= REJECT_CONFIDENCE);
    const decisive = confident.find((f) => own.has(f.id));
    return {
      verdict: decisive || best.score >= REJECT_CONFIDENCE ? 'accept' : 'defer',
      signals: [`family:${best.id}`, ...best.matched.slice(0, 3).map((m) => `term:${m}`)],
      titleFamily: scored[0]?.id ?? null,
      profileFamily: best.id,
    };
  }

  const confidentOther = scored.find((f) => f.score >= REJECT_CONFIDENCE && !own.has(f.id));
  if (confidentOther) {
    return {
      verdict: 'reject',
      signals: [`other-family:${confidentOther.id}`, ...confidentOther.matched.slice(0, 2).map((m) => `term:${m}`)],
      titleFamily: confidentOther.id,
      profileFamily: null,
    };
  }

  return {
    verdict: 'defer',
    signals: mine.length ? [`weak-family:${mine[0].id}`] : ['unknown-title'],
    titleFamily: scored[0]?.id ?? null,
    profileFamily: mine[0]?.id ?? null,
  };
}
