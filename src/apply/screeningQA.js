/**
 * Screening question answering (Section 6).
 *
 * Matches a screening question against config/screening_answers.json patterns and
 * returns a high-confidence answer or signals that the user must be asked. It is
 * deliberately conservative:
 *
 *   - If no pattern matches, it returns { action: 'ask_user' } (never guesses).
 *   - It NEVER produces a "no sponsorship required" style answer. Sponsorship and
 *     work-authorization answers always come straight from config (truthful).
 *   - All answers are drawn from config; nothing about the candidate is invented.
 */

import { normalizeText, wholeWordIn } from '../utils/textNormalize.js';

/** Phrases an answer must never contain (would misrepresent the candidate). */
const FORBIDDEN_ANSWER_FRAGMENTS = [
  'no sponsorship required',
  'do not require sponsorship',
  'does not require sponsorship',
  'not require sponsorship',
  'no visa sponsorship needed',
];

export { FORBIDDEN_ANSWER_FRAGMENTS };

/**
 * Questions about sponsorship / visa / work authorization. An answer here is a
 * factual representation of immigration status, so it gets stricter handling
 * than any other field on the form.
 */
const SPONSORSHIP_TOPIC_RE =
  /\b(sponsor(?:ship|ed|ing)?|visa|h-?1-?b|work\s+authoriz|authoriz(?:ed|ation)\s+to\s+work|right\s+to\s+work|employment\s+eligib|immigration\s+status)\b/i;

/**
 * Negators that INVERT a sponsorship question's meaning.
 *
 * ATSes ask this both ways, and the two forms take opposite answers:
 *   "Do you REQUIRE sponsorship?"                        -> Yes
 *   "Can you work here WITHOUT sponsorship?"             -> No
 *   "Will you NOT require sponsorship?"                  -> No
 *
 * Bare "no" is deliberately excluded: it appears innocently in helper text
 * such as "(if no, choose No)" and would misfire constantly.
 */
const NEGATION_RE = new RegExp([
  '\\bwithout\\b',
  '\\bnot\\b',
  "\\bn't\\b",
  '\\bcannot\\b',
  '\\bnever\\b',
  '\\bno\\s+(?:visa\\s+|employer\\s+)?sponsorship\\b',
  '\\bno\\s+need\\b',
  '\\bfree\\s+(?:from|of)\\b',
  '\\bindependent\\s+of\\b',
  '\\bother\\s+than\\b',
  '\\bdo\\s+not\\b',
  '\\bdoes\\s+not\\b',
  '\\bwill\\s+not\\b',
].join('|'), 'i');

/** Answers that read as "yes" to whatever was asked. */
const AFFIRMATIVE_RE = /^\s*(?:yes|y|true|affirmative|i\s+(?:do|am|will))\b/i;

/**
 * Is this a sponsorship/authorization question whose meaning is INVERTED?
 *
 * Such a question cannot be answered from a pattern match: the stored answer
 * states the candidate's real need ("I require sponsorship"), and the question
 * asks for its opposite. Auto-inverting would be guessing about immigration
 * status, so the caller must defer to the human instead.
 *
 * @param {string} question raw question text
 * @returns {boolean}
 */
export function isInvertedSponsorshipQuestion(question) {
  const text = String(question ?? '');
  if (!SPONSORSHIP_TOPIC_RE.test(text)) return false;
  return NEGATION_RE.test(text);
}

/**
 * Verify a set of answers never misrepresents the candidate's sponsorship need.
 * Used as a final safety check before any submit.
 *
 * Two independent checks:
 *   1. The answer text itself must not contain a forbidden claim.
 *   2. An affirmative answer to an INVERTED sponsorship question is a
 *      misrepresentation even though its text ("Yes") is innocuous — so when a
 *      question/label is supplied, polarity is checked too. This is the case a
 *      pure phrase blocklist can never catch.
 *
 * @param {Array<{answer?: string, value?: string, label?: string, question?: string}>} answers
 * @returns {{ truthful: boolean, violations: string[] }}
 */
export function assertTruthfulSponsorship(answers = []) {
  const violations = [];
  for (const a of answers) {
    const text = String(a?.answer ?? a?.value ?? '');
    if (isForbidden(text)) {
      violations.push(text);
      continue;
    }
    const question = String(a?.label ?? a?.question ?? '');
    if (question && isInvertedSponsorshipQuestion(question) && AFFIRMATIVE_RE.test(text)) {
      violations.push(
        `"${text.trim()}" answers an inverted sponsorship question ("${question.trim()}") `
        + 'as if no sponsorship were needed',
      );
    }
  }
  return { truthful: violations.length === 0, violations };
}

/**
 * @param {string} question raw screening question text
 * @param {object} screeningAnswers parsed config/screening_answers.json
 * @param {object} [options]
 * @param {string[]} [options.choices] available options for choice questions
 * @returns {{
 *   answered: boolean,
 *   action: 'answer'|'ask_user',
 *   matchedId: string|null,
 *   answer: string|null,
 *   type: string|null,
 *   confidence: number
 * }}
 */
