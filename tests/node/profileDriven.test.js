/**
 * Does this tool work for somebody who is not the person it was written for?
 *
 * The question has three parts, and the system used to fail all three:
 *
 *   1. Does a different resume change what is SEARCHED for?  No — discovery
 *      read `candidate.targetTitles`, and nothing wrote it.
 *   2. Does a different candidate change what SCORES well?   No — 46 of 110
 *      points lived in `azureFabricStack`, `biSemanticDepth` and
 *      `pythonSqlPyspark`. Measured here: a marketing manager scored 30 on a
 *      perfect marketing job (below the 50 discard floor) and 62 on a DATA
 *      ENGINEERING job. The tool preferred the previous candidate's field.
 *   3. Does switching candidates LEAK anything?              Yes — the domain
 *      vocabulary was a hardcoded data/analytics seed list injected into every
 *      profile, so a marketing profile accepted "ETL Developer" and
 *      "Lakehouse Platform Engineer".
 *
 * These tests use three substantially different synthetic candidates — a
 * different profession, seniority, stack, industry and work authorization each
 * — and assert that every stage downstream of the profile genuinely differs,
 * and that nothing survives a profile switch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRoleFamilies, profileFamilies, classifyTitleAgainstFamilies } from '../../src/profile/roleFamilies.js';
import { normalizeProfile, toCandidateConfig, fromCandidateConfig } from '../../src/profile/model.js';
import { deriveFromProfile, applyScoring, applyExclusions, deriveSeniorityExclusions } from '../../src/profile/derive.js';
import {
  saveProfile, listProfiles, activateProfile, readActiveProfile, deleteProfile,
  migrateLegacyCandidate, mergeIntoActiveProfile, safeId,
} from '../../src/profile/store.js';
import { buildProfileVocabulary, classifyTitleFit } from '../../src/scoring/profileFit.js';
import { classifyDiscovery } from '../../src/search/discoveryFilter.js';
import { scoreJob } from '../../src/scoring/scorer.js';
import { sortJobsForQueue } from '../../src/scoring/jobRanking.js';
import { applyExclusions as runExclusions } from '../../src/scoring/exclusionFilter.js';
import { searchTermsFor } from '../../src/search/adapters/workday.js';
import { buildBackground, compareToActiveProfile, profileFromResume } from '../../src/profile/fromResume.js';
import { loadTestConfig } from './helpers/testConfig.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const taxonomy = loadRoleFamilies(REPO);
const base = loadTestConfig({ loadEnv: false, env: {} });
const FRESH = new Date(Date.now() - 2 * 864e5).toISOString();

/* ─────────────────────────── three candidates ─────────────────────────── */

/**
 * Three people who share nothing: profession, level, tools, industry, pay and
 * work authorization all differ. If any stage produces the same answer for two
 * of them, that stage is not reading the profile.
 */
const PEOPLE = {
  dataEngineer: normalizeProfile({
    id: 'dana-data', label: 'Dana — Senior Data Engineer',
    identity: { fullName: 'Dana Okafor', headline: 'Senior Data Engineer' },
    background: {
      currentRoles: ['Senior Data Engineer'], earlierRoles: ['BI Developer'],
      yearsExperience: 9, seniority: 'senior', industries: ['Banking'],
      skills: ['Azure Data Factory', 'Databricks', 'PySpark', 'Delta Lake', 'Power BI', 'Python', 'SQL'],
      leadership: { hasManaged: true, evidence: ['Mentored three engineers'] },
    },
    searchIntent: {
      targetRoles: ['Senior Data Engineer', 'Analytics Engineer'], seniority: 'senior',
      skillsToKeep: ['Azure Data Factory', 'Databricks', 'PySpark', 'Delta Lake', 'Power BI', 'Python', 'SQL'],
      industries: ['Banking'], workModes: ['remote', 'hybrid'],
      workAuthorization: { status: 'H-1B', requiresSponsorship: true },
      compensation: { minAnnual: 150000, currency: 'USD' },
    },
  }),

  regulatoryAffairs: normalizeProfile({
    id: 'remi-regulatory', label: 'Remi — Regulatory Affairs Specialist',
    identity: { fullName: 'Remi Castellano', headline: 'Regulatory Affairs Specialist' },
    background: {
      currentRoles: ['Regulatory Affairs Specialist'], earlierRoles: ['Quality Assurance Associate'],
      yearsExperience: 5, seniority: 'mid', industries: ['Medical Device', 'Pharmaceutical'],
      skills: ['510(k)', 'ISO 13485', 'CAPA', '21 CFR Part 11', 'Design Control', 'Veeva'],
      leadership: { hasManaged: false, evidence: [] },
    },
    searchIntent: {
      targetRoles: ['Regulatory Affairs Specialist'], seniority: 'mid',
      skillsToKeep: ['510(k)', 'ISO 13485', 'CAPA', '21 CFR Part 11', 'Design Control', 'Veeva'],
      industries: ['Medical Device'], workModes: ['onsite', 'hybrid'],
      workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
      compensation: { minAnnual: 95000, currency: 'USD' },
    },
  }),

  marketingGrad: normalizeProfile({
    id: 'morgan-marketing', label: 'Morgan — Marketing Coordinator (new grad)',
    identity: { fullName: 'Morgan Ellis', headline: 'Marketing Coordinator' },
    background: {
      currentRoles: ['Marketing Coordinator'], earlierRoles: ['Social Media Intern'],
      yearsExperience: 1, seniority: 'entry', industries: ['Retail', 'E-Commerce'],
      skills: ['SEO', 'HubSpot', 'Google Analytics', 'Content Strategy', 'Paid Social', 'Mailchimp'],
      leadership: { hasManaged: false, evidence: [] },
    },
    searchIntent: {
      targetRoles: ['Marketing Coordinator'], seniority: 'entry',
      skillsToKeep: ['SEO', 'HubSpot', 'Google Analytics', 'Content Strategy', 'Paid Social', 'Mailchimp'],
      industries: ['Retail'], workModes: ['remote', 'onsite', 'hybrid'],
      workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
      compensation: { minAnnual: 55000, currency: 'USD' },
    },
  }),
};

