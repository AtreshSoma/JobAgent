/**
 * Profile-driven role fit.
 *
 * Discovery used to reject any title it did not recognize, BEFORE the job
 * description existed. Measured against 55,293 already-scored postings, that
 * discarded 12.6% of everything the scorer itself rated 60 or better. These
 * tests pin the four things that must stay true: unconventional titles survive,
 * adjacent role families survive, clearly-other work is still rejected, and
 * broadening recall does not put weak matches on the board.
 */
import { describe, it, expect } from 'vitest';

import {
  buildProfileVocabulary, classifyTitleFit, titleFitPriority, assessScope, seniorityRank,
} from '../../src/scoring/profileFit.js';
import { rawTier, TIERS } from '../../src/scoring/explainScore.js';
import { makeTitleGate } from '../../src/search/adapters/atsSearch.js';
import { scoreJob } from '../../src/scoring/scorer.js';
import { loadTestConfig, legacyScoringShape } from './helpers/testConfig.js';

const config = loadTestConfig({ loadEnv: false, env: {} });
const vocab = buildProfileVocabulary(config.candidate);
const verdict = (t) => classifyTitleFit(t, vocab).verdict;
const kept = (t) => verdict(t) !== 'reject';

describe('unconventional titles for the same underlying job', () => {
  it('keeps the employer-specific titles that motivated this work', () => {
    // Supplied as examples of roles that must be found. The third one failed
    // the old gate outright: its regex required a domain token immediately
    // before a role token, and "Business Intelligence" comes AFTER "Engineer".
    for (const title of [
      'Lead Cloud Data Engineer – Multi-Cloud Data Platforms',
      'Power BI Developer – MES 4.0 Reporting',
      'Senior Manager, IT Engineer Business Intelligence – Power BI Field Reporting',
    ]) {
      expect(verdict(title), title).toBe('accept');
    }
  });

  it('is not defeated by punctuation between the domain and the role word', () => {
    // The old character class `[\w\s/-]` excluded the EN DASH, so an employer
    // who typed "–" instead of "-" made the posting invisible.
    for (const dash of ['-', '–', '—', ',', '/', '|']) {
      expect(verdict(`Business Intelligence ${dash} Reporting Engineer`), dash).toBe('accept');
    }
  });

  it('accepts a role named only by a technology from the profile', () => {
    // No domain word, no configured title — but unmistakably in profile.
    for (const title of ['Databricks Senior Architect', 'Azure Fabric Consultant', 'Power BI Specialist']) {
      expect(verdict(title), title).toBe('accept');
    }
  });

  it('accepts role-then-domain ordering, which the old regex required in reverse', () => {
    for (const title of ['Engineer/Sr Engineer, IT Data', 'Lead, Data Warehousing', 'Principal Engineer, Data & AI']) {
      expect(verdict(title), title).toBe('accept');
    }
  });
});

describe('adjacent role families a senior data engineer would take', () => {
  it('keeps leadership, architecture and consulting variants', () => {
    for (const title of [
      'Head of Data Platform', 'Director of Business Intelligence',
      'Analytics Engineering Manager', 'Manager, Enterprise Reporting & Insights',
      'Senior Decision Intelligence Engineer', 'Informatics Architect',
      'Data & AI Architect', 'Senior Consultant - Data & Analytics',
      'Master Data Management Lead', 'Reporting & Analytics Lead',
    ]) {
      expect(kept(title), title).toBe(true);
    }
  });

  it('defers rather than rejects a title it simply cannot read', () => {
    // The whole point: "unknown" must not be fatal. The description decides.
    expect(verdict('Snowflake Developer')).toBe('defer');
    expect(verdict('Member of Technical Staff')).toBe('defer');
    expect(verdict('')).toBe('defer');
  });
});

describe('clearly irrelevant work is still rejected', () => {
  it('rejects other professions', () => {
    for (const title of [
      'Registered Nurse', 'Truck Driver', 'Executive Chef', 'High School Teacher',
      'Attorney - Litigation', 'Security Guard', 'Massage Therapist', 'Firefighter',
    ]) {
      expect(verdict(title), title).toBe('reject');
    }
  });

  it('rejects other engineering crafts and business functions', () => {
    // "Accounts Payable Administrator" is not hypothetical — an aggregator
    // full-text query for "data engineer" really returns it, because the phrase
    // appears somewhere in the body.
    for (const title of [
      'iOS Engineer', 'Frontend Engineer', 'Mechanical Engineer', 'Sales Engineer',
      'Accounts Payable Administrator', 'Account Executive', 'Customer Success Manager',
      'Marketing Manager', 'Administrative Assistant', 'Loan Officer',
    ]) {
      expect(verdict(title), title).toBe('reject');
    }
  });

  it('lets a profile signal override an otherwise-rejected word', () => {
    // The reject lists are overridden by domain evidence, so a genuinely
    // relevant role is never lost to a word that merely appears in it.
    expect(kept('Frontend Engineer, Analytics Platform')).toBe(true);
    expect(kept('Sales Analytics Engineer')).toBe(true);
    expect(kept('Data Engineer, Clinical Nursing Systems')).toBe(true);
  });
});

