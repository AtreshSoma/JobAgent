import { describe, it, expect } from 'vitest';
import { classifySponsorship } from '../../src/scoring/sponsorshipClassifier.js';
import { scoreJob } from '../../src/scoring/scorer.js';
import { explainScore, rawTier, TIERS } from '../../src/scoring/explainScore.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import * as F from './fixtures/jobs.js';

const { scoring, candidate } = loadConfig({ loadEnv: false, env: {} });
const sponConfig = scoring.sponsorship;

describe('sponsorshipClassifier', () => {
  it('Confirmed when JD affirms sponsorship', () => {
    expect(classifySponsorship(F.confirmedSponsorship, sponConfig).status).toBe('Confirmed');
  });
  it('Confirmed when willingToSponsor flag set', () => {
    expect(classifySponsorship({ willingToSponsor: true }, sponConfig).status).toBe('Confirmed');
  });
  it('Likely for a configured big-sponsor company', () => {
    expect(classifySponsorship({ company: 'Microsoft', jdText: '' }, sponConfig).status).toBe('Likely');
  });
  it('Unconfirmed when no signal', () => {
    expect(classifySponsorship({ company: 'Tiny LLC', jdText: 'data engineer' }, sponConfig).status).toBe('Unconfirmed');
  });
});

describe('scorer', () => {
  it('scores a strong Azure Fabric senior role highly', () => {
    const sponsorship = classifySponsorship(F.azureFabricSenior, sponConfig);
    const result = scoreJob(F.azureFabricSenior, { scoring, sponsorship, candidate, now: F.NOW });
    expect(result.total).toBeGreaterThanOrEqual(75);
    expect(result.matchedKeywords).toEqual(expect.arrayContaining(['azure', 'pyspark']));
    expect(result.sponsorship).toBe('Confirmed');
  });

  it('scores a Snowflake-only mismatch lower than the Azure role', () => {
    const azureSpon = classifySponsorship(F.azureFabricSenior, sponConfig);
    const snowSpon = classifySponsorship(F.snowflakeMismatch, sponConfig);
    const azure = scoreJob(F.azureFabricSenior, { scoring, sponsorship: azureSpon, candidate, now: F.NOW });
    const snow = scoreJob(F.snowflakeMismatch, { scoring, sponsorship: snowSpon, candidate, now: F.NOW });
    expect(snow.total).toBeLessThan(azure.total);
  });

  it('is deterministic', () => {
    const s = classifySponsorship(F.azureFabricSenior, sponConfig);
    const a = scoreJob(F.azureFabricSenior, { scoring, sponsorship: s, candidate, now: F.NOW });
    const b = scoreJob(F.azureFabricSenior, { scoring, sponsorship: s, candidate, now: F.NOW });
    expect(a.total).toBe(b.total);
    expect(a.raw).toBe(b.raw);
  });
});

describe('explainScore + sponsorship gate', () => {
  it('assigns Priority/Apply when sponsorship is allowed', () => {
    const sponsorship = classifySponsorship(F.confirmedSponsorship, sponConfig);
    const result = scoreJob(F.confirmedSponsorship, { scoring, sponsorship, candidate, now: F.NOW });
    const { tier } = explainScore(result, scoring);
    expect([TIERS.PRIORITY, TIERS.APPLY]).toContain(tier);
  });

  it('NEVER marks Apply/Priority when sponsorship is Unconfirmed; downgrades to Queue', () => {
    // Force a high score but Unconfirmed sponsorship.
    const result = {
      total: 95, raw: 95, max: 100, breakdown: {}, matchedKeywords: [], missingKeywords: [],
      sponsorship: 'Unconfirmed',
    };
    const { tier, sponsorshipGated } = explainScore(result, scoring);
    expect(tier).toBe(TIERS.QUEUE);
    expect(sponsorshipGated).toBe(true);
  });

  it('allows Apply for Unconfirmed only with explicit user approval', () => {
    const result = { total: 80, sponsorship: 'Unconfirmed', breakdown: {}, matchedKeywords: [], missingKeywords: [] };
    expect(explainScore(result, scoring, { userApproved: true }).tier).toBe(TIERS.APPLY);
  });

  it('rawTier maps thresholds correctly', () => {
    expect(rawTier(90, scoring.tiers)).toBe(TIERS.PRIORITY);
    expect(rawTier(78, scoring.tiers)).toBe(TIERS.APPLY);
    expect(rawTier(65, scoring.tiers)).toBe(TIERS.QUEUE);
    expect(rawTier(55, scoring.tiers)).toBe(TIERS.NEAR_MISS);
    expect(rawTier(20, scoring.tiers)).toBe(TIERS.DISCARD);
  });
});
