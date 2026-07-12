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
 * Verify a set of answers never misrepresents the candidate's sponsorship need.
 * Used as a final safety check before any submit.
 *
 * @param {Array<{answer?: string, value?: string}>} answers
 * @returns {{ truthful: boolean, violations: string[] }}
 */
export function assertTruthfulSponsorship(answers = []) {
  const violations = [];
  for (const a of answers) {
    const text = String(a?.answer ?? a?.value ?? '');
    if (isForbidden(text)) violations.push(text);
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
 * Fraction of a pattern's words present, taking the strongest pattern.
 * WHOLE-WORD matching only: the EEO pattern "race" must match
 * "Race/Ethnicity" but never "embrace diversity" — a substring hit here would
 * write a demographic answer into an unrelated free-text field.
 */
function matchScore(text, patterns) {
  let best = 0;
  for (const pattern of patterns) {
    const p = normalizeText(pattern);
    if (!p) continue;
    if (wholeWordIn(text, p)) {
      best = Math.max(best, 1);
      continue;
    }
    const words = p.split(' ').filter(Boolean);
    const hit = words.filter((w) => wholeWordIn(text, w)).length;
    const frac = words.length ? hit / words.length : 0;
    if (frac >= 0.75) best = Math.max(best, frac);
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
