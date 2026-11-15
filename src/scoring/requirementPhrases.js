/**
 * What a posting asks for that your vocabulary does not know (audit R12).
 *
 * Tailoring, gaps and the score all work from scoring's vocabulary (market
 * skills from your role families plus scoring.keywords). A requirement outside
 * it was invisible unless the optional model was on: never reordered for,
 * never reported. This reads the posting's requirement sections and returns
 * the items there that the vocabulary lacks:
 *
 *   - word for word: every phrase is a substring of the posting, never
 *     generated, paraphrased or inferred;
 *   - ranked by how many stored postings ask for the same phrase, so a real
 *     skill outranks a one-off;
 *   - only suggestions. The person adds one to their vocabulary
 *     (searchIntent.watchSkills) or ignores it; nothing changes otherwise.
 *
 * Deterministic and pure; no model.
 */
import { normalize, shows } from '../resume/evidence.js';

const MAX_PHRASES = 12;
const MAX_WORDS = 4;

/** A requirement section heading: a short line naming what you need. */
const REQUIRED_HEADING = /^(?:minimum |basic |required |key )?(?:requirements?|qualifications?|what you(?:'|’)?ll need|what you will need|what you need|what you bring|you have|you bring|must[- ]haves?|skills(?: and experience)?|about you|who you are)\b/i;
const PREFERRED_HEADING = /^(?:preferred(?: qualifications)?|nice[- ]to[- ]haves?|bonus(?: points)?|good to have|desired(?: skills)?|pluses)\b/i;
/** Any other short heading ends a requirement section. */
const OTHER_HEADING = /^(?:responsibilities|what you(?:'|’)?ll do|what you will do|the role|about (?:us|the (?:team|role|company))|benefits|perks|compensation|our (?:team|company)|why join|how to apply|location)\b/i;

const LEAD = /^(?:\d+\+?\s*(?:years?|yrs?)\s*(?:of\s*)?)?(?:(?:strong|solid|deep|proven|demonstrated|practical|working|excellent|good|hands[- ]on|prior|professional|extensive)\s+)*(?:(?:experience|knowledge|proficiency|familiarity|expertise|understanding|background|skills?)\s+(?:with|in|of|using|across)\s+)?/i;
const TRAIL = /\s*(?:experience|skills?|knowledge|is (?:a )?(?:plus|bonus)|(?:is )?preferred|(?:is )?required|a plus|or similar|or equivalent|etc)\.?$/i;
const SPLIT = /\s*(?:[,;•·/()]|\band\b|\bor\b|\s&\s)\s*/i;
const NOT_A_SKILL = /\b(?:years?|degree|bachelor'?s?|master'?s?|phd|communication|collaborat\w*|team(?:work)?|problem[- ]solving|attention to detail|self[- ]starter|motivated|passion\w*|ability|fast[- ]paced|environment|stakeholders?|written|verbal|interpersonal|leadership skills|work independently|equivalent|related field|computer science)\b/i;
const STOP = new Set(['a', 'an', 'the', 'with', 'in', 'of', 'to', 'for', 'and', 'or', 'on', 'at', 'is', 'are', 'be', 'your', 'our', 'we', 'you', 'this', 'that', 'such', 'as', 'including', 'like']);

/** Lines of the posting's requirement sections, with whether each is preferred. */
function requirementLines(jdText) {
  const lines = String(jdText ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  let mode = null;
  for (const line of lines) {
    const bare = line.replace(/^[-*•·\s]+/, '').replace(/:\s*$/, '');
    const short = bare.split(/\s+/).length <= 6 && !/[.!?]$/.test(bare);
    if (short && PREFERRED_HEADING.test(bare)) { mode = 'preferred'; continue; }
    if (short && REQUIRED_HEADING.test(bare)) { mode = 'required'; continue; }
    if (short && OTHER_HEADING.test(bare)) { mode = null; continue; }
    if (mode) out.push({ text: line.replace(/^[-*•·\s]+/, ''), preferred: mode === 'preferred' });
  }
  return out;
}

/** Candidate phrases in one requirement line, exactly as written. */
function phrasesIn(line) {
  const out = [];
  const preferredHere = /\b(?:is a plus|a plus|preferred|nice to have|bonus)\b/i.test(line);
  for (let part of line.split(SPLIT)) {
    part = part.replace(LEAD, '').replace(TRAIL, '').replace(/[.:;!]+$/, '').trim();
    const words = part.split(/\s+/).filter(Boolean);
    if (!part || words.length > MAX_WORDS || part.length < 2 || part.length > 40) continue;
    if (!/[A-Za-z]/.test(part) || words.every((w) => STOP.has(w.toLowerCase()))) continue;
    if (STOP.has(words[0].toLowerCase()) || STOP.has(words[words.length - 1].toLowerCase())) continue;
    if (NOT_A_SKILL.test(part)) continue;
    // A skill is named, not described: at least one word that is capitalised,
    // an acronym, or carries a technical mark (C++, .NET, Node.js).
    if (!words.some((w) => /^[A-Z0-9]/.test(w) || /[+#./]/.test(w))) continue;
    out.push({ phrase: part, preferredHere });
  }
  return out;
}

/**
 * How many of a set of postings mention each phrase, case-insensitively.
 *
 * @param {string[]} texts posting texts (a sample of the stored corpus)
 * @returns {(phrase: string) => number}
 */
export function corpusFrequency(texts = []) {
  const lowered = texts.map((t) => String(t ?? '').toLowerCase());
  const cache = new Map();
  return (phrase) => {
    const key = String(phrase).toLowerCase();
    if (!cache.has(key)) cache.set(key, lowered.reduce((n, t) => n + (t.includes(key) ? 1 : 0), 0));
    return cache.get(key);
  };
}

/**
 * Requirement phrases a posting names that the vocabulary does not.
 *
 * @param {string} jdText
 * @param {object} [options]
 * @param {string[]} [options.vocabulary] terms already looked for
 * @param {Record<string, string[]>} [options.aliases] evidence aliases (their keys and values count as known)
 * @param {string[]} [options.resumeLines] the master resume, to say which are already shown
 * @param {(phrase: string) => number} [options.frequency] corpusFrequency(...)
 * @returns {Array<{phrase: string, preferred: boolean, inResume: boolean, postings: number|null}>}
 */
export function requirementPhrases(jdText, { vocabulary = [], aliases = {}, resumeLines = [], frequency = null } = {}) {
  const known = new Set(vocabulary.map(normalize));
  for (const [key, list] of Object.entries(aliases ?? {})) {
    known.add(normalize(key));
    for (const a of list ?? []) known.add(normalize(a));
  }
  const seen = new Map();
  for (const line of requirementLines(jdText)) {
    for (const { phrase, preferredHere } of phrasesIn(line.text)) {
      const key = normalize(phrase);
      if (known.has(key)) continue;
      const preferred = line.preferred || preferredHere;
      const prior = seen.get(key);
      if (prior) { prior.preferred = prior.preferred && preferred; continue; }
      seen.set(key, {
        phrase,
        preferred,
        inResume: resumeLines.some((l) => shows(phrase, String(l ?? ''))),
        postings: frequency ? frequency(phrase) : null,
      });
    }
  }
  const list = [...seen.values()];
  if (frequency) list.sort((a, b) => b.postings - a.postings);
  return list.slice(0, MAX_PHRASES);
}