describe('early-filter false negatives (the measured regression)', () => {
  it('recovers real strong-scoring roles the old boolean gate discarded', () => {
    // Every title here is a real posting from the local corpus that the scorer
    // rated 60+ after reading its description, and that the old title gate
    // would have thrown away before the description was ever fetched.
    const oldGate = makeTitleGate({ titles: config.candidate.targetTitles, strict: true });
    const recovered = [
      'Senior Systems Engineer - Business Analytics Platforms', // scored 81
      'Senior BI & AI Engineer', // 74
      'Engineer/Sr Engineer, IT Data', // 72
      'Senior Databricks Developer, SAP S/4 Data Products and Governance', // 71
      'Senior Engineer, Business Intelligence', // 70
      'Informatics Architect', // 68
      'Databricks Senior Architect', // 68
    ];
    for (const title of recovered) {
      expect(oldGate(title), `old gate should have dropped: ${title}`).toBe(false);
      expect(kept(title), `new model must keep: ${title}`).toBe(true);
    }
  });

  it('the gate is profile-driven, not a hardcoded title list', () => {
    // A different profile must change the answer with no code change.
    const other = buildProfileVocabulary({
      targetTitles: ['Registered Nurse'],
      technicalStack: { clinical: ['Epic', 'Meditech'] },
      seniority: 'senior',
    });
    expect(classifyTitleFit('Registered Nurse', other).verdict).toBe('accept');
    expect(classifyTitleFit('Epic Analyst', other).verdict).toBe('accept');
  });
});

describe('recall does not flood the board with weak matches', () => {
  it('holds a deferred-title posting to the higher queue bar', () => {
    const t = config.scoring.tiers;
    // 55 is a near miss for a recognized title...
    expect(rawTier(55, t, 'accept')).toBe(TIERS.NEAR_MISS);
    // ...but a title that told us nothing must prove more on content.
    expect(rawTier(55, t, 'defer')).toBe(TIERS.DISCARD);
    // Above the queue threshold the content already speaks for itself.
    expect(rawTier(65, t, 'defer')).toBe(TIERS.QUEUE);
    expect(rawTier(90, t, 'defer')).toBe(TIERS.PRIORITY);
  });

  it('spends a limited description budget on the most certain fits first', () => {
    const titles = ['Snowflake Developer', 'Senior Data Engineer', 'Databricks Architect', 'Registered Nurse'];
    const ranked = [...titles].sort((a, b) => titleFitPriority(b, vocab) - titleFitPriority(a, vocab));
    expect(ranked[0]).toBe('Senior Data Engineer'); // exact configured title
    expect(titleFitPriority('Registered Nurse', vocab)).toBe(-1);
    expect(titleFitPriority('Snowflake Developer', vocab)).toBe(0); // deferred, last
  });
});

