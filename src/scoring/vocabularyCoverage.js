/**
 * Does the profile's vocabulary cover the postings it is scoring? (audit D4)
 *
 * Fit is scored from configured words (marketSkills and keywords). A
 * profession with a thin vocabulary scores every posting alike, and nothing
 * said so. This measures, over a sample of stored postings, the share in which
 * at least five vocabulary terms appear, and names the phrases the postings keep
 * asking for that the vocabulary does not know (the same phrases "Also asked
 * for" offers on one job, R12).
 */
import { matchedPhrases } from '../utils/textNormalize.js';
import { requirementPhrases } from './requirementPhrases.js';

/** A posting is "covered" when at least this many vocabulary terms appear in it. */
export const COVERAGE_MIN_TERMS = 5;
/** Below this share of covered postings, System health warns. */
export const COVERAGE_WARN_BELOW = 40;
/** Fewer postings than this is too few to say anything. */
export const COVERAGE_MIN_SAMPLE = 50;
/** How many postings are read to measure it. */
export const COVERAGE_SAMPLE = 1500;

/**
 * @param {{vocabulary: string[], texts: string[], minTerms?: number}} args
 * @returns {{sampled: number, covered: number, percent: number|null}}
 */
export function vocabularyCoverage({ vocabulary = [], texts = [], minTerms = COVERAGE_MIN_TERMS } = {}) {
  const terms = [...new Set(vocabulary.map((t) => String(t ?? '').trim()).filter(Boolean))];
  let covered = 0;
  for (const text of texts) {
    if (matchedPhrases(text, terms).length >= minTerms) covered += 1;
  }
  return { sampled: texts.length, covered, percent: texts.length ? Math.round((covered / texts.length) * 100) : null };
}

/**
 * Phrases the postings' requirement sections name that the vocabulary does not
 * know, most-asked first.
 * @param {{texts: string[], vocabulary: string[], limit?: number, sample?: number}} args
 * @returns {Array<{phrase: string, postings: number}>}
 */
export function proposeTerms({ texts = [], vocabulary = [], limit = 8, sample = 200 } = {}) {
  const counts = new Map();
  for (const text of texts.slice(0, sample)) {
    const seen = new Set();
    for (const p of requirementPhrases(text, { vocabulary })) {
      const key = String(p.phrase).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key) ?? { phrase: p.phrase, postings: 0 };
      entry.postings += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.postings - a.postings || a.phrase.localeCompare(b.phrase)).slice(0, limit);
}
