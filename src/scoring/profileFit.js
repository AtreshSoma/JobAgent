/**
 * Profile-driven role fit — "could this posting plausibly be for me?"
 *
 * WHY THIS EXISTS. Discovery used a single boolean title gate whose default for
 * an unrecognized title was REJECT, applied BEFORE the job description was ever
 * fetched. That is the wrong default in the wrong place, for two reasons:
 *
 *  1. A title gate is a COST control, not a relevance judgement. Relevance is
 *     decided by the scorer, where the title is worth a small share of the
 *     total — the rest comes from stack, seniority, domain and keyword
 *     alignment that only the DESCRIPTION can supply.
 *  2. Employers do not name roles the way a job seeker searches for them.
 *
 * Measured against 55,293 already-scored postings, the old gate would have
 * rejected 14.8% of everything scoring 60-74 and 46.8% of everything scoring
 * 50-59. So a title resolves to one of THREE answers, and only `reject` drops a
 * posting:
 *
 *   accept  the title carries profile evidence — keep, and prefer it when a
 *           limited description budget is being spent
 *   defer   the title says nothing either way — KEEP IT, the description decides
 *   reject  the title positively names a different profession — drop it
 *
 * ── WHAT CHANGED, AND WHY IT HAD TO ─────────────────────────────────────────
 *
 * This file used to answer "is this in my field?" with vocabulary written for
 * ONE candidate: a hardcoded `DOMAIN_SEEDS` list of data/analytics words, and
 * three absolute reject lists (other professions, other business functions,
 * other engineering) that enumerated everything a data engineer is not.
 *
 * Both failed the moment a second person used the tool, and failed in BOTH
 * directions at once. Measured:
 *
 *   - a MARKETING profile ACCEPTED "ETL Developer", "Data Warehouse Engineer"
 *     and "Lakehouse Platform Engineer", because the data vocabulary was
 *     injected into every profile regardless of whose it was;
 *   - the same profile REJECTED "Brand Manager" ("marketing manager" and
 *     "brand manager" were on the other-business-functions list), and an
 *     ACCOUNTING profile REJECTED "Accounting Manager".
 *
 * So the previous candidate's adjacent roles were kept and the current
 * candidate's own were thrown away.
 *
 * The vocabulary now comes from `config/role_families.json` by way of the
 * candidate's OWN families (see src/profile/roleFamilies.js). The reject test
 * is symmetric: a title is dropped only when it confidently names a family the
 * candidate has no signal in. "Not data engineering" is not a reason; "a
 * different family from yours" is, whoever you are.
 *
 * EVERYTHING IS STILL DERIVED FROM THE PROFILE — `targetTitles`,
 * `technicalStack`, `domainExperience`, `seniority`. No employer names, no
 * hardcoded job titles, and no profession-specific branch anywhere below.
 */

import { normalizeText, hasNormalizedTerm } from '../utils/textNormalize.js';
import {
  loadRoleFamilies, profileFamilies, classifyTitleAgainstFamilies,
} from '../profile/roleFamilies.js';

/**
 * Role nouns — what a person IS. Deliberately includes leadership and advisory
 * nouns (lead/manager/director/head/principal/architect/consultant), because a
 * senior IC's next role is frequently titled with one of them.
 *
 * This list is profession-NEUTRAL: it is the set of words any field uses to
 * name the holder of a role, and it never decides which field a role is in.
 * That judgement belongs entirely to the family taxonomy.
 */
