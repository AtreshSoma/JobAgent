/**
 * Title-phrase matching for title-bound scoring categories (titleFit).
 *
 * WHY THIS EXISTS. titleFit asked one question — does a target title appear
 * VERBATIM in the job title — through the same boundary-aware phrase matcher the
 * description keywords use. Titles are not written that way. Measured on the
 * live corpus against a profile targeting "Data Engineer", "Senior Data
 * Engineer", "Data Architect" and "Data Platform Engineer":
 *
 *   "Principal Engineer Data Engineering"                    (Verizon)    0/18
 *   "Head of Financial Crimes Data Engineering"              (TD)         0/18
 *   "Specialist Solutions Architect - Data Engineering"      (Databricks) 0/18
 *
 * all scored ZERO title points, because "data engineering" is not "data
 * engineer" and "Engineer, Data" is not "Data Engineer". A category worth 18 of
 * the profile's points was blind to the most common ways its own roles are
 * titled.
 *
 * WHAT CHANGED — TWO CONSERVATIVE RULES, TITLE MATCHING ONLY.
 *
 * 1. Morphology, on both sides. Role-noun plurals fold to the singular
 *    ("engineers" -> "engineer"), and the discipline form folds to the role
 *    noun ("engineering" -> "engineer", "architecture" -> "architect") ONLY in
 *    role-noun position — i.e. not when the next word names a different job
 *    (recruiter, sales, program, project ...). "Data Engineering Recruiter" is a
 *    recruiter; "Data Engineering Manager" still manages data engineering.
 *
 * 2. Order-insensitive role core. "Engineer, Data" and "Software Engineer, Data
 *    Platform" are the head noun followed by its modifiers. A target's core
 *    (seniority stripped, e.g. "data platform engineer") matches when the title
 *    has the head noun immediately followed by the modifiers, AND the modifiers
 *    END there — at the end of the title, at punctuation, or before a word that
 *    continues the same subject (platform, infrastructure, pipelines ...). That
 *    last condition is the precision guard: "Engineer, Data Center" and
 *    "Engineer - Data Entry" are not data engineers.
 *
 * The literal matcher still runs first, so this is a strict superset of the old
 * behaviour: nothing that matched before stops matching.
 *
 * Changing these rules changes stored verdicts, so `TITLE_MATCH_VERSION` is part
 * of the scoring fingerprint (src/scoring/fingerprint.js) — bump it whenever the
 * semantics here change so the corpus is re-scored rather than left stale.
 */

import { matchedPhrases } from '../utils/textNormalize.js';

/**
 * Version of the title-matching semantics. Bumped from the implicit 1 (literal
 * phrase containment) when morphology + order-insensitive cores were added.
 */
export const TITLE_MATCH_VERSION = 2;

/** Role-noun plurals folded to the singular. A closed list, not a stemmer. */
const PLURALS = new Map([
  ['engineers', 'engineer'], ['developers', 'developer'], ['architects', 'architect'],
  ['analysts', 'analyst'], ['scientists', 'scientist'], ['administrators', 'administrator'],
  ['consultants', 'consultant'], ['specialists', 'specialist'], ['managers', 'manager'],
  ['programmers', 'programmer'], ['modelers', 'modeler'],
]);

/**
 * Discipline -> role noun, applied only in role-noun position (see
 * `NOT_THIS_ROLE`). "analytic" is folded to "analytics" because the two are
 * used interchangeably in titles ("Analytic Engineer"); "analytical" is left
 * alone — it is an adjective, not the field.
 */
const DISCIPLINES = new Map([
  ['engineering', 'engineer'],
  ['architecture', 'architect'],
  ['analytic', 'analytics'],
]);

/**
 * Words that, directly after a discipline word, make the TITLE a different job:
 * "Data Engineering Recruiter", "Data Architecture Program Manager". In those
 * the discipline word is an attribute of someone else's role and must not fold
 * into a role noun.
 */
const NOT_THIS_ROLE = new Set([
  'recruiter', 'recruiting', 'recruitment', 'talent', 'sales', 'account', 'marketing',
  'program', 'programme', 'project', 'coordinator', 'assistant', 'administrator',
  'administrative', 'writer', 'instructor', 'teacher', 'trainer', 'professor',
  'faculty', 'student', 'partner',
]);

