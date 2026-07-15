import { describe, it, expect } from 'vitest';
import { generateCoverLetter } from '../../src/apply/coverLetter.js';
import { humanize, hasBannedContent } from '../../src/apply/humanizer.js';
import { loadConfig } from '../../src/config/loadConfig.js';

const { coverLetter, candidate, humanizerPatterns } = loadConfig({ loadEnv: false, env: {} });

const job = { company: 'Acme Analytics', title: 'Senior Data Engineer' };
const highScore = { total: 88, matchedKeywords: ['azure', 'pyspark', 'delta lake', 'power bi', 'python'] };
const lowScore = { total: 50, matchedKeywords: ['python'] };

describe('humanizer (JS)', () => {
  it('replaces em dashes and removes banned phrases', () => {
    const out = humanize('Data\u2014driven results-driven professional work', humanizerPatterns);
    expect(out).not.toContain('\u2014');
    expect(out.toLowerCase()).not.toContain('results-driven professional');
  });
  it('detects residual banned content', () => {
    expect(hasBannedContent('an em dash \u2014 here', humanizerPatterns)).toBe(true);
    expect(hasBannedContent('clean text', humanizerPatterns)).toBe(false);
    expect(hasBannedContent(undefined, humanizerPatterns)).toBe(false);
  });
});

describe('generateCoverLetter', () => {
  it('generates for a high-scoring job', () => {
    const r = generateCoverLetter(job, highScore, { coverLetter, candidate, humanizerPatterns });
    expect(r.generated).toBe(true);
    expect(r.text).toContain('Acme Analytics');
    expect(r.text).toContain(candidate.identity.fullName);
  });

  it('skips a low-scoring job that is not required', () => {
    const r = generateCoverLetter(job, lowScore, { coverLetter, candidate, humanizerPatterns });
    expect(r.generated).toBe(false);
  });

  it('generates a required cover letter even when score is low', () => {
    const r = generateCoverLetter(job, lowScore, { coverLetter, candidate, humanizerPatterns, required: true });
    expect(r.generated).toBe(true);
  });

  it('contains no em dashes and no banned phrases', () => {
    const r = generateCoverLetter(job, highScore, { coverLetter, candidate, humanizerPatterns });
    expect(r.text).not.toContain('\u2014');
    expect(hasBannedContent(r.text, humanizerPatterns)).toBe(false);
    expect(r.cleaned).toBe(true);
  });

  it('respects the configured word ceiling', () => {
    const r = generateCoverLetter(job, highScore, { coverLetter, candidate, humanizerPatterns });
    expect(r.wordCount).toBeLessThanOrEqual(coverLetter.wordCount.max);
  });

  it('includes a sponsorship note for an H-1B candidate', () => {
    const r = generateCoverLetter(job, highScore, { coverLetter, candidate, humanizerPatterns, required: true });
    expect(r.text.toLowerCase()).toContain('h-1b');
  });
});