const ROLE_NOUNS = [
  'engineer', 'engineering', 'developer', 'architect', 'analyst', 'scientist',
  'consultant', 'specialist', 'administrator', 'programmer', 'modeler', 'modeller',
  'lead', 'manager', 'director', 'head', 'principal', 'staff', 'owner', 'expert',
  'associate', 'coordinator', 'supervisor', 'technician', 'officer', 'partner',
  'representative', 'advisor', 'strategist', 'planner', 'designer', 'researcher',
  'practitioner', 'assistant', 'nurse', 'therapist', 'accountant', 'auditor',
  'controller', 'attorney', 'counsel', 'writer', 'editor', 'producer', 'chef',
  'instructor', 'teacher', 'trainer', 'recruiter', 'buyer', 'agent', 'operator',
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
 * Every skill term the taxonomy recognizes, from any family.
 *
 * Used to decide whether a single word pulled out of a multi-word skill is
 * worth matching on its own. "Azure Data Factory" should match a title saying
 * "Azure" — `azure` is a technology the taxonomy knows. It must NOT match on
 * "data" or "factory", which are ordinary words, nor should "Microsoft Fabric"
 * match a bare "Fabric": measured, that one token matched "Senior Verification
 * Engineer - ARM Fabric Unit Level" (NVIDIA), "Hardware Network Fabric
 * Development Engineer" (HPE) and "Product Manager, Agent Fabric" (Salesforce)
 * — silicon interconnect and product names, not Microsoft Fabric.
 *
 * This replaced a hand-maintained blocklist of ~30 words that was itself
 * written from one stack ('fabric', 'delta', 'lake', 'onelake', 'gen2'), and
 * which no second user could have known to extend.
 */
function taxonomySkillTokens(taxonomy) {
  const tokens = new Set();
  for (const family of Object.values(taxonomy?.families ?? {})) {
    for (const skill of family.skills ?? []) {
      if (!skill.includes(' ')) tokens.add(skill);
    }
  }
  return tokens;
}

/**
 * Build the matching vocabulary for a candidate profile.
 *
 * Pure and memo-friendly: the same profile always yields the same vocabulary,
 * so callers can build it once per run.
 *
 * @param {object} candidate parsed config/candidate.json, OR a normalized
 *   profile from src/profile/model.js — both are read through the same probes
 * @param {object} [options]
 * @param {object} [options.taxonomy] injected role families (tests, dashboard)
 * @param {string} [options.root] project root to load the taxonomy from
 * @returns {{domain: string[], tech: string[], titles: string[],
 *            families: Array, taxonomy: object, seniority: number}}
 */
export function buildProfileVocabulary(candidate = {}, { taxonomy, root } = {}) {
  const tax = taxonomy ?? loadRoleFamilies(root);
  const titles = (candidate.targetTitles ?? candidate.searchIntent?.targetRoles ?? [])
    .map((t) => normalizeText(t)).filter(Boolean);

  const families = profileFamilies(candidate, tax);

  // DOMAIN WORDS COME FROM THE CANDIDATE'S OWN FAMILIES, not from a seed list.
  //
  // Seniority and role words must NOT leak in here. Target titles contain
  // "Senior", "Lead" and role nouns, and admitting them made the domain test
  // fire on any title containing the word "senior" — which accepted "Senior
  // Quality Engineer - Automation Engineering" as a data role.
  const domain = new Set();
  for (const family of families) {
    for (const term of tax.families?.[family.id]?.domain ?? []) domain.add(term);
  }
  for (const t of titles) {
    for (const word of t.split(/[^a-z0-9+#]+/)) {
      if (word.length <= 2) continue;
      if (ROLE_NOUNS.includes(word)) continue;
      if (SENIORITY_WORDS.has(word)) continue;
      domain.add(word);
    }
  }
  for (const d of candidate.domainExperience ?? candidate.background?.industries ?? []) {
    const norm = normalizeText(d);
    // Industry experience ("Insurance", "Government Reporting") describes WHERE
    // the work was, not what the role is. As a gate term it would accept every
    // insurance job on the board, so multi-word industries only.
    if (norm && norm.split(/\s+/).length > 1) domain.add(norm);
  }

  // Technologies: the whole phrase always, plus any single token that the
  // taxonomy itself recognizes as a technology name (see taxonomySkillTokens).
  const knownTokens = taxonomySkillTokens(tax);
  const tech = new Set();
  const stackSource = candidate.technicalStack ?? {
    keep: candidate.searchIntent?.skillsToKeep,
    background: candidate.background?.skills,
    grow: candidate.searchIntent?.skillsToGrow,
  };
  for (const term of flattenTerms(stackSource)) {
    const clean = term.replace(/\(.*?\)/g, '').trim();
    if (clean.length > 1) tech.add(clean);
    if (!clean.includes(' ')) continue;
    for (const token of clean.split(/[^a-z0-9+#.]+/)) {
      if (token.length >= 3 && knownTokens.has(token)) tech.add(token);
    }
  }
  for (const cert of candidate.certifications ?? candidate.background?.certifications ?? []) {
    const m = /\b(dp|az|pl|da|ai|ms)-?\d{3}\b/i.exec(String(cert));
    if (m) tech.add(m[0].toLowerCase());
  }

  /*
   * ANCHOR vs ADJACENT TITLES.
   *
   * `anchorTitles` are the roles the candidate stated plus their level
   * variations; `adjacentTitles` are family siblings a profile-aware expansion
   * judged to be the same work under a different name (src/profile/derive.js).
   *
   * They must not weigh the same. Rule 1 below returns `accept` on a verbatim
   * title match and returns it DECISIVELY — before the stack, domain and family
   * tests run — so whatever lands in this list is, in effect, an unconditional
   * pass. When one undifferentiated list held both, every sibling the taxonomy
   * offered became an unconditional pass too, and "personalized search" quietly
   * meant "anything in my field".
   *
   * A candidate.json with neither key (hand-written, or written before this
   * split existed) treats every target title as an anchor, which is exactly the
   * old behavior.
   */
  const anchors = (candidate.anchorTitles ?? [])
    .map((t) => normalizeText(t)).filter(Boolean);
  const adjacent = (candidate.adjacentTitles ?? [])
    .map((t) => normalizeText(t)).filter(Boolean);
  const anchorTitles = anchors.length ? anchors : titles.filter((t) => !adjacent.includes(t));

  return {
    domain: [...domain],
    tech: [...tech],
    titles,
    anchorTitles,
    adjacentTitles: adjacent,
    families,
    taxonomy: tax,
    seniority: seniorityRank(candidate.seniority ?? candidate.searchIntent?.seniority ?? 'senior'),
  };
}

/** candidate object -> vocabulary built from the default taxonomy. */
const VOCAB_BY_CANDIDATE = new WeakMap();

/**
 * The vocabulary for a candidate, built ONCE per candidate object.
 *
 * Adapters built it per tenant / per board (Workday: once for each of 200+
 * tenants), and every fresh vocabulary object also defeats the per-vocabulary
 * title memo below. Keyed on the candidate object with a WeakMap, so loading a
 * new config yields a new vocabulary and the old one is collectable.
 *
 * @param {object|null} candidate
 * @returns {object|null}
 */
export function profileVocabularyFor(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  let vocab = VOCAB_BY_CANDIDATE.get(candidate);
  if (!vocab) {
    vocab = buildProfileVocabulary(candidate);
    VOCAB_BY_CANDIDATE.set(candidate, vocab);
  }
  return vocab;
}

/**
 * Rank a list best-first by `titleFitPriority`, computing each priority ONCE.
 *
 * Calling the priority inside the sort comparator ran it O(n log n) times:
 * measured 150 titles sorted in ~1,033 ms that way versus ~100 ms precomputed.
 * Stable, so ties keep input order exactly as `Array#sort` did before.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} titleOf
 * @param {object} vocab
 * @returns {T[]} a new array
 */
export function sortByTitleFit(items, titleOf, vocab) {
  return items
    .map((item, i) => ({ item, i, p: titleFitPriority(titleOf(item), vocab) }))
    .sort((a, b) => (b.p - a.p) || (a.i - b.i))
    .map((d) => d.item);
}

/**
 * Whole-word presence test against already-normalized text — precompiled and
 * substring-prefiltered (see `hasNormalizedTerm`); it used to build a new
 * RegExp per term per call.
 */
function hasTerm(text, term) {
  return hasNormalizedTerm(text, term);
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
  // MEMOIZED per (vocabulary, title). The same titles are classified by the
  // adapter title gate, the detail-budget ranking, discovery and the pipeline
  // within one run — measured ~610 µs each before the matcher was precompiled.
  // The verdict is pure in (title, vocab); every caller gets its own copy of
  // `signals`, so one that mutates it cannot poison the cache.
  const cacheable = vocab && typeof vocab === 'object';
  const key = String(title ?? '');
  let memo = cacheable ? TITLE_FIT_MEMO.get(vocab) : null;
  if (cacheable && !memo) {
    memo = new Map();
    TITLE_FIT_MEMO.set(vocab, memo);
  }
  const hit = memo?.get(key);
  if (hit) return { verdict: hit.verdict, signals: [...hit.signals] };
  const result = classifyTitleFitUncached(title, vocab);
  if (memo) {
    // Bounded, so a long-lived process (the dashboard) cannot grow without limit.
    if (memo.size >= TITLE_FIT_MEMO_LIMIT) memo.clear();
    memo.set(key, { verdict: result.verdict, signals: [...result.signals] });
  }
  return result;
}

/** vocab object -> (title -> verdict). A WeakMap: a new config frees the old. */
const TITLE_FIT_MEMO = new WeakMap();

/** Distinct titles remembered per vocabulary before the memo is reset. */
const TITLE_FIT_MEMO_LIMIT = 20_000;

function classifyTitleFitUncached(title, vocab) {
  const raw = String(title ?? '').trim();
  if (!raw) return { verdict: 'defer', signals: ['no-title'] };
  // Normalize punctuation to spaces so an en dash, comma or slash can never
  // break a match. The old regex used a literal character class that excluded
  // the en dash, which alone cost every title written "BI – Reporting Engineer".
  const t = normalizeText(raw).replace(/[^a-z0-9+#]+/g, ' ').trim();
  const signals = [];

  // 1. A title the candidate ASKED FOR, verbatim, is decisive.
  for (const want of vocab.anchorTitles ?? vocab.titles ?? []) {
    if (want && t.includes(want)) { signals.push(`title:${want}`); return { verdict: 'accept', signals }; }
  }

  // 1b. An ADJACENT title — the same work under a name the candidate did not
  //     state — is accepted, but recorded as adjacent so the description budget
  //     and the scorer can both rank it below a role that was actually asked
  //     for. It still has to survive the family test below, which a stated
  //     title bypasses: an adjacent match is evidence, not a verdict.
  for (const want of vocab.adjacentTitles ?? []) {
    if (want && t.includes(want)) { signals.push(`title-adjacent:${want}`); break; }
  }

  // 2. A technology, tool or credential from the candidate's OWN profile is a
  //    strong signal on its own — "Databricks Senior Architect" and "Epic
  //    Analyst" name no domain word and no target title, yet each is
  //    unmistakably in profile for the person who listed that tool.
  const techHit = (vocab.tech ?? []).find((term) => hasTerm(t, term));
  if (techHit) { signals.push(`tech:${techHit}`); return { verdict: 'accept', signals }; }

  // 3. A domain word from one of the candidate's families plus any role noun,
  //    in EITHER order. Order-dependence is what made the old regex miss
  //    "Engineer, IT Data" and "Lead, Analytics".
  const domainHit = (vocab.domain ?? []).find((term) => hasTerm(t, term));
  const roleHit = ROLE_NOUNS.find((noun) => hasTerm(t, noun));
  if (domainHit && roleHit) {
    signals.push(`domain:${domainHit}`, `role:${roleHit}`);
    return { verdict: 'accept', signals };
  }

  // 4. Positively a DIFFERENT occupational family, with no signal from any of
  //    the candidate's families to redeem it. Symmetric by construction: the
  //    same test, run against whichever families this candidate belongs to.
  const family = classifyTitleAgainstFamilies(raw, vocab.families ?? [], vocab.taxonomy ?? { families: {} });
  if (family.verdict === 'reject') return { verdict: 'reject', signals: family.signals };
  if (family.verdict === 'accept') return { verdict: 'accept', signals: [...signals, ...family.signals] };

  // 4b. An adjacent title that reached here named the candidate's own work
  //     under another name and nothing contradicted it — accept, carrying the
  //     `title-adjacent:` signal that ranks it below a stated role.
  if (signals.some((s) => s.startsWith('title-adjacent:'))) {
    return { verdict: 'accept', signals };
  }

  // 5. Unknown. NOT a rejection — the description decides.
  if (domainHit) signals.push(`domain:${domainHit}`);
  if (roleHit) signals.push(`role:${roleHit}`);
  return { verdict: 'defer', signals: signals.length ? signals : family.signals };
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
  // Among accepts, a role the candidate ASKED FOR outranks everything. An
  // adjacent title — the same work under a name they did not state — sits
  // between a bare technology mention and a stated role, so a limited
  // description budget is always spent on stated roles first.
  if (signals.some((s) => s.startsWith('title:'))) return 4;
  if (signals.some((s) => s.startsWith('title-adjacent:'))) return 3;
  if (signals.some((s) => s.startsWith('tech:'))) return 2;
  return 1;
}

/**
 * Evidence of scope and ownership, read from the full posting.
 *
 * Scope was represented nowhere in scoring — a role that says "own the data
 * platform roadmap and mentor engineers" ranked identically to one that says
 * "write SQL to spec". This is deliberately evidence-based: each signal names
 * the phrase that produced it, so a reader can audit why a job ranked where it
 * did. The vocabulary is generic English about responsibility, so it reads the
 * same way for a nurse manager or a marketing director as for an engineer.
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

  const ownership = /\b(own(s|ership)?|architect|design|build out|stand up|establish|drive)\b[\w\s]{0,40}\b(platform|architecture|pipeline|warehouse|lakehouse|roadmap|strategy|framework|program|portfolio|function)\b/.test(body);
  if (ownership) signals.push('platform-ownership');

  const techHits = (vocab.tech ?? []).filter((term) => hasTerm(both, term));
  const domainHits = (vocab.domain ?? []).filter((term) => hasTerm(both, term));

  return {
    leadership,
    ownership,
    seniorityRank: seniorityRank(job.title),
    techHits,
    domainHits,
    signals,
  };
}
