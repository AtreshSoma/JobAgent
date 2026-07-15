import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';

import { isSponsorshipGated, setApplyTierThreshold } from '../../src/dashboard/data.js';
import { generateCoverLetter } from '../../src/apply/coverLetter.js';

const html = readFileSync(new URL('../../src/dashboard/public/index.html', import.meta.url), 'utf8');

describe('audit round 3: sponsorship-gate threshold tracks config (AUDIT_LOG flagged item 1)', () => {
  afterEach(() => setApplyTierThreshold(75)); // restore the shipped default

  it('defaults to the shipped Apply threshold of 75', () => {
    expect(isSponsorshipGated({ tier: 'Queue', score: 75 })).toBe(true);
    expect(isSponsorshipGated({ tier: 'Queue', score: 74 })).toBe(false);
    expect(isSponsorshipGated({ tier: 'Apply', score: 90 })).toBe(false);
    expect(isSponsorshipGated({ tier: 'Queue', score: null })).toBe(false);
  });

  it('follows a retuned scoring.tiers.apply instead of a hardcoded 75', () => {
    setApplyTierThreshold(70);
    expect(isSponsorshipGated({ tier: 'Queue', score: 72 })).toBe(true);
    setApplyTierThreshold(80);
    expect(isSponsorshipGated({ tier: 'Queue', score: 78 })).toBe(false);
  });

  it('ignores invalid threshold values (fail-safe to the last good one)', () => {
    setApplyTierThreshold(NaN);
    setApplyTierThreshold(-5);
    setApplyTierThreshold(undefined);
    expect(isSponsorshipGated({ tier: 'Queue', score: 75 })).toBe(true);
  });
});

describe('audit round 3: cover-letter minimum is flagged, never padded (AUDIT_LOG flagged item 2)', () => {
  const baseConfig = {
    enabled: true,
    minScoreToGenerate: 75,
    wordCount: { min: 180, max: 260 },
    greeting: 'Dear Hiring Team,',
    closing: 'Sincerely,',
    template: {
      opening: 'I am applying for the {title} role at {company}.',
      skillsLead: 'My core strengths:',
      experience: 'In my current role I {topHighlight}.',
      fitNote: 'I focus on {focusAreas}.',
      sponsorshipNote: 'I require sponsorship.',
      closingParagraph: 'Thank you for your consideration.',
    },
    yearsOfExperience: '10+ years',
    includeSponsorshipNote: false,
    maxSkillBullets: 5,
  };
  const candidate = { identity: { fullName: 'Test User', headline: 'Data Engineer' } };

  it('flags a letter under wordCount.min without adding filler content', () => {
    const r = generateCoverLetter(
      { title: 'Data Engineer', company: 'Acme' },
      { total: 90, matchedKeywords: [] },
      { coverLetter: baseConfig, candidate, humanizerPatterns: {} },
    );
    expect(r.generated).toBe(true);
    expect(r.wordCount).toBeLessThan(180);
    expect(r.belowMinWordCount).toBe(true);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('below the configured minimum');
  });

  it('does not flag when no minimum is configured', () => {
    const r = generateCoverLetter(
      { title: 'Data Engineer', company: 'Acme' },
      { total: 90, matchedKeywords: [] },
      { coverLetter: { ...baseConfig, wordCount: { max: 260 } }, candidate, humanizerPatterns: {} },
    );
    expect(r.belowMinWordCount).toBe(false);
    expect(r.warnings).toEqual([]);
  });
});

describe('audit rounds 1-2: sponsorship-gate CTA fixes stay in the dashboard markup', () => {
  it('keeps the per-job "Verify sponsorship" primary action for gated jobs (Finding A)', () => {
    expect(html).toContain('j.sponsorshipGated && !j.userDecision');
    expect(html).toContain('Verify sponsorship ↗');
    expect(html).toContain('Verified — shortlist');
  });

  it('keeps the confirm-guard on the one-click auto-apply path (Finding A)', () => {
    expect(html).toContain("jobsById[id]?.sponsorshipGated && !jobsById[id]?.userDecision");
  });

  it('keeps gated undecided jobs out of the batch auto-apply set (Round 2 item 3)', () => {
    expect(html).toContain('jobsById[id]?.sponsorshipGated && !jobsById[id]?.userDecision);');
    expect(html).toContain('!NON_APPLICABLE.has(jobsById[id]?.appStatus) && !gatedSet.has(id)');
  });
});
