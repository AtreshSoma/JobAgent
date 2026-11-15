/**
 * Questions a draft answer is never made for (audit A4).
 *
 * A model-written answer to a question about eligibility, sponsorship, pay,
 * years with a named skill, history, health, age or demographics would state a
 * FACT about the person that no resume line backs. Those belong in the saved
 * screening answers, where the truthfulness checks are. A draft is only for an
 * open question ("Why do you want to work here?").
 */
import { experienceSubject, foreignCountryIn, isInvertedSponsorshipQuestion, isSponsorshipTopic, payPeriodOf, sensitiveTopic } from './screeningQA.js';

const FACTUAL = /\b(?:salary|compensation|pay|wage|authori[sz]\w*|eligible|permit\w*|visa|work\s+permit|citizen\w*|clearance|relocat\w*|notice\s+period|start\s+date|date\s+available|references?)\b/i;

/**
 * @param {string} question
 * @returns {string|null} why no draft is made, or null when one may be
 */
export function draftRefusal(question) {
  const text = String(question ?? '').trim();
  if (!text) return 'there is no question';
  if (sensitiveTopic(text) || isSponsorshipTopic(text) || isInvertedSponsorshipQuestion(text)
    || experienceSubject(text) !== null || foreignCountryIn(text) !== null || payPeriodOf(text) !== null || FACTUAL.test(text)) {
    return 'this asks for a fact about you (eligibility, pay, history, health, skill years or similar). '
      + 'Answer it in your screening answers, where it is checked, not as a draft.';
  }
  return null;
}