/**
 * Words that may follow a reordered core and still describe the same subject:
 * "Software Engineer, Data Platform", "Engineer, Data Pipelines". Anything else
 * directly after the modifiers ("Data Center", "Data Entry", "Data Scientist")
 * is a different compound noun and blocks the reordered match.
 */
const CORE_CONTINUATIONS = new Set([
  'platform', 'platforms', 'infrastructure', 'engineer', 'pipeline', 'pipelines',
  'integration', 'integrations', 'warehouse', 'warehousing', 'lake', 'lakehouse',
  'products', 'services', 'systems', 'team', 'teams',
]);

/**
 * Qualifiers that, directly before the head noun, name a different craft:
 * "Sales Engineer - Data", "Site Reliability Engineer, Data Platform",
 * "Machine Learning Engineer, Data Infrastructure". Measured on the discarded
 * corpus these were the bulk of the reordered false positives, so a reordered
 * core is never credited behind one of them.
 */
const OTHER_CRAFT_QUALIFIERS = new Set([
  'sales', 'presales', 'support', 'reliability', 'sre', 'test', 'qa', 'quality',
  'network', 'hardware', 'field', 'security', 'production', 'backline', 'learning',
  'ml', 'ai', 'backend', 'frontend', 'front', 'stack', 'fullstack', 'mobile', 'ios',
  'android', 'devops', 'customer', 'integration', 'embedded', 'firmware',
  'service', 'compliance', 'cybersecurity', 'technologies',
]);

/**
 * A title whose OWN role is something else — a product manager, recruiter or
 * salesperson working on data engineering — gets no folded or reordered credit
 * ("Sr. Product Manager, Data Engineering"). Literal matches are unaffected.
 */
const OTHER_ROLE_TITLE = new RegExp([
  '\\b(?:product|program|programme|project|delivery)\\s+(?:manager|owner|lead|director)\\b',
  '\\brecruit', '\\bpre-?sales\\b', '\\bsales\\b', '\\baccount\\s+(?:executive|manager)\\b',
  '\\btechnical\\s+writer\\b', '\\baudit\\b', '\\bdeveloper\\s+relations\\b', '\\bmarketing\\b',
  '\\bcompliance\\b', '\\b(?:cyber\\s?)?security\\s+(?:architect|engineer|analyst)\\b',
].join('|'));

/** Level words stripped to find a target's role core. */
const LEVEL_WORDS = new Set([
  'senior', 'sr', 'junior', 'jr', 'lead', 'staff', 'principal', 'associate',
  'entry', 'mid', 'level', 'i', 'ii', 'iii', 'iv', 'v',
]);

/** Level aliases, so "Sr. Engineer, Data" satisfies "Senior Data Engineer". */
const LEVEL_ALIASES = new Map([['sr', 'senior'], ['jr', 'junior']]);

/**
 * A space between two tokens is a plain join; anything else that is not a bare
 * intra-word hyphen ("data-engineer") is a boundary: ", " " - " " / " "(".
 */
const SOFT_JOIN = /^(?:\s+|-)$/;

/**
 * Tokenize and fold a title (or a target phrase) for matching.
 *
 * @param {unknown} text
 * @returns {{tokens: string[], breakBefore: boolean[]}} folded tokens, and for
 *   each token whether punctuation separates it from the previous one
 */
export function foldTitle(text) {
  // "&" is read as the word "and" so "Data & AI" and "Data and AI" fold alike —
  // and so a coordinated compound can block a reordered core (see below).
  const raw = String(text ?? '').toLowerCase().replace(/&/g, ' and ');
  const re = /[a-z0-9]+/g;
  const words = [];
  const breakBefore = [];
  let last = -1;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const gap = last < 0 ? '' : raw.slice(last, m.index);
    breakBefore.push(last >= 0 && !SOFT_JOIN.test(gap));
    words.push(m[0]);
    last = m.index + m[0].length;
  }
  const tokens = words.map((w, i) => {
    const plural = PLURALS.get(w);
    if (plural) return plural;
    const role = DISCIPLINES.get(w);
    if (role && !(NOT_THIS_ROLE.has(words[i + 1]) && !breakBefore[i + 1])) return role;
    return w;
  });
  return { tokens, breakBefore };
}

