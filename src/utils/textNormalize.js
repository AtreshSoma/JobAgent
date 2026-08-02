/**
 * Text normalization helpers used by dedup, exclusion matching, and filenames.
 * All functions are pure and deterministic.
 */

/**
 * Lowercase, collapse whitespace, and trim. Returns '' for nullish input.
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collapse a string to alphanumeric tokens joined by single spaces.
 * Useful for fuzzy-but-deterministic comparison of titles/companies.
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeLoose(text) {
  return normalizeText(text)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Slugify text for safe filenames: lowercase, non-alphanumerics to underscores.
 * @param {unknown} text
 * @param {number} [maxLength=60]
 * @returns {string}
 */
export function slugify(text, maxLength = 60) {
  const slug = normalizeText(text)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return slug.slice(0, maxLength).replace(/_+$/g, '') || 'untitled';
}

/**
 * True when `needle` appears as a whole word/phrase inside `haystack` —
 * "race" must match "Race/Ethnicity" but never "embrace". Falls back to plain
 * containment only if the needle produces an invalid regex.
 * @param {unknown} haystack
 * @param {unknown} needle
 * @returns {boolean}
 */
export function wholeWordIn(haystack, needle) {
  const h = String(haystack ?? '');
  const n = String(needle ?? '').trim();
  if (!n) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try { return new RegExp(`\\b${esc}\\b`, 'i').test(h); } catch { return h.includes(n); }
}

/**
 * Compiled, boundary-aware pattern for one normalized phrase, memoized so a
 * keyword vocabulary reused across thousands of jobs (scoring, exclusion
 * filtering, discovery) is compiled once, not once per job.
 *
 * REGRESSION GUARD. Matching used to be plain substring containment
 * (`haystack.includes(needle)`), which silently matched short acronym
 * keywords inside unrelated words — e.g. the keyword "sql" matched inside
 * "NoSQL" (a JD explicitly rejecting SQL still credited it), and "elt"
 * (Extract-Load-Transform) matched inside "felt"/"belt". Verified live before
 * this fix. `tailor.py`'s `_phrase_pattern` already solved this on the resume
 * side with a boundary-aware regex; this ports the IDENTICAL rule to JS so
 * scoring, exclusion filtering, and tailoring can no longer disagree about
 * whether a term is actually present.
 *
 * The boundary is `[a-z0-9]`, not `\w` (which also includes `_`) and not
 * plain `\b` (which treats `_` as a word character and would still misfire on
 * e.g. "under_score"-shaped tokens) — this is deliberately the same boundary
 * `tailor.py` uses, so a multi-word phrase or one containing tech punctuation
 * ("t-sql", "ci/cd", "power bi") still matches correctly at its edges while a
 * short acronym cannot hide inside a longer alphanumeric word.
 * @param {string} normalizedPhrase already lowercased/whitespace-collapsed
 * @returns {RegExp}
 */
const phrasePatternCache = new Map();
function compiledPhrasePattern(normalizedPhrase) {
  let re = phrasePatternCache.get(normalizedPhrase);
  if (re) return re;
  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  re = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`);
  phrasePatternCache.set(normalizedPhrase, re);
  return re;
}

/**
 * Case-insensitive, boundary-aware phrase containment (see
 * `compiledPhrasePattern` for why this is not plain substring matching).
 * @param {unknown} haystack
 * @param {unknown} needle
 * @returns {boolean}
 */
export function containsPhrase(haystack, needle) {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  if (!n) return false;
  return compiledPhrasePattern(n).test(h);
}

/**
 * Return the subset of phrases that appear in the text (normalized, boundary-
 * aware — see `compiledPhrasePattern`).
 * @param {unknown} text
 * @param {string[]} phrases
 * @returns {string[]} matched phrases (original casing preserved)
 */
export function matchedPhrases(text, phrases) {
  const h = normalizeText(text);
  if (!h || !Array.isArray(phrases)) return [];
  return phrases.filter((p) => {
    const n = normalizeText(p);
    return n.length > 0 && compiledPhrasePattern(n).test(h);
  });
}

/**
 * Build a stable dedup key from company + title + optional source job id.
 * @param {{company?: string, title?: string, sourceJobId?: string}} job
 * @returns {string}
 */
export function dedupKey(job = {}) {
  const company = normalizeLoose(job.company);
  const title = normalizeLoose(job.title);
  const id = normalizeText(job.sourceJobId);
  return [company, title, id].filter(Boolean).join('::');
}
