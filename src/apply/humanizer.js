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
 * @param {object} [options]
 * @param {string[]} [options.protect] proper names (company, job title) that
 *   must reach the reader intact even when they contain a banned word —
 *   "Rockstar Games" and "Ninja Van" are employers, not buzzwords.
 * @returns {string}
 */
export function humanize(text, patterns = {}, { protect = [] } = {}) {
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

  // Protected names are parked behind private-use placeholders while phrases
  // are removed, then restored verbatim. They get the same character clean-up
  // as the text first, so they still match after the dash/quote replacements.
  const cleanChars = (s) => {
    let v = s;
    for (const [from, to] of Object.entries(replacements)) v = v.split(from).join(to);
    for (const ch of patterns.bannedCharacters ?? []) v = v.split(ch).join('');
    return v;
  };
  const parked = [...new Set(protect.filter((p) => typeof p === 'string' && p.trim()).map(cleanChars))]
    .sort((a, b) => b.length - a.length);
  parked.forEach((name, i) => { out = out.split(name).join(`${i}`); });

  // Remove banned phrases (case-insensitive, whole words only — a plain
  // substring match turned "Gurugram" into "gram" and "Synergy-based" into
  // "-based").
  for (const phrase of patterns.bannedPhrases ?? []) {
    if (!phrase) continue;
    out = out.replace(phraseRegExp(phrase, 'gi'), '');
  }

  parked.forEach((name, i) => { out = out.split(`${i}`).join(name); });

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
    if (phrase && phraseRegExp(phrase, 'i').test(lower)) return true;
  }
  return false;
}

/** A banned phrase as a whole-word, case-insensitive pattern. */
function phraseRegExp(phrase, flags) {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(phrase)}(?![A-Za-z0-9])`, flags);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
