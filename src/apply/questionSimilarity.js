/**
 * "Same as this earlier question?" (audit A5).
 *
 * A saved answer is found by pattern, so the same question worded differently
 * by another employer is asked again. This finds an ALREADY ANSWERED question
 * that a new one closely resembles, so the dashboard can offer "same as this?"
 * and, on one confirmation, add the new wording to that answer. It never
 * answers a form by itself.
 *
 * It is deliberately strict. A near-miss that means something else would type
 * the wrong answer onto an application, so:
 *   - sensitive topics keep exact matching only (sponsorship and work
 *     authorization, pay, years with a named skill, history, health, age,
 *     demographics, another country, and anything that depends on the employer);
 *   - the two questions must contain the same numbers, and neither may be
 *     negated unless both are;
 *   - the content words must overlap almost completely (Jaccard >= 0.75).
 */
import { normalizeText, singularize } from '../utils/textNormalize.js';
import { experienceSubject, foreignCountryIn, isInvertedSponsorshipQuestion, payPeriodOf, sensitiveTopic, STOPWORDS } from './screeningQA.js';
import { isSponsorshipTopic } from './screeningQA.js';
import { questionKind } from './questionQueue.js';

export const SIMILARITY_THRESHOLD = 0.75;

const FILLER = new Set([
  ...STOPWORDS, 'how', 'many', 'much', 'what', 'which', 'when', 'where', 'why', 'who', 'please', 'describe',
  'provide', 'enter', 'list', 'select', 'indicate', 'specify', 'tell', 'kindly', 'would', 'should', 'could',
  'there', 'than', 'then', 'so', 'yes',
]);
const NEGATION = new Set(['not', 'no', 'never', 'without', 'unwilling', 'unable', 'cannot', 'cant', 'dont', 'wont', 'neither', 'nor']);
const MONEY_OR_AUTH = /\b(?:salary|compensation|pay|wage|rate|\$|usd|authori[sz]\w*|eligible|permit\w*|visa|work\s+permit|citizen\w*|relocat\w*|commut\w*|travel\w*|notice|start\s+date|available)\b/i;

function words(label) {
  return normalizeText(label)
    .replace(/n['’]t\b/g, ' not')
    .replace(/[^a-z0-9+#%$ ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function contentTokens(label) {
  return new Set(words(label).filter((w) => !FILLER.has(w)).map((w) => (/^\d/.test(w) ? w : singularize(w))));
}

/** Questions that must keep exact matching, whatever they resemble. */
function neverSimilar(label) {
  return sensitiveTopic(label) !== null
    || isSponsorshipTopic(label)
    || isInvertedSponsorshipQuestion(label)
    || experienceSubject(label) !== null
    || foreignCountryIn(label) !== null
    || payPeriodOf(label) !== null
    || MONEY_OR_AUTH.test(label)
    || questionKind(label) !== 'general';
}

function numbersOf(label) { return words(label).filter((w) => /\d/.test(w)).sort().join(','); }
function negated(label) { return words(label).some((w) => NEGATION.has(w)); }

/**
 * @param {string} label the new question
 * @param {Array<{label: string, answeredWith?: string|null, status?: string}>} resolved queue entries already answered
 * @returns {{label: string, answerId: string, score: number}|null} the closest answered question, or null
 */
export function similarAnswered(label, resolved = []) {
  if (!label || neverSimilar(label)) return null;
  const mine = contentTokens(label);
  if (mine.size < 2) return null;
  let best = null;
  for (const earlier of resolved) {
    // The queue stores `answeredWith` as {id, at}; a bare id is accepted too.
    const answerId = typeof earlier?.answeredWith === 'object' ? earlier.answeredWith?.id : earlier?.answeredWith;
    if (earlier?.status !== 'answered' || !answerId || !earlier.label) continue;
    if (neverSimilar(earlier.label)) continue;
    if (numbersOf(label) !== numbersOf(earlier.label) || negated(label) !== negated(earlier.label)) continue;
    const theirs = contentTokens(earlier.label);
    const shared = [...mine].filter((t) => theirs.has(t)).length;
    if (shared < 2) continue;
    const score = shared / (mine.size + theirs.size - shared);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { label: String(earlier.label), answerId: String(answerId), score: Math.round(score * 100) / 100 };
    }
  }
  return best;
}
