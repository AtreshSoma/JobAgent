/**
 * P1C — is JobAgent useful outside data engineering?
 *
 * Eight people, end to end through the path a real user takes: save a profile,
 * ACTIVATE it (which writes candidate.json, scoring.json and exclusions.json),
 * then run each posting through exclusions -> score -> title verdict -> tier,
 * exactly as rescoreStale does. Each persona must rank its own role as a fit
 * and the deliberate traps (nurse recruiter, executive assistant, data entry)
 * as not.
 *
 * Every root here is a private temp directory: activation writes config, and
 * the shared test root is used by other files in parallel.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';

import { buildTestRoot } from './globalSetup.js';
import { saveProfile, activateProfile } from '../../src/profile/store.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { applyExclusions } from '../../src/scoring/exclusionFilter.js';
import { classifySponsorship } from '../../src/scoring/sponsorshipClassifier.js';
import { scoreJob, computeMissing } from '../../src/scoring/scorer.js';
import { explainScore } from '../../src/scoring/explainScore.js';
import { profileVocabularyFor, classifyTitleFit } from '../../src/scoring/profileFit.js';
import { canonicalEmploymentTypes } from '../../src/profile/model.js';
import { expandRoleTitles, loadRoleFamilies } from '../../src/profile/roleFamilies.js';
import { PERSONAS, POSTINGS } from './fixtures/personas.js';

let root;
beforeAll(() => { root = buildTestRoot(); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** Activate a persona and evaluate every posting the way the pipeline does. */
function evaluate(persona) {
  saveProfile(root, persona);
  activateProfile(root, persona.id);
  const config = loadConfig({ root, loadEnv: false, env: {} });
  const vocab = profileVocabularyFor(config.candidate);
  const now = new Date();
  const out = {};
  for (const job of POSTINGS) {
    const exclusion = applyExclusions(job, config.exclusions, { now, candidate: config.candidate });
    if (exclusion.excluded) { out[job.id] = { tier: 'Excluded', reason: exclusion.reason }; continue; }
    const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
    const score = scoreJob(job, { scoring: config.scoring, sponsorship, candidate: config.candidate, now, exclusions: config.exclusions });
    const { tier } = explainScore(score, config.scoring, { titleVerdict: classifyTitleFit(job.title, vocab).verdict, candidate: config.candidate });
    out[job.id] = { tier, total: score.total, missing: score.missingKeywords };
  }
  return { config, out };
}

const FIT = new Set(['Priority', 'Apply']);

describe('matching across industries and career stages', () => {
  for (const persona of PERSONAS) {
    it(`${persona.label}: ranks its own role as a fit and the traps as not`, () => {
      const { out } = evaluate(persona);
      for (const id of persona.fits) {
        expect(FIT.has(out[id].tier), `${persona.id} -> ${id} was ${out[id].tier} (${out[id].total})`).toBe(true);
      }
      for (const id of persona.notFits) {
        expect(['Priority', 'Apply', 'Queue'].includes(out[id].tier), `${persona.id} -> ${id} was ${out[id].tier} (${out[id].total})`).toBe(false);
      }
    });
  }

  it('never derives a bare department as an executive target title', () => {
    const exec = PERSONAS.find((p) => p.id === 'exec');
    const { config } = evaluate(exec);
    const titles = config.candidate.targetTitles.map((t) => t.toLowerCase());
    expect(titles).toContain('vp of operations');
    expect(titles).toContain('head of operations');
    expect(titles).not.toContain('operations');
    expect(titles).not.toContain('operating officer');
    expect(titles.some((t) => /^(senior|lead|staff) operations$/.test(t))).toBe(false);
  });

  it('keeps a headless role as written instead of stripping it to a department', () => {
    const taxonomy = loadRoleFamilies(root);
    const { roles } = expandRoleTitles({ targetRoles: ['Regulatory Affairs Associate'], taxonomy, seniority: 'associate' });
    expect(roles).toContain('regulatory affairs associate');
    expect(roles).not.toContain('regulatory affairs');
  });
});

