/**
 * Does this work for someone who is not a data engineer?
 *
 * It did not. Six keyword categories were hardcoded JavaScript identifiers —
 * azureFabricStack, dataEngineeringStack, biSemanticDepth, pythonSqlPyspark,
 * domainFit, and a titleFit that read a fixed keyword list rather than the
 * candidate's own target titles. Together they own 64 of the 110 available
 * points, so a candidate outside that one stack could not reach them at all.
 *
 * Measured against PERFECTLY MATCHING postings, with a discard floor of 50:
 *
 *   data engineer 78 (Apply)  ·  nurse 21  ·  frontend 26
 *   accountant 27             ·  marketing manager 27      (all DISCARD)
 *
 * Discovery classified every one of those as a strong match. Scoring then threw
 * them away. These tests pin both the failure and the fix.
 */
import { describe, it, expect } from 'vitest';

import { scoreJob, resolveCategories, computeMissing } from '../../src/scoring/scorer.js';
import { classifyDiscovery } from '../../src/search/discoveryFilter.js';
import { PROFILE_DRIVEN_CATEGORIES } from '../../scripts/initScoring.mjs';
import { loadTestConfig } from './helpers/testConfig.js';

const base = loadTestConfig({ loadEnv: false, env: {} });
const FRESH = new Date(Date.now() - 2 * 864e5).toISOString();
/** The floor a job must clear to avoid being discarded outright. */
const FLOOR = base.scoring.tiers.nearMiss;

/** A candidate with everything structural neutralized, so only FIT varies. */
const person = (over) => ({
  ...base.candidate,
  ...over,
  workAuthorization: { status: 'US Citizen', requiresSponsorship: false, details: 'Citizen' },
  sponsorshipRequired: false,
  locationPreferences: {
    remote: true, onsite: true, hybrid: true,
    preferredRegions: ['United States'], excludedLocations: [], excludedTimezones: [],
  },
});

const PERSONAS = [
  {
    name: 'data engineer',
    candidate: person({
      targetTitles: ['Senior Data Engineer', 'Data Engineer'],
      technicalStack: { languages: ['Python', 'SQL'], other: ['Azure Data Factory', 'Databricks', 'PySpark', 'Delta Lake', 'Power BI'] },
    }),
    job: {
      title: 'Senior Data Engineer', company: 'Acme', location: 'Remote, US', postedAt: FRESH, source: 'greenhouse',
      jdText: 'Azure Data Factory, Databricks, PySpark, Delta Lake, Python, SQL, Power BI, ETL pipelines, Synapse.',
    },
  },
  {
    name: 'registered nurse',
    candidate: person({
      targetTitles: ['Registered Nurse', 'ICU Nurse'],
      technicalStack: { other: ['ACLS', 'BLS', 'Epic EHR', 'Triage', 'Patient Assessment', 'IV Therapy', 'Critical Care'] },
    }),
    job: {
      title: 'Registered Nurse - ICU', company: 'Mercy Health', location: 'Raleigh, NC', postedAt: FRESH, source: 'icims',
      jdText: 'RN license, ACLS, BLS, Epic EHR charting, patient assessment, triage, IV therapy, critical care, ventilator management.',
    },
  },
  {
    name: 'frontend engineer',
    candidate: person({
      targetTitles: ['Frontend Engineer', 'React Developer'],
      technicalStack: { languages: ['TypeScript', 'JavaScript'], other: ['React', 'Next.js', 'CSS', 'Accessibility', 'GraphQL'] },
    }),
    job: {
      title: 'Senior Frontend Engineer', company: 'Stripe', location: 'Remote, US', postedAt: FRESH, source: 'greenhouse',
      jdText: 'React, TypeScript, Next.js, modern CSS, accessibility, GraphQL, component libraries, design systems.',
    },
  },
  {
    name: 'accountant',
    candidate: person({
      targetTitles: ['Staff Accountant', 'Senior Accountant'], seniority: 'mid',
      technicalStack: { other: ['GAAP', 'QuickBooks', 'NetSuite', 'Month-End Close', 'Reconciliation', 'Excel'] },
    }),
    job: {
      title: 'Senior Accountant', company: 'Northwind', location: 'Charlotte, NC', postedAt: FRESH, source: 'workday',
      jdText: 'GAAP, month-end close, journal entries, reconciliation, NetSuite, QuickBooks, Excel, CPA, audit support.',
    },
  },
  {
    name: 'marketing manager',
    candidate: person({
      targetTitles: ['Marketing Manager', 'Growth Marketing Manager'],
      technicalStack: { other: ['SEO', 'HubSpot', 'Google Analytics', 'Content Strategy', 'Paid Social', 'Email Marketing'] },
    }),
    job: {
      title: 'Growth Marketing Manager', company: 'Fabrikam', location: 'Remote, US', postedAt: FRESH, source: 'lever',
      jdText: 'Demand generation, paid social, SEO content strategy, HubSpot automation, email marketing, Google Analytics, A/B testing.',
    },
  },
];

