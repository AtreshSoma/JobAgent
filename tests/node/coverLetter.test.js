import { describe, it, expect } from 'vitest';
import { generateCoverLetter } from '../../src/apply/coverLetter.js';
import { humanize, hasBannedContent } from '../../src/apply/humanizer.js';
import { loadTestConfig } from './helpers/testConfig.js';

const { coverLetter, candidate, humanizerPatterns } = loadTestConfig({ loadEnv: false, env: {} });

const job = { company: 'Acme Analytics', title: 'Senior Data Engineer' };
const highScore = { total: 88, matchedKeywords: ['azure', 'pyspark', 'delta lake', 'power bi', 'python'] };
const lowScore = { total: 50, matchedKeywords: ['python'] };

describe('humanizer (JS)', () => {
  it('replaces em dashes and removes banned phrases', () => {
    const out = humanize('Data\u2014driven results-driven professional work', humanizerPatterns);
    expect(out).not.toContain('\u2014');
    expect(out.toLowerCase()).not.toContain('results-driven professional');
  });
  it('removes banned phrases only as whole words', () => {
    const out = humanize('Based in Gurugram, building Synergy-based tooling. A true rockstar.', humanizerPatterns);
    expect(out).toContain('Gurugram');
    expect(out).not.toMatch(/\brockstar\b/i);
    expect(hasBannedContent('Based in Gurugram', humanizerPatterns)).toBe(false);
  });

  it('never edits a protected employer name or title', () => {
    const out = humanize('I want to join Rockstar Games as a Data Wizard — and I am a rockstar.',
      humanizerPatterns, { protect: ['Rockstar Games', 'Data Wizard'] });
    expect(out).toContain('Rockstar Games');
    expect(out).toContain('Data Wizard');
    expect(out).not.toMatch(/a rockstar/i);
  });

  it('detects residual banned content', () => {
    expect(hasBannedContent('an em dash \u2014 here', humanizerPatterns)).toBe(true);
    expect(hasBannedContent('clean text', humanizerPatterns)).toBe(false);
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

  it('keeps an employer whose name contains a banned word intact in the letter', () => {
    const r = generateCoverLetter({ company: 'Ninja Van', title: 'Senior Data Engineer' }, highScore,
      { coverLetter, candidate, humanizerPatterns });
    expect(r.text).toContain('Ninja Van');
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
