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
 * Case-insensitive substring containment.
 * @param {unknown} haystack
 * @param {unknown} needle
 * @returns {boolean}
 */
export function containsPhrase(haystack, needle) {
  const h = normalizeText(haystack);
  const n = normalizeText(needle);
  if (!n) return false;
  return h.includes(n);
}

/**
 * Return the subset of phrases that appear in the text (normalized).
 * @param {unknown} text
 * @param {string[]} phrases
 * @returns {string[]} matched phrases (original casing preserved)
 */
export function matchedPhrases(text, phrases) {
  const h = normalizeText(text);
  if (!h || !Array.isArray(phrases)) return [];
  return phrases.filter((p) => {
    const n = normalizeText(p);
    return n.length > 0 && h.includes(n);
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