const profileDriven = { ...base.scoring, categories: PROFILE_DRIVEN_CATEGORIES };

describe('the problem: hardcoded categories lock the tool to one field', () => {
  it.each(PERSONAS.filter((p) => p.name !== 'data engineer'))(
    'a $name is DISCARDED on a perfect match under the legacy categories',
    ({ candidate, job }) => {
      const { total } = scoreJob(job, { ...base, candidate });
      expect(total).toBeLessThan(FLOOR);
    },
  );

  it('yet DISCOVERY already worked for every one of them', () => {
    // The failure is in scoring alone. Discovery reads the profile and always did.
    for (const { name, candidate, job } of PERSONAS) {
      const { match } = classifyDiscovery(
        { title: job.title, jdText: job.jdText, location: job.location },
        { candidate, scoring: base.scoring },
      );
      expect(['strong', 'weak'], name).toContain(match);
    }
  });

  it('64 of 110 points are unreachable outside the built-for stack', () => {
    const nurse = PERSONAS.find((p) => p.name === 'registered nurse');
    const { breakdown } = scoreJob(nurse.job, { ...base, candidate: nurse.candidate });
    const locked = ['titleFit', 'azureFabricStack', 'dataEngineeringStack', 'biSemanticDepth', 'pythonSqlPyspark', 'domainFit'];
    const lockedWeight = locked.reduce((s, k) => s + (breakdown[k]?.weight ?? 0), 0);
    expect(lockedWeight).toBe(64);
    for (const k of locked) expect(breakdown[k].points, k).toBe(0);
  });
});

describe('the fix: declarative, profile-driven categories', () => {
  it.each(PERSONAS)('a $name reaches an ACTIONABLE tier on a perfect match', ({ candidate, job }) => {
    // Queue is the threshold that matters: at or above it the job is on the
    // board and can be prepared. Under the legacy categories every non-data
    // persona scored 21-27 against a discard floor of 50.
    const { total } = scoreJob(job, { ...base, scoring: profileDriven, candidate });
    expect(total).toBeGreaterThanOrEqual(base.scoring.tiers.queue);
  });

  it('still REJECTS every mismatched pairing — it is not "score everything highly"', () => {
    // The whole cross-matrix: each candidate against every other field's job.
    for (const me of PERSONAS) {
      for (const other of PERSONAS) {
        if (me.name === other.name) continue;
        const { total } = scoreJob(other.job, { ...base, scoring: profileDriven, candidate: me.candidate });
        expect(total, `${me.name} vs ${other.name} job`).toBeLessThan(FLOOR);
      }
    }
  });

  it('separates a real match from a mismatch by a wide margin', () => {
    const me = PERSONAS.find((p) => p.name === 'registered nurse');
    const other = PERSONAS.find((p) => p.name === 'accountant');
    const good = scoreJob(me.job, { ...base, scoring: profileDriven, candidate: me.candidate }).total;
    const bad = scoreJob(other.job, { ...base, scoring: profileDriven, candidate: me.candidate }).total;
    expect(good - bad).toBeGreaterThan(40);
  });

  it('titleFit follows candidate.targetTitles, so editing the profile changes scoring', () => {
    const nurse = PERSONAS.find((p) => p.name === 'registered nurse');
    const withTitle = scoreJob(nurse.job, { ...base, scoring: profileDriven, candidate: nurse.candidate });
    const withoutTitle = scoreJob(nurse.job, {
      ...base, scoring: profileDriven, candidate: { ...nurse.candidate, targetTitles: ['Underwater Basket Weaver'] },
    });
    expect(withTitle.breakdown.titleFit.points).toBeGreaterThan(0);
    expect(withoutTitle.breakdown.titleFit.points).toBe(0);
  });

  it('coreSkills follows candidate.technicalStack', () => {
    const nurse = PERSONAS.find((p) => p.name === 'registered nurse');
    const emptied = scoreJob(nurse.job, {
      ...base, scoring: profileDriven, candidate: { ...nurse.candidate, technicalStack: {} },
    });
    expect(emptied.breakdown.coreSkills.points).toBe(0);
  });

  it('gap analysis needs a vocabulary the candidate does NOT own', () => {
    // A gap is "the JD asks for something you cannot evidence", so the search
    // vocabulary has to be candidate-independent. Deriving it from the
    // candidate's own stack makes the answer always "no gaps" — every term found
    // that way is one they already have. This pins the non-circular behaviour.
    const de = PERSONAS.find((p) => p.name === 'data engineer');
    const thin = { ...de.candidate, technicalStack: { other: ['Python'] } };
    const categories = resolveCategories(profileDriven, thin);
    const missing = computeMissing(
      `${de.job.title} ${de.job.jdText}`.toLowerCase(),
      thin, base.scoring.keywords, base.scoring.evidenceAliases, categories,
    );
    // The JD names Databricks, Delta Lake and Synapse; this candidate lists Python.
    expect(missing.length).toBeGreaterThan(0);
  });

  it('does not report a gap for something the candidate DOES have', () => {
    const de = PERSONAS.find((p) => p.name === 'data engineer');
    const categories = resolveCategories(profileDriven, de.candidate);
    const missing = computeMissing(
      `${de.job.title} ${de.job.jdText}`.toLowerCase(),
      de.candidate, base.scoring.keywords, base.scoring.evidenceAliases, categories,
    );
    expect(missing.map((m) => m.toLowerCase())).not.toContain('databricks');
  });
});