/** Compiled target phrases, memoized: the same ~15 titles judge every job. */
const PHRASE_CACHE = new Map();

/**
 * @param {string} phrase a target title
 * @returns {{folded: string[], levels: string[], head: string|null, mods: string[]}}
 */
function compilePhrase(phrase) {
  let compiled = PHRASE_CACHE.get(phrase);
  if (compiled) return compiled;
  const { tokens } = foldTitle(phrase);
  const levels = [];
  const core = [];
  for (const t of tokens) {
    if (LEVEL_WORDS.has(t) && core.length === 0) levels.push(LEVEL_ALIASES.get(t) ?? t);
    else core.push(t);
  }
  compiled = {
    folded: tokens,
    levels,
    head: core.length >= 2 ? core[core.length - 1] : null,
    mods: core.length >= 2 ? core.slice(0, -1) : [],
  };
  if (PHRASE_CACHE.size > 5000) PHRASE_CACHE.clear();
  PHRASE_CACHE.set(phrase, compiled);
  return compiled;
}

/** Does `seq` occur contiguously in `tokens`, with no punctuation break inside? */
function containsRun(tokens, breakBefore, seq) {
  if (!seq.length || seq.length > tokens.length) return false;
  outer: for (let i = 0; i + seq.length <= tokens.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) {
      if (tokens[i + j] !== seq[j]) continue outer;
      if (j > 0 && breakBefore[i + j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Head noun followed by the modifiers ("engineer, data platform"), ending at a
 * boundary or a same-subject continuation. See CORE_CONTINUATIONS.
 */
function containsReorderedCore(tokens, breakBefore, head, mods) {
  const n = mods.length;
  for (let i = 0; i + n < tokens.length; i += 1) {
    if (tokens[i] !== head) continue;
    if (i > 0 && !breakBefore[i] && OTHER_CRAFT_QUALIFIERS.has(tokens[i - 1])) continue;
    let ok = true;
    for (let j = 0; j < n; j += 1) {
      const at = i + 1 + j;
      if (tokens[at] !== mods[j] || (j > 0 && breakBefore[at])) { ok = false; break; }
    }
    if (!ok) continue;
    const next = i + 1 + n;
    // "Data & AI", "Data and Insights": a coordinated compound is a different,
    // broader subject — not the role core.
    if (tokens[next] === 'and') continue;
    if (next >= tokens.length || breakBefore[next] || CORE_CONTINUATIONS.has(tokens[next])) return true;
  }
  return false;
}

/**
 * The target phrases a job title satisfies.
 *
 * @param {unknown} title the job title
 * @param {string[]} phrases target titles (original casing is preserved in the result)
 * @returns {string[]}
 */
export function matchedTitlePhrases(title, phrases) {
  if (!Array.isArray(phrases) || !phrases.length) return [];
  const literal = new Set(matchedPhrases(title, phrases));
  const { tokens, breakBefore } = foldTitle(title);
  if (!tokens.length || OTHER_ROLE_TITLE.test(String(title ?? '').toLowerCase())) {
    return phrases.filter((p) => literal.has(p));
  }
  let present = null;
  return phrases.filter((phrase) => {
    if (literal.has(phrase)) return true;
    if (typeof phrase !== 'string' || !phrase.trim()) return false;
    const p = compilePhrase(phrase);
    if (containsRun(tokens, breakBefore, p.folded)) return true;
    if (!p.head) return false;
    if (!containsReorderedCore(tokens, breakBefore, p.head, p.mods)) return false;
    // A level-qualified target ("Senior Data Engineer") is only credited when
    // the title states that level too; its bare core is a separate target.
    if (!p.levels.length) return true;
    present ??= new Set(tokens.map((t) => LEVEL_ALIASES.get(t) ?? t));
    return p.levels.every((l) => present.has(l));
  });
}
