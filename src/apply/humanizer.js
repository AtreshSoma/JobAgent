/**
 * Deterministic text humanizer (JS side, for cover letters).
 *
 * Applies config/humanizer_patterns.json: removes banned phrases, replaces
 * banned characters (em/en dashes and smart quotes), collapses exclamation
 * marks, and normalizes whitespace. It NEVER invents content — it only cleans
 * text that was already assembled from the candidate profile.
 */

/**
 * @param {string} text
 * @param {object} patterns parsed config/humanizer_patterns.json
 * @returns {string}
 */
export function humanize(text, patterns = {}) {
  if (typeof text !== 'string') return '';
  let out = text;

  // Character replacements (em dash -> ", ", smart quotes -> straight, etc.).
  const replacements = patterns.characterReplacements ?? {};
  for (const [from, to] of Object.entries(replacements)) {
    out = out.split(from).join(to);
  }

  // Remove any remaining banned characters outright.
  for (const ch of patterns.bannedCharacters ?? []) {
    out = out.split(ch).join('');
  }

  // Remove banned phrases (case-insensitive, whole phrase).
  for (const phrase of patterns.bannedPhrases ?? []) {
    if (!phrase) continue;
    const re = new RegExp(escapeRegExp(phrase), 'gi');
    out = out.replace(re, '');
  }

  const rules = patterns.rules ?? {};
  if (rules.collapseExclamation !== false) {
    out = out.replace(/!+/g, '.');
  }
  if (rules.normalizeWhitespace !== false) {
    out = out
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ +([.,;:])/g, '$1')
      .trim();
  }
  return out;
}

/** True if text still contains any banned phrase or character. */
export function hasBannedContent(text, patterns = {}) {
  const lower = (text ?? '').toLowerCase();
  for (const ch of patterns.bannedCharacters ?? []) {
    if (text.includes(ch)) return true;
  }
  for (const phrase of patterns.bannedPhrases ?? []) {
    if (phrase && lower.includes(phrase.toLowerCase())) return true;
  }
  return false;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