export function answerScreeningQuestion(question, screeningAnswers, { choices } = {}) {
  const text = normalizeText(question);
  const answers = screeningAnswers.answers ?? [];
  const defaults = screeningAnswers.defaults ?? {};

  // An inverted sponsorship question ("…work WITHOUT sponsorship?", "…will you
  // NOT require…?") asks for the opposite of what the stored answer states.
  // Pattern matching is polarity-blind, so answering here would assert
  // something untrue about the candidate's immigration status. Always defer to
  // the human — inverting the answer ourselves would be a guess.
  if (isInvertedSponsorshipQuestion(question)) {
    return {
      ...askUser(defaults),
      // Never silently skip this one: even when defaults.unknownAction is
      // 'skip', a required inverted sponsorship question must reach the human.
      action: 'ask_user',
      reason: 'inverted sponsorship question — needs your explicit answer',
    };
  }

  let best = null;
  let bestScore = 0;
  for (const entry of answers) {
    const score = matchScore(text, entry.patterns ?? []);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (!best || bestScore === 0) {
    return askUser(defaults);
  }

  const answer = String(best.answer ?? '');
  // Safety net: refuse to emit any forbidden (misrepresenting) answer.
  if (isForbidden(answer)) {
    return askUser(defaults);
  }

  // For multiple-choice questions, only answer if our value maps to a choice.
  if (Array.isArray(choices) && choices.length) {
    const mapped = mapToChoice(answer, best.type, choices);
    if (mapped === null) return askUser(defaults);
    return { answered: true, action: 'answer', matchedId: best.id, answer: mapped, type: best.type ?? 'text', confidence: bestScore };
  }

  return { answered: true, action: 'answer', matchedId: best.id, answer, type: best.type ?? 'text', confidence: bestScore };
}

/**
 * Filler words that carry no identifying weight. Counting them inflated the
 * word-fraction score: the pattern "sponsorship to work" scored a perfect 3/3
 * against any sentence containing those three tokens in any arrangement, which
 * is how one entry hijacked questions meant for another.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'and', 'or',
  'do', 'does', 'did', 'will', 'would', 'is', 'are', 'was', 'be', 'been',
  'you', 'your', 'yours', 'we', 'our', 'us', 'i', 'my', 'me', 'this', 'that',
  'have', 'has', 'had', 'can', 'any', 'if', 'as', 'it', 'its',
]);

/** Highest score a scattered (non-contiguous) word match may earn. */
const MAX_SCATTERED_SCORE = 0.8;

/**
 * Confidence that `patterns` identify `text`, taking the strongest pattern.
 *
 * WHOLE-WORD matching only: the EEO pattern "race" must match "Race/Ethnicity"
 * but never "embrace diversity" — a substring hit would write a demographic
 * answer into an unrelated free-text field.
 *
 * An exact contiguous phrase always outranks a scattered match, so when two
 * entries both plausibly match, the one that matched as a real phrase wins.
 * Scattered matches must additionally cover EVERY content word and have at
 * least two of them, so a lone keyword can never drag in a whole answer.
 */
function matchScore(text, patterns) {
  let best = 0;
  for (const pattern of patterns) {
    const p = normalizeText(pattern);
    if (!p) continue;
    // 1. Exact contiguous phrase — highest confidence.
    if (wholeWordIn(text, p)) {
      best = Math.max(best, 1);
      continue;
    }
    // 2. Scattered content words — every one must be present, min two.
    const content = p.split(' ').filter((w) => w && !STOPWORDS.has(w));
    if (content.length < 2) continue;
    const hit = content.filter((w) => wholeWordIn(text, w)).length;
    if (hit === content.length) best = Math.max(best, MAX_SCATTERED_SCORE);
  }
  return best;
}

function mapToChoice(answer, type, choices) {
  const norm = normalizeText(answer);
  // Boolean-style questions.
  if (type === 'boolean_yes' || /^yes\b/.test(norm)) {
    const yes = choices.find((c) => /^(yes|y)\b/i.test(c.trim()));
    if (yes) return yes;
  }
  // Direct/substring match against a provided choice.
  const direct = choices.find((c) => normalizeText(c) === norm);
  if (direct) return direct;
  const partial = choices.find((c) => norm.includes(normalizeText(c)) || normalizeText(c).includes(norm));
  return partial ?? null;
}

function isForbidden(answer) {
  const a = answer.toLowerCase();
  return FORBIDDEN_ANSWER_FRAGMENTS.some((f) => a.includes(f));
}

/**
 * Unanswerable question -> defer to the configured default. `ask_user`
 * (shipped default) surfaces it as a blocker; `skip` leaves the field blank
 * without blocking (the live form's own required-field check still applies).
 * Never anything else — an unknown question is never answered with a guess.
 */
function askUser(defaults) {
  return {
    answered: false,
    action: defaults.unknownAction === 'skip' ? 'skip' : 'ask_user',
    matchedId: null,
    answer: null,
    type: null,
    confidence: 0,
  };
}
