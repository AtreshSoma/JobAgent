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
 * Reduce a single English word to its singular form.
 *
 * Screening patterns are matched as literal whole words, so "What is your
 * salary expectation?" answered correctly while "What are your salary
 * expectationS?" — the far more common phrasing on real forms — fell through to
 * `ask_user` and became a blocker that stopped an assisted run. Every such miss
 * is a stop, so this is a plausible contributor to the zero-submission rate.
 *
 * Deliberately conservative: it handles the regular cases and leaves anything
 * ambiguous alone. Over-stemming would make unrelated patterns collide, and a
 * wrong screening answer is far worse than an unanswered one.
 *
 * @param {string} word one lowercase token
 * @returns {string}
 */
export function singularize(word) {
  const w = String(word ?? '');
  // Too short to carry a safe plural rule ("is", "as", "gas", "its").
  if (w.length <= 3) return w;
  // Not plurals: class, status, analysis, various, previous.
  if (/(?:ss|us|is|ous)$/.test(w)) return w;
  // expectancies -> expectancy
  if (/[^aeiou]ies$/.test(w)) return `${w.slice(0, -3)}y`;
  // matches, boxes, buzzes, wishes -> match, box, buzz, wish
  if (/(?:ch|sh|s|x|z)es$/.test(w)) return w.slice(0, -2);
  // expectations -> expectation
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * Normalize text for pattern matching: lowercase, whitespace-collapsed, and
 * with every word reduced to its singular form.
 *
 * Applied to BOTH sides of a comparison so "salary expectations" and "salary
 * expectation" meet in the middle.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeForMatch(text) {
  return normalizeText(text)
    .split(' ')
    .map((token) => {
      // Keep punctuation attached to the token ("t-sql", "ci/cd") intact.
      const m = /^([a-z0-9]+)([^a-z0-9]*)$/.exec(token);
      return m ? singularize(m[1]) + m[2] : token;
    })
    .join(' ');
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
 * Whole-term presence in ALREADY-NORMALIZED text, compiled once per term.
 *
 * PERFORMANCE. `profileFit.js` and `roleFamilies.js` each had a private
 * `hasTerm` that built `new RegExp(...)` on every call. Title classification
 * tests ~1,257 taxonomy terms per title, twice, so one title cost ~930 µs and
 * sorting 150 titles inside a comparator cost ~1.2 s. Two changes, identical
 * semantics (boundary `[^a-z0-9]`, same as `compiledPhrasePattern`):
 *
 *   - a plain `includes` prefilter — a term that is not even a substring cannot
 *     match on a word boundary, and for a short title that is nearly every term;
 *   - the boundary regex is compiled once and memoized.
 *
 * @param {string} text normalized (lowercased) haystack
 * @param {string} term normalized needle
 * @returns {boolean}
 */
export function hasNormalizedTerm(text, term) {
  if (!term || !text) return false;
  if (!text.includes(term)) return false;
  return compiledPhrasePattern(term).test(text);
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
