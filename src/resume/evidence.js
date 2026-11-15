/**
 * One evidence check: does this text show this skill? (audit R2, R3, R13/D3)
 *
 * The JavaScript twin of src/resume/evidence.py, for the scorer, the gap list
 * and the dashboard's evidence map. Both read src/resume/evidence_rules.json and
 * both are held to tests/shared/evidence_cases.json, so the score and the
 * tailored packet cannot answer "does the resume show X?" differently. Before,
 * the scorer asked `profileText.includes(term)` of candidate.json ("java" was
 * shown by "javascript", "r" by any word) while the tailor used word
 * boundaries over the resume file (R13).
 *
 * Keep this file and evidence.py in step: a change to one is a change to both,
 * and the shared cases are the contract.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const RULES_TEXT = readFileSync(new URL('./evidence_rules.json', import.meta.url), 'utf8');
const RULES = JSON.parse(RULES_TEXT);

/** Bumps when the algorithm changes; the rules file is hashed in as well. */
const EVIDENCE_ALGORITHM = 1;
export const EVIDENCE_VERSION = `${EVIDENCE_ALGORITHM}:${createHash('sha1').update(RULES_TEXT).digest('hex').slice(0, 10)}`;

const EVERYDAY = new Set(RULES.everydayTerms);
const ANCHORS = new Map(Object.entries(RULES.anchors).map(([k, v]) => [k, new Set(v)]));
const TECHNOLOGIES = new Set(RULES.technologies);
const CREDENTIAL = new RegExp(`\\b(?:${RULES.credentialWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');

const JOINERS = "\\-&'’@+#";
const SEPARATOR = /[,;|•·/]|\band\b|\bor\b|(?<=\s)&(?=\s)|(?<=\s)\+(?=\s)/gi;
const LABEL = /^\s*[^:,;|.]{1,40}:\s*/;
const SEGMENT_END = /\n|[.!?](?=\s|$)|•/g;
const JOIN_LEFT = /\s*(?:,|\/|;|\||&|\+|\band\b|\bor\b)\s*$/i;
const JOIN_RIGHT = /^\s*(?:,|\/|;|\||&|\+|\band\b|\bor\b)\s*/i;
const PREV_WORD = /([A-Za-z0-9+#]+)[ \t]+$/;
const NEXT_WORD = /^[ \t]+([A-Za-z0-9+#]+)/;
const ITEM_LEAD = /^[ \t([\]"']*/;
const ITEM_TRIM = /^[\s([\]"']+|[\s.;:!?)\]"']+$/g;
const ITEM_SUFFIX = /(?<=\S)\s*\([^)]*\)\s*$|\s+v?\d+(?:\.\d+)*\s*$/g;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

export function normalize(term) {
  return String(term ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A skill that is also an ordinary word, or a single letter. */
export function isEveryday(term) {
  const key = normalize(term);
  return EVERYDAY.has(key) || (key.length === 1 && /^\p{L}$/u.test(key));
}

function body(key, { plural }) {
  const words = key.split(' ');
  const joined = words.map(escapeRe).join('\\s+');
  const last = words[words.length - 1];
  if (!plural || last.length < 3 || !/^\p{L}+$/u.test(last)) return joined;
  if (last.endsWith('y') && last.length > 3 && !'aeiou'.includes(last[last.length - 2])) {
    return `${joined.slice(0, -1)}(?:y|ies)`;
  }
  if (last.endsWith('s')) return joined;
  return `${joined}(?:es|s)?`;
}

const PATTERNS = new Map();

/** Where the term's words occur, before any context rule is applied. */
export function pattern(term) {
  const key = normalize(term);
  if (PATTERNS.has(key)) return PATTERNS.get(key);
  const everyday = isEveryday(key);
  const b = body(key, { plural: !everyday });
  const re = everyday
    ? new RegExp(`(?<![a-z0-9${JOINERS}])${b}(?![a-z0-9${JOINERS}])(?!\\.[a-z0-9])`, 'gi')
    : new RegExp(`(?<![a-z0-9])${b}(?![a-z0-9])`, 'gi');
  PATTERNS.set(key, re);
  return re;
}

// Scoring asks this hundreds of times per job over the same vocabulary array,
// so the neighbour list and the edge patterns are built once and kept.
const NEIGHBOURS = new WeakMap();
const EMPTY_VOCABULARY = [];

function neighbours(vocabulary, termKey) {
  const list = Array.isArray(vocabulary) ? vocabulary : [...vocabulary];
  let byTerm = NEIGHBOURS.get(list);
  if (!byTerm) { byTerm = new Map(); NEIGHBOURS.set(list, byTerm); }
  let out = byTerm.get(termKey);
  if (!out) {
    const found = new Set(list.map(normalize).filter(Boolean));
    for (const t of TECHNOLOGIES) found.add(t);
    out = [...found].filter((t) => t !== termKey && !isEveryday(t)).sort((a, b) => b.length - a.length);
    byTerm.set(termKey, out);
  }
  return out;
}

const STARTS = new Map();
const ENDS = new Map();
function edge(cache, term, make) {
  let re = cache.get(term);
  if (!re) { re = make(body(term, { plural: true })); cache.set(term, re); }
  return re;
}
const startsWithAny = (text, terms) => terms.some((t) => edge(STARTS, t, (b) => new RegExp(`^${b}(?![a-z0-9])`, 'i')).test(text));
const endsWithAny = (text, terms) => terms.some((t) => edge(ENDS, t, (b) => new RegExp(`(?<![a-z0-9])${b}$`, 'i')).test(text));

/** The sentence or line holding [start, end). */
function segment(text, start, end) {
  let segStart = 0;
  const head = text.slice(0, start);
  SEGMENT_END.lastIndex = 0;
  for (let m = SEGMENT_END.exec(head); m; m = SEGMENT_END.exec(head)) segStart = m.index + m[0].length;
  SEGMENT_END.lastIndex = end;
  const next = SEGMENT_END.exec(text);
  return [segStart, next ? next.index : text.length];
}

/** An item without its qualifier, punctuation and padding, and where it starts in `piece`. */
function trimItem(piece) {
  const bare = piece.replace(ITEM_SUFFIX, '');
  return [ITEM_LEAD.exec(bare)[0].length, bare.replace(ITEM_TRIM, '')];
}

/** A segment's list items as trimmed spans, and whether it opens with a label. */
function items(text, segStart, segEnd) {
  const seg = text.slice(segStart, segEnd);
  const label = LABEL.exec(seg);
  const offset = label ? label[0].length : 0;
  const bounds = [];
  let cursor = offset;
  SEPARATOR.lastIndex = offset;
  for (let m = SEPARATOR.exec(seg); m; m = SEPARATOR.exec(seg)) {
    bounds.push([cursor, m.index]);
    cursor = m.index + m[0].length;
    if (m[0].length === 0) SEPARATOR.lastIndex += 1;
  }
  bounds.push([cursor, seg.length]);
  const spans = [];
  for (const [left, right] of bounds) {
    const [lead, trimmed] = trimItem(seg.slice(left, right));
    if (!trimmed) continue;
    spans.push([segStart + left + lead, segStart + left + lead + trimmed.length]);
  }
  return [Boolean(label), spans];
}

/** Context rule for an everyday term: an anchor, a neighbouring technology, or a list item. */
function counts(termKey, text, start, end, vocabulary) {
  const hit = text.slice(start, end);
  if (termKey.length === 1 && hit !== hit.toUpperCase()) return false;
  const anchors = ANCHORS.get(termKey) ?? new Set();
  const before = PREV_WORD.exec(text.slice(0, start));
  const after = NEXT_WORD.exec(text.slice(end));
  if ((before && anchors.has(before[1].toLowerCase())) || (after && anchors.has(after[1].toLowerCase()))) return true;
  const [segStart, segEnd] = segment(text, start, end);
  const techs = neighbours(vocabulary, termKey);
  const right = JOIN_RIGHT.exec(text.slice(end, segEnd));
  if (right && startsWithAny(text.slice(end + right[0].length, segEnd), techs)) return true;
  const leftText = text.slice(segStart, start);
  const left = JOIN_LEFT.exec(leftText);
  if (left && endsWithAny(text.slice(segStart, segStart + left.index), techs)) return true;
  const [labelled, spans] = items(text, segStart, segEnd);
  if (!spans.some(([a, b]) => a === start && b === end)) return false;
  const others = spans.filter(([a, b]) => !(a === start && b === end)).map(([a, b]) => normalize(text.slice(a, b)));
  return labelled || others.some((o) => techs.includes(o));
}

/**
 * Spans of `text` that evidence `term`, in order. Empty means no evidence.
 *
 * `inList`: `text` is one item of a skills list the caller already found; an
 * everyday term then counts when it is the whole item, qualifier aside.
 *
 * @param {string} term
 * @param {string} text
 * @param {{vocabulary?: Iterable<string>, inList?: boolean}} [options]
 * @returns {Array<[number, number]>}
 */
// The scorer asks about hundreds of terms against one posting, and most terms
// are not in it at all: a plain substring test on a lowercase copy (made once
// per text) rules those out before any pattern runs. It never changes an
// answer, since every match contains the term's first word (a "-y" word as
// its stem, for the "-ies" plural).
const KEYS = new Map();
let lowerFor = null;
let lowerText = '';
function keyOf(term) {
  let key = KEYS.get(term);
  if (key === undefined) {
    key = normalize(term);
    if (KEYS.size > 50_000) KEYS.clear();
    KEYS.set(term, key);
  }
  return key;
}
function firstWord(key) {
  const space = key.indexOf(' ');
  return space === -1 ? key.replace(/y$/, '') : key.slice(0, space);
}
function mayContain(key, text, lower = null) {
  if (lower === null) {
    if (text !== lowerFor) { lowerFor = text; lowerText = text.toLowerCase(); }
    lower = lowerText;
  }
  const first = firstWord(key);
  return !first || lower.includes(first);
}

export function occurrences(term, text, { vocabulary = EMPTY_VOCABULARY, inList = false, lower = null } = {}) {
  const key = typeof term === 'string' ? keyOf(term) : normalize(term);
  if (!key || !text || !mayContain(key, text, lower)) return [];
  const everyday = isEveryday(key);
  const vocab = vocabulary;
  const re = pattern(key);
  re.lastIndex = 0;
  const found = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    if (m[0].length === 0) { re.lastIndex += 1; continue; }
    if (everyday) {
      if (inList) {
        const [, whole] = trimItem(text);
        const capital = key.length > 1 || m[0] === m[0].toUpperCase();
        if (!(capital && normalize(whole) === normalize(m[0]))) continue;
      } else if (!counts(key, text, start, end, vocab)) {
        continue;
      }
    }
    found.push([start, end]);
  }
  return found;
}

export function shows(term, text, options = {}) {
  return occurrences(term, text, options).length > 0;
}

/**
 * The first line evidencing `term` or each of its aliases, up to `limit`.
 *
 * @param {string} term
 * @param {string[]} lines
 * @param {{aliases?: Record<string, string[]>, vocabulary?: Iterable<string>, limit?: number}} [options]
 * @returns {Array<{matched_term: string, resume_text: string}>}
 */
export function findEvidence(term, lines, { aliases = {}, vocabulary = EMPTY_VOCABULARY, limit = 1 } = {}) {
  const aliasMap = aliasesOf(aliases);
  const found = [];
  const seen = new Set();
  const vocab = vocabulary;
  const key = normalize(term);
  // "RN license", "CPA certification": the credential is the evidence, not the
  // paperwork word around it, so the bare credential is tried last.
  const core = normalize(key.replace(CREDENTIAL, ' '));
  const prepared = preparedLines(lines);
  for (const candidate of [term, ...(aliasMap.get(key) ?? []), ...(core && core !== key ? [core] : [])]) {
    const ckey = normalize(candidate);
    if (!ckey || seen.has(ckey)) continue;
    seen.add(ckey);
    for (const { clean, lower } of prepared) {
      if (clean && shows(candidate, clean, { vocabulary: vocab, lower })) {
        found.push({ matched_term: String(candidate), resume_text: clean.slice(0, 300) });
        break;
      }
    }
    if (found.length >= limit) break;
  }
  return found;
}

// Resume lines are the same array for every job a run scores: clean them once.
const PREPARED = new WeakMap();
function preparedLines(lines) {
  const list = Array.isArray(lines) ? lines : [...lines];
  let out = PREPARED.get(list);
  if (!out) {
    out = list.map((line) => {
      const clean = String(line ?? '').replace(/\s+/g, ' ').trim();
      return { clean, lower: clean.toLowerCase() };
    });
    if (Array.isArray(lines)) PREPARED.set(lines, out);
  }
  return out;
}

const ALIAS_MAPS = new WeakMap();
function aliasesOf(aliases) {
  if (!aliases || typeof aliases !== 'object') return new Map();
  let map = ALIAS_MAPS.get(aliases);
  if (!map) {
    map = new Map(Object.entries(aliases).map(([k, v]) => [normalize(k), Array.isArray(v) ? v : []]));
    ALIAS_MAPS.set(aliases, map);
  }
  return map;
}

/**
 * The posting text both sides judge "does the posting ask for X?" against:
 * recruiting-fraud boilerplate removed and whitespace collapsed, exactly as
 * src/resume/jdKeywords.py classify_qualification_keywords prepares it.
 *
 * @param {string} jdText
 * @returns {string}
 */
export function postingText(jdText) {
  // Whitespace first, as in Python: the lazy patterns backtrack badly over a
  // long whitespace run.
  let cleaned = String(jdText ?? '').replace(/\s+/g, ' ');
  for (const re of BOILERPLATE) cleaned = cleaned.replace(re, ' ');
  return cleaned.replace(/\s+/g, ' ').trim();
}

// Mirrors jdKeywords._strip_non_role_boilerplate.
const BOILERPLATE = [
  /legitimate\s+[^.]{0,160}?\s+recruiters?\s+will\s+never\s+ask\s+for\s+[^.]{0,360}?(?:\.|$)/gi,
  /recruitment\s+fraud\s+(?:notice|warning)[^.]{0,360}?(?:\.|$)/gi,
];