describe('seniority and scope influence fit', () => {
  const base = {
    company: 'Acme', location: 'Remote, US', source: 'greenhouse',
    postedAt: new Date().toISOString(),
  };
  const stack = 'Azure Databricks, PySpark, Delta Lake, Power BI semantic models, Python, SQL, ADF.';

  /**
   * REGRESSION: seniority was detected over the whole document, so the VERB in
   * "you will lead the design" read as a Lead-level role, one rung above a
   * senior candidate, and cost 3.2 of 8 points for good news.
   *
   * The INVARIANT is that leadership language never costs points. Whether it
   * also GAINS any depends on the scoring shape, and that difference is real
   * rather than incidental: under the legacy categories the extra prose happens
   * to add keyword hits ("lakehouse", "data platform") to an unsaturated
   * bucket, so the total rises 65 -> 67. Under the profile-driven categories
   * the posting already saturates both seniorityFit and coreSkills, so it
   * stays 79 -> 79. Asserting a strict increase on both would be pinning an
   * artifact of the legacy saturation points, not the fix.
   */
  it.each([
    ['profile-driven (generated from the active profile)', config.scoring],
    ['legacy weights/keywords shape', legacyScoringShape(config.scoring)],
  ])('never penalizes a posting for describing leadership — %s', (_label, scoring) => {
    const plain = scoreJob({ ...base, title: 'Senior Data Engineer', jdText: stack },
      { scoring, candidate: config.candidate });
    const leaderly = scoreJob({
      ...base,
      title: 'Senior Data Engineer',
      jdText: `${stack} You will lead the design of our lakehouse and mentor engineers. You will own the data platform roadmap.`,
    }, { scoring, candidate: config.candidate });

    expect(leaderly.breakdown.seniorityFit.points).toBeGreaterThanOrEqual(plain.breakdown.seniorityFit.points);
    expect(leaderly.total).toBeGreaterThanOrEqual(plain.total);
    expect(leaderly.breakdown.seniorityFit.matched.join(' ')).toMatch(/ownership|leadership|seniority/);
  });

  it('still rewards the leadership prose wherever the categories have room for it', () => {
    const legacy = legacyScoringShape(config.scoring);
    const plain = scoreJob({ ...base, title: 'Senior Data Engineer', jdText: stack },
      { scoring: legacy, candidate: config.candidate });
    const leaderly = scoreJob({
      ...base,
      title: 'Senior Data Engineer',
      jdText: `${stack} You will lead the design of our lakehouse and mentor engineers. You will own the data platform roadmap.`,
    }, { scoring: legacy, candidate: config.candidate });
    expect(leaderly.total).toBeGreaterThan(plain.total);
  });

  it('treats a step up as a fit and a step down as a mismatch', () => {
    const of = (title) => scoreJob({ ...base, title, jdText: stack },
      { scoring: config.scoring, candidate: config.candidate }).breakdown.seniorityFit.points;
    // Candidate is "senior": Lead is the natural next step, Junior is not.
    expect(of('Lead Data Engineer')).toBeGreaterThan(of('Junior Data Engineer'));
    expect(of('Senior Data Engineer')).toBeGreaterThan(of('Junior Data Engineer'));
  });

  it('reads level from the title even when the body is full of leadership prose', () => {
    expect(seniorityRank('Junior Data Engineer')).toBeLessThan(seniorityRank('Senior Data Engineer'));
    expect(seniorityRank('Principal Data Engineer')).toBeGreaterThan(seniorityRank('Senior Data Engineer'));
  });

  it('reports ownership and leadership evidence for auditability', () => {
    const scope = assessScope({
      title: 'Data Platform Lead',
      jdText: 'You will own the data platform roadmap and mentor engineers across Databricks and Power BI.',
    }, vocab);
    expect(scope.leadership).toBe(true);
    expect(scope.ownership).toBe(true);
    expect(scope.techHits.length).toBeGreaterThan(0);
  });
});

describe('a job that was never read is not called a bad fit', () => {
  it('caps a description-less posting below the tier floor, by arithmetic', () => {
    // This is the mechanism, not an accident: with no description there are no
    // stack/domain/keyword hits available, so the reachable maximum is ~44/100
    // against a 50 floor. EVERY summary-only row is a guaranteed Discard
    // however perfect the role. Measured: 31,409 such rows, 2 ever surfaced.
    const teaser = scoreJob({
      title: 'Senior Data Engineer', company: 'Acme', location: 'Remote, US',
      source: 'workday', postedAt: new Date().toISOString(),
      jdText: 'Senior Data Engineer. Remote, US. R-12345',
      rawMetadata: { summaryOnly: true },
    }, { scoring: config.scoring, candidate: config.candidate });

    const full = scoreJob({
      title: 'Senior Data Engineer', company: 'Acme', location: 'Remote, US',
      source: 'workday', postedAt: new Date().toISOString(),
      jdText: 'Build Azure Databricks pipelines with PySpark, Delta Lake, Power BI '
        + 'semantic models, Python, SQL and Azure Data Factory. Medallion architecture.',
    }, { scoring: config.scoring, candidate: config.candidate });

    expect(teaser.total).toBeLessThan(config.scoring.tiers.nearMiss);
    expect(full.total).toBeGreaterThan(teaser.total + 20);
    // The identical role differs only by whether anyone read it.
  });

  it('rejects the bare technology tokens that match other fields entirely', () => {
    // "Fabric" as a lone token matched silicon interconnect and product names —
    // NVIDIA "ARM Fabric Unit Level", HPE "Network Fabric", Salesforce "Agent
    // Fabric" — none of which are Microsoft Fabric. The multi-word phrase is
    // unambiguous and must still work.
    for (const t of [
      'Senior Verification Engineer - ARM Fabric Unit Level',
      'Hardware Network Fabric Development Engineer',
      'Product Manager, Agent Fabric',
    ]) {
      expect(verdict(t), t).not.toBe('accept');
    }
    for (const t of ['Senior Microsoft Fabric Data Modeler', 'Delta Lake Platform Engineer']) {
      expect(verdict(t), t).toBe('accept');
    }
  });
});