/** A perfectly-matching posting for each person, and nothing else. */
const JOBS = {
  dataEngineer: {
    title: 'Senior Data Engineer', company: 'Northwind Bank', location: 'Remote, US',
    postedAt: FRESH, source: 'greenhouse',
    jdText: 'Build Azure Data Factory and Databricks pipelines with PySpark and Delta Lake. '
      + 'Power BI semantic models, Python, SQL. Banking data platform. Own the lakehouse roadmap and mentor engineers.',
  },
  regulatoryAffairs: {
    title: 'Regulatory Affairs Specialist', company: 'Meridian Medical', location: 'Raleigh, North Carolina',
    postedAt: FRESH, source: 'workday',
    jdText: 'Prepare 510(k) submissions for medical device products. Maintain ISO 13485 quality systems, '
      + 'CAPA records and 21 CFR Part 11 compliance. Design control documentation in Veeva. FDA correspondence.',
  },
  marketingGrad: {
    title: 'Marketing Coordinator', company: 'Bright Retail', location: 'Remote, US',
    postedAt: FRESH, source: 'lever',
    jdText: 'Support demand generation campaigns. SEO content strategy, HubSpot marketing automation, '
      + 'Google Analytics reporting, paid social and Mailchimp email marketing for our retail brand.',
  },
};

const derivedFor = (key) => deriveFromProfile(PEOPLE[key], { taxonomy });
const NAMES = Object.keys(PEOPLE);

/** The runtime config a person's profile generates, ready for scoreJob. */
function runtimeFor(key) {
  const derived = derivedFor(key);
  return {
    candidate: derived.candidate,
    scoring: applyScoring(base.scoring, derived),
    exclusions: applyExclusions(base.exclusions, derived),
    derived,
  };
}

/* ────────────────────────────── the profile model ────────────────────────── */

describe('background (evidence) is kept separate from search intent (preference)', () => {
  it('never lets the resume overwrite what the person says they want', () => {
    // The career-changer case: a resume full of the field being LEFT.
    const changer = normalizeProfile({
      id: 'changer', label: 'Career changer',
      background: { currentRoles: ['Staff Accountant'], skills: ['GAAP', 'NetSuite'], seniority: 'mid' },
      searchIntent: { targetRoles: ['Product Manager'], seniority: 'mid', skillsToKeep: ['Roadmapping', 'Jira'] },
    });
    const candidate = toCandidateConfig(changer);
    // Discovery follows INTENT...
    expect(candidate.targetTitles).toContain('Product Manager');
    expect(candidate.targetTitles).not.toContain('Staff Accountant');
    // ...while the evidence is still recorded, because tailoring needs it.
    expect(changer.background.currentRoles).toEqual(['Staff Accountant']);
    expect(candidate.technicalStack.background).toContain('GAAP');
    expect(candidate.technicalStack.core).toContain('Roadmapping');
  });

  it('round-trips a legacy candidate.json without losing anything searchable', () => {
    const profile = fromCandidateConfig(base.candidate);
    const back = toCandidateConfig(profile);
    expect(back.targetTitles).toEqual(base.candidate.targetTitles);
    expect(back.contact.email).toBe(base.candidate.contact.email);
    expect(back.workAuthorization.requiresSponsorship)
      .toBe(base.candidate.workAuthorization.requiresSponsorship);
  });

  it('records skills with their ORIGIN, so growth skills are never claimed as experience', () => {
    const p = normalizeProfile({
      id: 'x', background: { skills: ['Excel'] },
      searchIntent: { targetRoles: ['Analyst'], skillsToKeep: ['SQL'], skillsToGrow: ['Python'] },
    });
    const c = toCandidateConfig(p);
    expect(c.technicalStack.core).toEqual(['SQL']);
    expect(c.technicalStack.background).toEqual(['Excel']);
    expect(c.technicalStack.growth).toEqual(['Python']);
  });
});