describe('skill gaps are true statements', () => {
  it('does not report a credential or degree the candidate holds as missing', () => {
    const nurse = evaluate(PERSONAS.find((p) => p.id === 'nurse')).out['rn-icu'];
    expect(nurse.missing).not.toContain('rn license');
    expect(nurse.missing).not.toContain('bsn');
  });

  it('reports a skill the candidate only wants to grow into as a gap', () => {
    const changer = evaluate(PERSONAS.find((p) => p.id === 'changer')).out['instructional-designer'];
    expect(changer.missing).toEqual(expect.arrayContaining(['addie', 'elearning']));
  });

  it('matches a credential core on whole words only', () => {
    // "rn" is inside "learning": a substring match would invent evidence.
    const candidate = { technicalStack: { other: ['Machine Learning'] }, certifications: [] };
    expect(computeMissing('active rn license required', candidate, {}, {}, [], ['rn license'])).toEqual(['rn license']);
    expect(computeMissing('active rn license required', { ...candidate, certifications: ['RN'] }, {}, {}, [], ['rn license'])).toEqual([]);
  });
});

describe('profile fields reach candidate.json in the shape its schema accepts', () => {
  it('canonicalizes employment types instead of refusing the whole profile', () => {
    expect(canonicalEmploymentTypes(['Full-time', 'full_time', 'Permanent', 'Part-time', 'contract_to_hire', 'C2H', 'w2', 'gig']))
      .toEqual(['fulltime', 'parttime', 'contract-to-hire', 'W2']);
    const { config } = evaluate(PERSONAS.find((p) => p.id === 'accountant')); // profile says "Full-time"
    expect(config.candidate.employmentPreferences.types).toEqual(['fulltime']);
  });

  it('carries currency, seniority, industries and work authorization from the profile', () => {
    const swe = PERSONAS.find((p) => p.id === 'swe');
    const { config } = evaluate({
      ...swe, id: 'swe-gbp',
      searchIntent: { ...swe.searchIntent, compensation: { minAnnual: 70000, currency: 'GBP' },
        workAuthorization: { status: 'H-1B', requiresSponsorship: true } },
    });
    expect(config.candidate.seniority).toBe('senior');
    expect(config.candidate.sponsorshipRequired).toBe(true);
    expect(JSON.stringify(config.candidate)).toContain('GBP');
    expect(config.candidate.domainExperience).toContain('Technology');
  });
});

describe('pay is compared only in the currency postings are read in', () => {
  const posting = {
    title: 'Senior Backend Engineer', company: 'X', location: 'Remote, US', source: 'greenhouse',
    jdText: 'The pay range for this role is $120,000 - $150,000 per year. Go, Python, PostgreSQL.',
    postedAt: new Date().toISOString(),
  };
  const withPay = (minAnnualUSD, currency) => ({ salaryPreference: { minAnnualUSD, targetAnnualUSD: 0, currency } });

  it('applies a USD floor (stated or legacy-unstated currency)', async () => {
    const { checkSearchConstraints } = await import('../../src/scoring/searchConstraints.js');
    expect(checkSearchConstraints(posting, withPay(200000, 'USD')).category).toBe('below_salary_floor');
    expect(checkSearchConstraints(posting, withPay(200000, undefined)).category).toBe('below_salary_floor');
  });

  it('never compares a floor in another currency against dollar figures', async () => {
    const { checkSearchConstraints } = await import('../../src/scoring/searchConstraints.js');
    // 1,500,000 INR used to read as $1.5M and exclude every US posting.
    expect(checkSearchConstraints(posting, withPay(1500000, 'INR')).category).not.toBe('below_salary_floor');
    expect(checkSearchConstraints(posting, withPay(200000, 'GBP')).category).not.toBe('below_salary_floor');
  });
});
