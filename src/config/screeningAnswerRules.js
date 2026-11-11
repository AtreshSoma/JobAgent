/**
 * Rules for a single screening answer — extracted so the SEARCH-profile store
 * can reuse them without a circular import.
 *
 * `src/profile/store.js` validates every derived answer before activation
 * writes it, and imported this one function from `src/config/profileStore.js`.
 * That was fine until the application-profile editor needed to write back INTO
 * a search profile (an edit saved only to the generated candidate.json is
 * erased by the next activation), which would have made the two modules import
 * each other. The shared rule lives here instead, and both import it.
 */

import {
  contradictingSponsorshipClaim, assertTruthfulSponsorship, isInvertedSponsorshipQuestion,
} from '../apply/screeningQA.js';

/** Longest screening answer. Some ATSes take a paragraph; none take a book. */
export const MAX_ANSWER_CHARS = 2000;

/** Most screening-answer entries. Well past a complete real-world set. */
export const MAX_ANSWER_ENTRIES = 400;

/**
 * Validate one screening-answer entry.
 *
 * `question` is the ORIGINAL form label when the entry is being created from a
 * queued question. It matters: an affirmative answer to an inverted sponsorship
 * question ("Can you work without sponsorship?" -> "Yes") reads as innocuous
 * text but asserts something false, and only the question reveals that. The
 * runner already refuses to auto-answer those; refusing to store one keeps the
 * two consistent.
 *
 * @param {object} entry {id, patterns, answer, type}
 * @param {{question?: string, requiresSponsorship?: boolean}} [context]
 *   `requiresSponsorship` is the candidate's real status. Omitted means
 *   unknown, which keeps the conservative historical rule.
 * @returns {{valid: boolean, error: string|null}}
 */
export function validateAnswerEntry(entry, { question, requiresSponsorship } = {}) {
  const fail = (error) => ({ valid: false, error });
  if (!entry || typeof entry !== 'object') return fail('an answer entry must be an object');

  const id = String(entry.id ?? '').trim();
  if (!id) return fail('give the answer an id (a short name like "years_experience")');
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    return fail('the id may only contain letters, numbers, hyphens and underscores');
  }

  const patterns = Array.isArray(entry.patterns)
    ? entry.patterns.map((p) => String(p ?? '').trim()).filter(Boolean)
    : [];
  if (patterns.length === 0) return fail('add at least one pattern — the phrase that identifies this question on a form');
  for (const pattern of patterns) {
    if (!/[a-z0-9]$/i.test(pattern)) {
      // The matcher wraps a pattern in word boundaries, so one ending in "?" or
      // ":" can never match anything. Failing loudly here beats saving an
      // answer that silently never fires.
      return fail(`the pattern "${pattern}" ends in punctuation — it would never match. Remove the trailing character.`);
    }
    if (isInvertedSponsorshipQuestion(pattern)) {
      return fail(`"${pattern}" is a reversed sponsorship question. Those are always left for you to answer by hand, `
        + 'so an answer saved for it would never be used.');
    }
  }

  const answer = String(entry.answer ?? '');
  if (!answer.trim()) return fail('the answer cannot be empty');
  if (answer.length > MAX_ANSWER_CHARS) {
    return fail(`that answer is ${answer.length} characters — the limit is ${MAX_ANSWER_CHARS}`);
  }
  // Contradiction is judged against the candidate's OWN stated requirement.
  // With an absolute blocklist this refused to save "No, I do not require
  // sponsorship" — the plain truth for anyone who does not need it, and the
  // single most common screening answer there is.
  const forbidden = contradictingSponsorshipClaim(answer, requiresSponsorship);
  if (forbidden) {
    return fail(`that answer contains "${forbidden}", which contradicts the work authorization in your `
      + `profile (${requiresSponsorship === false ? 'you do not require sponsorship' : 'you require sponsorship'}). `
      + 'State your real status instead.');
  }
  const truth = assertTruthfulSponsorship([{ answer, label: question ?? '' }], { requiresSponsorship });
  if (!truth.truthful) return fail(truth.violations[0]);

  return { valid: true, error: null };
}