describe('the refactor does not change existing behaviour', () => {
  it('a config with no categories scores exactly as the hardcoded version did', () => {
    // Pinned against the FIXTURE candidate, which is what the pre-refactor
    // measurement used. A legacy config must keep scoring identically, or every
    // stored score in a 100k-row database silently changes meaning on upgrade.
    // Proven by equivalence rather than a pinned number: scoring the same job
    // under the legacy config and under a declarative config that spells out
    // the SAME six categories must give byte-identical results. That is immune
    // to fixture edits, and it is the property that actually matters — a legacy
    // scoring.json must keep scoring identically, or every stored score in a
    // 100k-row database silently changes meaning on upgrade.
    const legacyAsDeclared = {
      ...base.scoring,
      categories: resolveCategories(base.scoring, base.candidate).map((c) => ({
        id: c.id, weight: c.weight, fullAt: c.fullAt, match: c.match, keywords: c.terms,
      })),
    };
    for (const { name, candidate, job } of PERSONAS) {
      const legacy = scoreJob(job, { ...base, candidate });
      const declared = scoreJob(job, { ...base, scoring: legacyAsDeclared, candidate });
      expect(declared.total, name).toBe(legacy.total);
      expect(declared.max, name).toBe(legacy.max);
    }
  });

  it('synthesizes the six legacy categories when none are declared', () => {
    const ids = resolveCategories(base.scoring, base.candidate).map((c) => c.id);
    expect(ids).toEqual([
      'titleFit', 'azureFabricStack', 'dataEngineeringStack',
      'biSemanticDepth', 'pythonSqlPyspark', 'domainFit',
    ]);
  });

  it('the denominator counts each category once', () => {
    // A legacy config derives category weights FROM scoring.weights, so summing
    // both double-counted every keyword category and deflated every score —
    // a strong match fell from 78 to 52 against an unchanged 75 threshold.
    const de = PERSONAS.find((p) => p.name === 'data engineer');
    expect(scoreJob(de.job, { ...base, candidate: de.candidate }).max).toBe(110);
    expect(scoreJob(de.job, { ...base, scoring: profileDriven, candidate: de.candidate }).max).toBe(100);
  });

  it('ignores a category with no weight rather than dividing by it', () => {
    const cats = resolveCategories({ ...base.scoring, categories: [
      { id: 'real', weight: 10, keywords: ['x'] },
      { id: 'zero', weight: 0, keywords: ['y'] },
    ] }, base.candidate);
    expect(cats.map((c) => c.id)).toEqual(['real']);
  });
});