/* ──────────────────────── every stage differs per person ─────────────────── */

describe('three different candidates produce three different searches', () => {
  it('derives a different role FAMILY for each', () => {
    const families = NAMES.map((n) => profileFamilies(PEOPLE[n], taxonomy)[0]?.id);
    expect(families).toEqual(['data-analytics', 'regulatory-quality', 'marketing-growth']);
    expect(new Set(families).size).toBe(3);
  });

  it('derives different SEARCH QUERIES, and never the trailing-token remnant', () => {
    const queries = Object.fromEntries(NAMES.map((n) => [n, derivedFor(n).searchPhrases]));
    expect(queries.dataEngineer).toEqual(['data engineer']);
    expect(queries.marketingGrad).toEqual(['marketing coordinator']);
    // The measured bug: the old trailing-two-token rule turned "Regulatory
    // Affairs Specialist" into "affairs specialist", keeping the word every
    // field shares and dropping the one that identifies this one.
    expect(queries.regulatoryAffairs).toEqual(['regulatory affairs']);
    expect(queries.regulatoryAffairs[0]).not.toContain('specialist');
    const all = Object.values(queries).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it('reaches every phrase-based adapter through one derived list', () => {
    for (const name of NAMES) {
      const { candidate, derived } = runtimeFor(name);
      expect(searchTermsFor(candidate)).toEqual(derived.searchPhrases);
    }
  });

  it('expands each into TITLE VARIATIONS from its own family, and only its own', () => {
    const titles = Object.fromEntries(NAMES.map((n) => [n, derivedFor(n).candidate.targetTitles]));
    // Role families -> title variations: more than what was typed, all on-field.
    expect(titles.dataEngineer.length).toBeGreaterThan(PEOPLE.dataEngineer.searchIntent.targetRoles.length);
    expect(titles.dataEngineer).toContain('Data Architect');
    expect(titles.regulatoryAffairs).toContain('Regulatory Affairs Manager');
    expect(titles.marketingGrad).toContain('Marketing Specialist');
    // and nothing from anyone else's field.
    expect(titles.marketingGrad.join(' ')).not.toMatch(/Data|Regulatory|Nurse/i);
    expect(titles.regulatoryAffairs.join(' ')).not.toMatch(/Marketing|Databricks/i);
  });

  it('does not offer a role a LEVEL above the one that was asked for', () => {
    // Morgan is a new graduate who typed "Marketing Coordinator". Offering
    // "Digital Marketing Manager" is the same failure as offering a job from
    // another field — a role they did not ask for, presented as one they did —
    // and it is how a personalized search quietly becomes a generic one.
    // Specialist is one step from Coordinator and stays; Manager is two.
    const marketing = derivedFor('marketingGrad').candidate;
    expect(marketing.targetTitles).toContain('Marketing Specialist');
    expect(marketing.targetTitles.join(' ')).not.toMatch(/Marketing Manager|Marketing Director/);

    // The same ladder read from the other end: Remi asked for a Specialist, so
    // Manager is one step up and IS offered. The rule is about distance, not
    // about the word "manager".
    expect(derivedFor('regulatoryAffairs').candidate.targetTitles)
      .toContain('Regulatory Affairs Manager');
  });

  it('separates the roles that were ASKED FOR from the ways employers name them', () => {
    // Two tiers, because only one of them may be decisive. `anchorTitles` is
    // what the candidate typed (plus level prefixes of it); `adjacentTitles` is
    // what the family calls the same work. A title gate that treated both as
    // decisive is what turned three stated data-engineering roles into
    // twenty-three, among them Data Coordinator and Quantitative Analyst.
    const data = derivedFor('dataEngineer').candidate;
    expect(data.anchorTitles).toContain('Data Engineer');
    expect(data.anchorTitles).toContain('Analytics Engineer');
    expect(data.adjacentTitles).toContain('Data Architect');
    // An anchor is never also an adjacent title.
    expect(data.adjacentTitles.filter((t) => data.anchorTitles.includes(t))).toEqual([]);
    // targetTitles stays the union, so every existing reader keeps working.
    for (const t of [...data.anchorTitles, ...data.adjacentTitles]) {
      expect(data.targetTitles).toContain(t);
    }
  });

  it('drops family siblings that are a different CRAFT or an unevidenced subject', () => {
    const data = derivedFor('dataEngineer').candidate;
    const all = data.targetTitles.join(' | ');
    // Different craft: this profile asked to BUILD, not to analyze, manage or
    // administer. Every one of these sits in the same data-analytics family and
    // was previously admitted on the shared token "data" alone.
    for (const off of ['Data Analyst', 'Data Scientist', 'Data Coordinator', 'Data Steward',
      'Database Administrator', 'Quantitative Analyst', 'Reporting Analyst',
      'Analytics Manager', 'Analytics Consultant']) {
      expect(all).not.toContain(off);
    }
    // Same craft, but a subject this profile cannot evidence anywhere.
    expect(all).not.toContain('Machine Learning Engineer');
    // Same craft AND an evidenced subject — Power BI evidences "bi", and the
    // taxonomy states that "business intelligence" IS "bi".
    expect(data.adjacentTitles).toContain('BI Engineer');
    expect(data.adjacentTitles).toContain('Business Intelligence Engineer');
  });

  it('keeps the SEARCH list small even when the RECOGNIZED list grows', () => {
    // Expansion is free for scoring and costs a request per phrase for
    // discovery. Conflating the two would have multiplied every run's cost.
    for (const name of NAMES) {
      const d = derivedFor(name);
      expect(d.searchPhrases.length).toBeLessThanOrEqual(4);
      expect(d.candidate.targetTitles.length).toBeGreaterThanOrEqual(d.searchPhrases.length);
    }
  });

  it('derives different seniority EXCLUSIONS, and excludes nothing for a new graduate', () => {
    // The shipped exclusions.json hardcoded "junior"/"entry level"/"intern",
    // which would hard-discard every job the graduate is qualified for.
    expect(deriveSeniorityExclusions('senior')).toContain('junior');
    expect(deriveSeniorityExclusions('mid')).not.toContain('junior');
    expect(deriveSeniorityExclusions('entry')).toEqual([]);
    expect(runtimeFor('marketingGrad').exclusions.roleMismatchDerived).toEqual([]);
    expect(runtimeFor('dataEngineer').exclusions.roleMismatchDerived).toContain('entry level');
  });

  it('a graduate keeps a junior posting that a senior profile discards', () => {
    const junior = {
      title: 'Junior Marketing Coordinator', company: 'Bright Retail', location: 'Remote, US',
      postedAt: FRESH, jdText: 'Entry level marketing support role. SEO, HubSpot.',
    };
    const grad = runtimeFor('marketingGrad');
    const senior = runtimeFor('dataEngineer');
    expect(runExclusions(junior, grad.exclusions).excluded).toBe(false);
    expect(runExclusions(junior, senior.exclusions).excluded).toBe(true);
  });
});

describe('filtering decisions follow the active profile', () => {
  it('each person ACCEPTS their own posting and REJECTS both of the others', () => {
    const table = {};
    for (const who of NAMES) {
      const vocab = buildProfileVocabulary(runtimeFor(who).candidate, { taxonomy });
      table[who] = Object.fromEntries(
        NAMES.map((job) => [job, classifyTitleFit(JOBS[job].title, vocab).verdict]),
      );
    }
    for (const who of NAMES) {
      expect(table[who][who], `${who} must accept their own role`).toBe('accept');
      for (const other of NAMES.filter((n) => n !== who)) {
        expect(table[who][other], `${who} must reject a ${other} role`).toBe('reject');
      }
    }
  });

  it('classifies discovery as a strong match only for the right person', () => {
    for (const who of NAMES) {
      const { candidate, scoring } = runtimeFor(who);
      const mine = classifyDiscovery(JOBS[who], { candidate, scoring });
      expect(mine.match, `${who} on their own job`).toBe('strong');
      for (const other of NAMES.filter((n) => n !== who)) {
        expect(classifyDiscovery(JOBS[other], { candidate, scoring }).match)
          .not.toBe('strong');
      }
    }
  });

  it('still DEFERS an unreadable title rather than rejecting it', () => {
    // A wrong reject is silent and permanent; a wrong defer costs one score.
    const vocab = buildProfileVocabulary(runtimeFor('marketingGrad').candidate, { taxonomy });
    expect(classifyTitleFit('Member of Technical Staff', vocab).verdict).toBe('defer');
    expect(classifyTitleFit('', vocab).verdict).toBe('defer');
  });
});

describe('scoring and ranking follow the active profile', () => {
  const sponsorship = { status: 'Unconfirmed' };

  it('scores each person HIGHEST on their own job — the measured inversion is gone', () => {
    // BEFORE: with the shipped data-engineering categories a marketing manager
    // scored 30 on a perfect marketing job (discarded, floor 50) and 62 on a
    // data-engineering job. The tool preferred the previous candidate's field.
    const floor = base.scoring.tiers.nearMiss;
    for (const who of NAMES) {
      const { candidate, scoring } = runtimeFor(who);
      const own = scoreJob(JOBS[who], { scoring, candidate, sponsorship }).total;
      expect(own, `${who} on their own perfect match`).toBeGreaterThan(floor);
      for (const other of NAMES.filter((n) => n !== who)) {
        const foreign = scoreJob(JOBS[other], { scoring, candidate, sponsorship }).total;
        expect(foreign, `${who} must not prefer a ${other} job`).toBeLessThan(own);
        expect(foreign, `${who} must discard a ${other} job`).toBeLessThan(floor);
      }
    }
  });

  it('ranks the same three postings differently for each person', () => {
    const orders = NAMES.map((who) => {
      const { candidate, scoring } = runtimeFor(who);
      const scored = NAMES.map((job) => ({
        ...JOBS[job], id: job,
        score: scoreJob(JOBS[job], { scoring, candidate, sponsorship }).total,
      }));
      return sortJobsForQueue(scored).map((j) => j.id)[0];
    });
    expect(orders).toEqual(NAMES); // each person's own job ranks first
  });

  it('reports GAPS in the candidate own field, not in a fixed vocabulary', () => {
    // `computeMissing` used to search `scoring.keywords`, a data-engineering
    // word list, so a non-engineer was told they had no gaps — not because they
    // had none but because nothing was looking for theirs.
    const { candidate, scoring } = runtimeFor('regulatoryAffairs');
    const jd = {
      ...JOBS.regulatoryAffairs,
      jdText: `${JOBS.regulatoryAffairs.jdText} Experience with PMA submissions, MDR and TrackWise required.`,
    };
    const { missingKeywords } = scoreJob(jd, { scoring, candidate, sponsorship });
    expect(scoring.marketSkills).toContain('trackwise');
    expect(missingKeywords.join(' ')).toMatch(/pma|mdr|trackwise/);
  });

  it('gives every person a reachable score — no profile is structurally capped', () => {
    for (const who of NAMES) {
      const { candidate, scoring } = runtimeFor(who);
      const { max, breakdown } = scoreJob(JOBS[who], { scoring, candidate, sponsorship });
      expect(max).toBe(100);
      expect(breakdown.titleFit.points).toBeGreaterThan(0);
      expect(breakdown.coreSkills.points).toBeGreaterThan(0);
    }
  });
});

/* ───────────────────────────── no leakage ───────────────────────────────── */

describe('switching profiles leaks nothing from the previous candidate', () => {
  it('leaks no TITLES, SKILLS or INDUSTRIES into the generated config', () => {
    const configs = Object.fromEntries(NAMES.map((n) => [n, runtimeFor(n).candidate]));
    const leakTerms = {
      dataEngineer: ['databricks', 'pyspark', 'delta lake', 'data engineer'],
      regulatoryAffairs: ['510(k)', 'iso 13485', 'regulatory affairs', 'capa'],
      marketingGrad: ['hubspot', 'seo', 'marketing coordinator', 'paid social'],
    };
    for (const who of NAMES) {
      const text = JSON.stringify(configs[who]).toLowerCase();
      for (const other of NAMES.filter((n) => n !== who)) {
        for (const term of leakTerms[other]) {
          expect(text, `${who} config must not mention ${other}'s "${term}"`).not.toContain(term);
        }
      }
    }
  });

  it('leaks no DOMAIN VOCABULARY into the matching vocabulary', () => {
    // The measured leak: DOMAIN_SEEDS was a data/analytics list injected into
    // EVERY profile, so a marketing candidate accepted "ETL Developer" and
    // "Lakehouse Platform Engineer".
    const marketing = buildProfileVocabulary(runtimeFor('marketingGrad').candidate, { taxonomy });
    for (const word of ['etl', 'lakehouse', 'warehouse', 'semantic', 'dimensional', 'data lake']) {
      expect(marketing.domain, `marketing vocabulary must not contain "${word}"`).not.toContain(word);
    }
    for (const title of ['ETL Developer', 'Lakehouse Platform Engineer', 'Data Warehouse Engineer']) {
      expect(classifyTitleFit(title, marketing).verdict, title).toBe('reject');
    }
  });

  it('leaks no SCORING assumptions — every profession scores its OWN job highest', () => {
    // Asserted as the property that matters rather than as "all three totals
    // differ". Distinctness was a proxy, and a brittle one: two unrelated
    // professions both scoring badly on a data-engineering role is the CORRECT
    // outcome, and whether their totals happen to round to the same integer
    // says nothing about leakage. (They did: 33.0 and 33.2.)
    const sponsorship = { status: 'Unconfirmed' };
    const score = (who, job) => {
      const { candidate, scoring } = runtimeFor(who);
      return scoreJob(job, { scoring, candidate, sponsorship }).total;
    };
    for (const who of NAMES) {
      const own = score(who, JOBS[who]);
      for (const other of NAMES.filter((n) => n !== who)) {
        const foreign = score(who, JOBS[other]);
        expect(own, `${who} should score their own job above ${other}'s`).toBeGreaterThan(foreign);
      }
    }
  });

  it('leaks no SENIORITY assumption — a graduate is not judged as a senior', () => {
    const sponsorship = { status: 'Unconfirmed' };
    const grad = runtimeFor('marketingGrad');
    const senior = runtimeFor('dataEngineer');
    const entryJob = { ...JOBS.marketingGrad, title: 'Junior Marketing Coordinator' };
    const gradPoints = scoreJob(entryJob, { ...grad, sponsorship }).breakdown.seniorityFit.points;
    const seniorPoints = scoreJob(entryJob, { ...senior, sponsorship }).breakdown.seniorityFit.points;
    expect(gradPoints).toBeGreaterThan(seniorPoints);
  });

  it('leaks no SPONSORSHIP assumption', () => {
    expect(runtimeFor('dataEngineer').candidate.sponsorshipRequired).toBe(true);
    expect(runtimeFor('marketingGrad').candidate.sponsorshipRequired).toBe(false);
  });

  it('leaks no GEOGRAPHY assumption — usOnly follows the profile', () => {
    const global = normalizeProfile({
      id: 'g', searchIntent: { targetRoles: ['Data Engineer'], usOnly: false },
    });
    expect(applyExclusions(base.exclusions, deriveFromProfile(global, { taxonomy })).geography.usOnly).toBe(false);
    expect(runtimeFor('dataEngineer').exclusions.geography.usOnly).toBe(true);
  });

  it('preserves the exclusion phrases the USER wrote when switching', () => {
    const mine = { ...base.exclusions, roleMismatch: ['my own hand written rule'] };
    for (const who of NAMES) {
      const out = applyExclusions(mine, derivedFor(who));
      expect(out.roleMismatch).toEqual(['my own hand written rule']);
    }
  });
});

/* ─────────────────────────── the store, end to end ───────────────────────── */

describe('profiles can be saved, switched and re-run without editing source', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'job-agent-profiles-'));
    mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
    for (const file of ['candidate.json', 'scoring.json', 'exclusions.json']) {
      writeFileSync(join(root, 'config', file), readFileSync(join(REPO, 'config', file)));
    }
    // The fixture candidate, so the temp root never carries real personal data.
    writeFileSync(join(root, 'config', 'candidate.json'), `${JSON.stringify(base.candidate, null, 2)}\n`);
    for (const file of ['candidate.schema.json', 'scoring.schema.json', 'exclusions.schema.json']) {
      writeFileSync(join(root, 'config', 'schemas', file), readFileSync(join(REPO, 'config', 'schemas', file)));
    }
    writeFileSync(join(root, 'config', 'role_families.json'), readFileSync(join(REPO, 'config', 'role_families.json')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('migrates an existing hand-written candidate.json into the first profile', () => {
    const result = migrateLegacyCandidate(root);
    expect(result.migrated).toBe(true);
    expect(readActiveProfile(root).searchIntent.targetRoles).toEqual(base.candidate.targetTitles);
    // Idempotent.
    expect(migrateLegacyCandidate(root).migrated).toBe(false);
  });

  it('saves, lists and switches between all three candidates', () => {
    for (const person of Object.values(PEOPLE)) saveProfile(root, person);
    expect(listProfiles(root).profiles).toHaveLength(3);

    for (const key of NAMES) {
      const summary = activateProfile(root, PEOPLE[key].id);
      expect(summary.written).toContain('config/candidate.json');

      const candidate = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
      const scoring = JSON.parse(readFileSync(join(root, 'config', 'scoring.json'), 'utf8'));
      const exclusions = JSON.parse(readFileSync(join(root, 'config', 'exclusions.json'), 'utf8'));

      expect(candidate.targetTitles[0]).toBe(PEOPLE[key].searchIntent.targetRoles[0]);
      expect(candidate.searchPhrases).toEqual(derivedFor(key).searchPhrases);
      expect(scoring.categories.map((c) => c.id)).toEqual(['titleFit', 'coreSkills', 'domainFit']);
      expect(exclusions.roleMismatchDerived).toEqual(deriveSeniorityExclusions(PEOPLE[key].searchIntent.seniority));
      expect(readActiveProfile(root).id).toBe(PEOPLE[key].id);
    }
  });

  it('a switched-away candidate leaves nothing behind in the live config', () => {
    for (const person of Object.values(PEOPLE)) saveProfile(root, person);
    activateProfile(root, PEOPLE.dataEngineer.id);
    activateProfile(root, PEOPLE.marketingGrad.id);
    const live = readFileSync(join(root, 'config', 'candidate.json'), 'utf8').toLowerCase();
    for (const term of ['databricks', 'pyspark', 'delta lake', 'data engineer', 'h-1b']) {
      expect(live, `switching away must drop "${term}"`).not.toContain(term);
    }
  });

  it('keeps a backup of every file it replaces', () => {
    saveProfile(root, PEOPLE.dataEngineer);
    activateProfile(root, PEOPLE.dataEngineer.id);
    expect(existsSync(join(root, 'config', 'candidate.json.bak'))).toBe(true);
    expect(existsSync(join(root, 'config', 'scoring.json.bak'))).toBe(true);
  });

  it('refuses to activate a profile that would search for nothing', () => {
    saveProfile(root, normalizeProfile({ id: 'empty', label: 'Empty', searchIntent: { targetRoles: [] } }));
    expect(() => activateProfile(root, 'empty')).toThrow(/no target roles/i);
  });

  it('refuses to delete the active profile, and refuses a path-shaped id', () => {
    saveProfile(root, PEOPLE.dataEngineer);
    activateProfile(root, PEOPLE.dataEngineer.id);
    expect(() => deleteProfile(root, PEOPLE.dataEngineer.id)).toThrow(/active/i);
    expect(safeId('../../etc/passwd')).toBe('etc-passwd');
  });

  it('merges selected evidence additively, removing nothing the user chose', () => {
    saveProfile(root, PEOPLE.marketingGrad);
    activateProfile(root, PEOPLE.marketingGrad.id);
    const result = mergeIntoActiveProfile(root, {
      roles: ['Content Marketing Specialist'], skills: ['Klaviyo'], industries: ['E-Commerce'],
    });
    expect(result.addedRoles).toEqual(['Content Marketing Specialist']);
    const after = readActiveProfile(root);
    expect(after.searchIntent.targetRoles).toContain('Marketing Coordinator'); // kept
    expect(after.searchIntent.targetRoles).toContain('Content Marketing Specialist'); // added
    expect(after.searchIntent.skillsToKeep).toContain('Klaviyo');
  });

  it('a dry run reports the whole effect and writes nothing', () => {
    saveProfile(root, PEOPLE.regulatoryAffairs);
    const before = readFileSync(join(root, 'config', 'candidate.json'), 'utf8');
    const summary = activateProfile(root, PEOPLE.regulatoryAffairs.id, { dryRun: true });
    expect(summary.searchPhrases).toEqual(['regulatory affairs']);
    expect(summary.written).toEqual([]);
    expect(readFileSync(join(root, 'config', 'candidate.json'), 'utf8')).toBe(before);
  });
});

/* ───────────────────── resume upload: detect, offer, never assume ────────── */

describe('a new resume is analysed, compared and OFFERED — never applied silently', () => {
  /** A resume for someone in a completely different field. */
  const NURSE_RESUME = [
    'Priya Raman',
    'Registered Nurse | Critical Care',
    'priya.raman@example.com | 555-0100',
    'Professional Summary',
    'Registered Nurse with 7 years of experience in critical care and emergency nursing.',
    'Experience',
    'Registered Nurse | Mercy General Hospital',
    'Raleigh, NC | March 2019 - Present',
    'Led a team of four nurses across the ICU night shift.',
    'ICU Nurse | Lakeside Medical Center',
    'Durham, NC | June 2017 - February 2019',
    'Skills',
    'Clinical: ACLS, BLS, Epic, Patient Assessment, IV Therapy, Triage',
    'Certifications',
    'Registered Nurse License, North Carolina',
    'Education',
    'Bachelor of Science in Nursing | State University | 2017',
  ];

  it('reads a resume into structured BACKGROUND', () => {
    const background = buildBackground(NURSE_RESUME, { sourceFile: 'MASTER_RESUME.docx' });
    expect(background._name).toBe('Priya Raman');
    expect(background.currentRoles.join(' ')).toMatch(/Registered Nurse/i);
    expect(background.yearsExperience).toBe(7);
    expect(background.seniority).toBeTruthy();
    expect(background.skills.join(' ')).toMatch(/ACLS/);
    expect(background.industries.join(' ')).toMatch(/Healthcare|Clinical/i);
    expect(background.leadership.hasManaged).toBe(true);
    expect(background.education[0].institution).toMatch(/State University|Bachelor/);
    expect(background.source).toBe('resume');
  });

  it('detects that this is a DIFFERENT candidate from the active profile', () => {
    const verdict = compareToActiveProfile(
      buildBackground(NURSE_RESUME), PEOPLE.dataEngineer, taxonomy,
    );
    expect(verdict.relation).toBe('different');
    expect(verdict.familyOverlap).toBe(0);
    expect(verdict.reasons.join(' ')).toMatch(/Dana Okafor|Healthcare/i);
  });

  it('recognizes the SAME candidate when the resume matches', () => {
    const same = buildBackground([
      'Dana Okafor',
      'Senior Data Engineer',
      'dana@example.com',
      'Experience',
      'Senior Data Engineer | Northwind',
      'Raleigh, NC | 2019 - Present',
      'Skills',
      'Data: Azure Data Factory, Databricks, PySpark, Delta Lake, Power BI, Python, SQL',
    ]);
    expect(compareToActiveProfile(same, PEOPLE.dataEngineer, taxonomy).relation).toBe('same');
  });

  it('proposes a profile WITHOUT adopting it, and offers exactly three choices', () => {
    const proposal = profileFromResume(NURSE_RESUME, { currentProfile: PEOPLE.dataEngineer });
    // The proposal is the nurse's...
    expect(proposal.searchIntent.targetRoles.join(' ')).toMatch(/Nurse/i);
    expect(proposal.identity.fullName).toBe('Priya Raman');
    // ...and it carries NONE of the previous person's identity or contact.
    expect(proposal.contact.email).toBe('');
    expect(JSON.stringify(proposal).toLowerCase()).not.toContain('databricks');
    // The active profile is untouched — proposing is not adopting.
    expect(PEOPLE.dataEngineer.searchIntent.targetRoles).toEqual(['Senior Data Engineer', 'Analytics Engineer']);
  });

  it('inherits SEARCH preferences a resume cannot state, but never another person\'s FACTS', () => {
    // Work authorization, pay and start date are not facts a resume asserts —
    // and they are also not facts the PREVIOUS person can assert on this one's
    // behalf. Inheriting them is not "leaving them blank rather than inventing
    // them"; it is inventing them, with someone else's real answer. These go
    // verbatim onto employers' forms, so Priya's application would have stated
    // Dana's immigration status and Dana's salary expectation.
    const proposal = profileFromResume(NURSE_RESUME, { currentProfile: PEOPLE.dataEngineer });
    expect(proposal.searchIntent.workAuthorization.status).toBe('');
    expect(proposal.searchIntent.workAuthorization.requiresSponsorship).toBe(null);
    expect(proposal.searchIntent.compensation.minAnnual).toBe(null);
    expect(proposal.searchIntent.startDate).toBe('');
    // A preference about the SEARCH is not a fact about the person, so it is
    // still carried over rather than making the user restate it.
    expect(proposal.searchIntent.workModes).toEqual(PEOPLE.dataEngineer.searchIntent.workModes);
  });

  it('does carry a person\'s own facts forward when the resume names THEM', () => {
    // The same human building a second search direction should not have to
    // retype their own contact details, salary expectation or work
    // authorization — the tool already holds them, about them.
    const samePersonResume = NURSE_RESUME.map(
      (line) => (line === 'Priya Raman' ? PEOPLE.dataEngineer.identity.fullName : line),
    );
    const proposal = profileFromResume(samePersonResume, { currentProfile: PEOPLE.dataEngineer });
    expect(proposal.identity.fullName).toBe(PEOPLE.dataEngineer.identity.fullName);
    expect(proposal.searchIntent.workAuthorization.status).toBe('H-1B');
    expect(proposal.searchIntent.compensation.minAnnual).toBe(150000);
    // Still their NEW direction: the background and targets come from the resume.
    expect(proposal.searchIntent.targetRoles.join(' ')).toMatch(/Nurse/i);
  });

  it('creates a second profile instead of replacing the first one with the same name', () => {
    // A resume-derived id used to be the candidate's name alone, so building a
    // second search from the same resume produced the same id and saveProfile
    // overwrote the profile it promised to keep switchable.
    const first = profileFromResume(NURSE_RESUME);
    const second = profileFromResume(NURSE_RESUME, { existingIds: [first.id] });
    expect(second.id).not.toBe(first.id);
    const third = profileFromResume(NURSE_RESUME, { existingIds: [first.id, second.id] }).id;
    expect([first.id, second.id]).not.toContain(third);
  });

  it('the proposed profile immediately produces a nursing search', () => {
    const proposal = profileFromResume(NURSE_RESUME);
    const derived = deriveFromProfile(proposal, { taxonomy });
    expect(derived.families[0].id).toBe('healthcare-clinical');
    expect(derived.searchPhrases.join(' ')).toMatch(/nurse/i);
    expect(derived.candidate.targetTitles.join(' ')).toMatch(/Nurse/i);
  });
});

/* ───────────────────────── the taxonomy is data, not code ────────────────── */

describe('the role taxonomy is editable data with no privileged family', () => {
  it('is applied uniformly — every family can reject every other', () => {
    const ids = Object.keys(taxonomy.families);
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) {
      const family = taxonomy.families[id];
      expect(family.roles.length, `${id} needs role phrases`).toBeGreaterThan(0);
      expect(family.domain.length, `${id} needs domain terms`).toBeGreaterThan(0);
    }
  });

  it('adding a family to the DATA changes behaviour with no code change', () => {
    const custom = {
      weights: taxonomy.weights,
      families: {
        ...taxonomy.families,
        falconry: {
          id: 'falconry', label: 'Falconry',
          roles: ['master falconer', 'raptor handler'], heads: ['falconer', 'handler'],
          domain: ['falconry', 'raptor', 'hawking'], skills: ['jesses', 'telemetry'],
        },
      },
    };
    const falconer = normalizeProfile({
      id: 'f', searchIntent: { targetRoles: ['Master Falconer'], skillsToKeep: ['Jesses'] },
    });
    const families = profileFamilies(falconer, custom);
    expect(families[0].id).toBe('falconry');
    expect(classifyTitleAgainstFamilies('Raptor Handler', families, custom).verdict).toBe('accept');
    expect(classifyTitleAgainstFamilies('Senior Data Engineer', families, custom).verdict).toBe('reject');
  });

  it('degrades to DEFER, never to a wrong reject, when the taxonomy is missing', () => {
    const empty = { families: {}, weights: {} };
    const p = normalizeProfile({ id: 'p', searchIntent: { targetRoles: ['Anything At All'] } });
    const families = profileFamilies(p, empty);
    expect(families).toEqual([]);
    expect(classifyTitleAgainstFamilies('Registered Nurse', families, empty).verdict).toBe('defer');
  });
});
