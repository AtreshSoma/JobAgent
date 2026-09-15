/**
 * The resume -> job-search loop.
 *
 * Before this existed, uploading a new master resume changed nothing upstream:
 * `replaceMasterResume` wrote the file, discovery kept reading
 * `candidate.targetTitles`, and `scoreJob`'s `resumeKeywords` argument was
 * passed by no caller. A product-manager resume left the pipeline searching for
 * Senior Data Engineer indefinitely, silently. These tests pin both halves of
 * the fix: the drift is detected, and adopting it stays an explicit act.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, cpSync, copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  extractResumeEvidence, diffAgainstProfile, splitSections,
} from '../../src/resume/resumeProfile.js';
import { adoptResumeEvidence } from '../../src/config/profileStore.js';
import { isQueryFirstAdapter } from '../../src/search/sources.js';
import { runQuerySearch, runScore } from '../../src/cli/commands.js';
import { loadConfig, PROJECT_ROOT } from '../../src/config/loadConfig.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { normalizeJob } from '../../src/search/normalize.js';
import { extractDocxText } from '../../src/resume/docxText.js';
import { fixtureCandidate } from './helpers/testConfig.js';

/** A data-engineering resume, in the shape real ones take. */
const DE_RESUME = [
  'Priya Raghunathan',
  'Data Engineer | Cloud & Data Platform | Apache Spark & Lakehouse',
  'Durham, NC   |   555-0142   |   priya@example.com',
  'PROFESSIONAL SUMMARY',
  'Senior Data Engineer with 10+ years building cloud data platforms.',
  'SKILLS',
  'Cloud & Platform: Azure Databricks, Microsoft Fabric, Azure Synapse Analytics, OneLake',
  'Data Engineering: Azure Data Factory, Delta Live Tables, PySpark, Structured Streaming',
  'PROFESSIONAL EXPERIENCE',
  'Senior Data Engineer, Finance Analytics | Northwind Analytics',
  'Durham, NC (Remote) |   March 2021 - Present',
  'Architected cloud-native pipelines on Azure using Databricks and Delta Lake.',
  'Business Intelligence Developer | Tailspin Services',
  'Raleigh, NC   |   May 2018 - February 2021',
  'Orchestrated DataOps automation with Azure DevOps for quarterly audits.',
  'EDUCATION',
  'Master of Science in Computer Science | NC State University | 2016',
];

/** The same person after a career change. Nothing here is data engineering. */
const PM_RESUME = [
  'Priya Raghunathan',
  'Senior Product Manager | Fintech & Payments',
  'Austin, TX | priya@example.com',
  'PROFESSIONAL SUMMARY',
  'Product leader with 9 years shipping payments products.',
  'SKILLS',
  'Product: Roadmapping, Discovery, A/B Testing, Jira, Amplitude',
  'Domain: Payments, Risk, KYC, Compliance',
  'PROFESSIONAL EXPERIENCE',
  'Senior Product Manager, Payments | Northwind Financial',
  'Austin, TX (Hybrid) | March 2021 - Present',
  'Led a team of six engineers to launch a new checkout flow.',
  'Product Manager, Risk Platform | Contoso Pay',
  'Austin, TX | June 2018 - February 2021',
  'EDUCATION',
  'Master of Business Administration | Example State University | 2016',
];

describe('reading a resume as profile evidence', () => {
  it('splits a resume into labelled sections', () => {
    const kinds = splitSections(DE_RESUME).map((s) => s.kind);
    expect(kinds).toContain('header');
    expect(kinds).toContain('skills');
    expect(kinds).toContain('experience');
    expect(kinds).toContain('education');
  });

  it('extracts the role titles and nothing else', () => {
    const { titles } = extractResumeEvidence(DE_RESUME);
    expect(titles).toContain('Data Engineer');
    expect(titles).toContain('Senior Data Engineer');
    expect(titles).toContain('Business Intelligence Developer');
  });

  it.each([
    ['a city from the location line', 'Durham'],
    ['a city from the location line', 'Raleigh'],
    ['a headline tagline', 'Cloud & Data Platform'],
    ['a headline tagline', 'Apache Spark & Lakehouse'],
    ['an achievement bullet', 'Orchestrated DataOps automation with Azure DevOps'],
  ])('never proposes %s as a search target: %s', (_kind, value) => {
    // Each of these used to survive extraction, and each would have become a
    // real query against real job boards.
    expect(extractResumeEvidence(DE_RESUME).titles).not.toContain(value);
  });

  it('extracts skills from the skills section only', () => {
    const { skills } = extractResumeEvidence(DE_RESUME);
    expect(skills).toContain('Azure Databricks');
    expect(skills).toContain('Delta Live Tables');
    // Prose from the summary and bullets must not become match vocabulary.
    expect(skills.some((s) => s.includes('years'))).toBe(false);
    expect(skills.every((s) => s.split(/\s+/).length <= 4)).toBe(true);
  });

  it('reads the real shipped example resume and proposes only real roles', () => {
    // Guards the parser against the actual .docx in the repository, not just
    // hand-written fixtures — the leaks it used to produce (cities, taglines,
    // bullets) all came from this document's real formatting.
    const bytes = readFileSync(join(PROJECT_ROOT, 'resumes', 'base', 'MASTER_RESUME.example.docx'));
    const { titles, skills } = extractResumeEvidence(extractDocxText(bytes).paragraphs);

    expect(titles.length).toBeGreaterThan(0);
    expect(skills.length).toBeGreaterThan(10);
    // Every proposed title must name a role. This is the property that keeps
    // junk out of real job-board queries.
    const ROLE = /engineer|developer|analyst|architect|manager|specialist|scientist|consultant|lead|director/i;
    for (const title of titles) expect(ROLE.test(title), title).toBe(true);
    // And none of them may be a city, a date line or a sentence.
    for (const title of titles) {
      expect(/\b(19|20)\d{2}\b/.test(title), title).toBe(false);
      expect(title.endsWith('.'), title).toBe(false);
    }
  });
});

describe('comparing the resume with what is actually searched', () => {
  it('reports a matching resume as NOT drifted', () => {
    const diff = diffAgainstProfile(extractResumeEvidence(DE_RESUME), fixtureCandidate);
    expect(diff.drifted).toBe(false);
    expect(diff.coverage).toBeGreaterThan(0.5);
    expect(diff.matchedTitles.length).toBeGreaterThan(0);
  });

  it('DETECTS a career change — the case the whole feature exists for', () => {
    const diff = diffAgainstProfile(extractResumeEvidence(PM_RESUME), fixtureCandidate);
    expect(diff.drifted).toBe(true);
    expect(diff.coverage).toBe(0);
    expect(diff.newTitles).toContain('Senior Product Manager');
    // The message has to say the thing that is not obvious: uploading changed nothing.
    expect(diff.summary).toMatch(/discovery follows the profile, not the resume/i);
  });

  it('matches the same role across seniority levels', () => {
    const diff = diffAgainstProfile(
      { titles: ['Lead Data Engineer'], skills: [] },
      { targetTitles: ['Data Engineer'], technicalStack: {} },
    );
    expect(diff.newTitles).toEqual([]);
    expect(diff.matchedTitles[0].coveredBy).toBe('Data Engineer');
  });

  it('reports skills the profile stack does not already carry', () => {
    const diff = diffAgainstProfile(extractResumeEvidence(PM_RESUME), fixtureCandidate);
    expect(diff.newSkills).toContain('Roadmapping');
    // Already in the fixture stack, so not proposed again.
    const de = diffAgainstProfile(extractResumeEvidence(DE_RESUME), fixtureCandidate);
    expect(de.newSkills).not.toContain('Azure Data Factory');
  });

  it('treats an empty resume as no evidence rather than total drift', () => {
    const diff = diffAgainstProfile({ titles: [], skills: [] }, fixtureCandidate);
    expect(diff.drifted).toBe(false);
  });
});

describe('adopting evidence is explicit, additive and validated', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'adopt-'));
    cpSync(join(PROJECT_ROOT, 'config'), join(root, 'config'), { recursive: true });
    copyFileSync(
      join(PROJECT_ROOT, 'tests', 'node', 'fixtures', 'config', 'candidate.json'),
      join(root, 'config', 'candidate.json'),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const read = () => JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));

  it('adds a title to targetTitles without removing any', () => {
    const before = read().targetTitles;
    const r = adoptResumeEvidence(root, { titles: ['Senior Product Manager'] });
    expect(r.addedTitles).toEqual(['Senior Product Manager']);
    const after = read().targetTitles;
    expect(after).toEqual([...before, 'Senior Product Manager']);
  });

  it('adds skills to technicalStack.other', () => {
    adoptResumeEvidence(root, { skills: ['Roadmapping'] });
    expect(read().technicalStack.other).toContain('Roadmapping');
  });

  it('is idempotent — re-adopting adds nothing', () => {
    adoptResumeEvidence(root, { titles: ['Senior Product Manager'] });
    const again = adoptResumeEvidence(root, { titles: ['Senior Product Manager'] });
    expect(again.addedTitles).toEqual([]);
    expect(read().targetTitles.filter((t) => t === 'Senior Product Manager')).toHaveLength(1);
  });

  it('ignores a skill already present under a different stack category', () => {
    // "Python" lives under languages, not other — it must not be duplicated.
    expect(adoptResumeEvidence(root, { skills: ['Python'] }).addedSkills).toEqual([]);
  });

  it('keeps a backup of the previous profile', () => {
    expect(adoptResumeEvidence(root, { titles: ['Data Steward'] }).backup).toBeTruthy();
  });

  it('refuses a title list that would make every run unaffordable', () => {
    const many = Array.from({ length: 60 }, (_, i) => `Role Number ${i}`);
    // Every title is searched against every configured board on every run.
    expect(() => adoptResumeEvidence(root, { titles: many })).toThrow(/limit 40/);
  });

  it('writes nothing when the selection is empty', () => {
    const r = adoptResumeEvidence(root, {});
    expect(r.addedTitles).toEqual([]);
    expect(r.backup).toBe(null);
  });
});

describe('ad-hoc query search', () => {
  let root;
  let config;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qsearch-'));
    cpSync(join(PROJECT_ROOT, 'config'), join(root, 'config'), { recursive: true });
    copyFileSync(
      join(PROJECT_ROOT, 'tests', 'node', 'fixtures', 'config', 'candidate.json'),
      join(root, 'config', 'candidate.json'),
    );
    config = loadConfig({ root, loadEnv: false, env: {} });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ctx = () => {
    const db = openDatabase({ path: ':memory:' });
    const { logger: pino } = createPinoLogger({ toFile: false });
    return { db, logger: new JobLogger({ db, logger: pino }) };
  };

  const pmJob = normalizeJob({
    source: 'atsSearch', company: 'Northwind', title: 'Senior Product Manager, Payments',
    sourceJobId: 'PM-1', postedAt: new Date().toISOString(), location: 'Remote, US',
    url: 'https://jobs.workable.com/view/pm1',
    jdText: 'Own the payments roadmap. Discovery, A/B testing, stakeholder management, checkout and risk.',
  });
  const searchFn = async () => ({ jobs: [pmJob], duplicates: [], errors: [] });

  it('only the query-first adapters are eligible', () => {
    expect(isQueryFirstAdapter('atsSearch')).toBe(true);
    expect(isQueryFirstAdapter('adzuna')).toBe(true);
    // Company-first sources enumerate a fixed tenant list — 226 Workday tenants
    // at ~14 minutes is not a search box.
    expect(isQueryFirstAdapter('workday')).toBe(false);
    expect(isQueryFirstAdapter('greenhouse')).toBe(false);
  });

  it('a NORMAL run discards an off-profile role', async () => {
    const { db, logger } = ctx();
    await runScore({ config, db, logger, deps: { searchFn } });
    // This is correct behaviour: the threshold is what keeps 97,000 unrelated
    // rows off the board.
    expect(db.getJob(pmJob.id).status).toBe('discarded');
  });

  it('a QUERY SEARCH keeps the row the user actually asked for', async () => {
    const { db, logger } = ctx();
    const result = await runQuerySearch({ config, db, logger, query: 'Senior Product Manager', deps: { searchFn } });
    const row = db.getJob(pmJob.id);
    expect(row.status).toBe('scored');
    // The score is still recorded, and is still low — it is computed from a
    // keyword vocabulary for a different role. It is information, not a verdict.
    expect(row.score).toBeLessThan(50);
    expect(result.query).toBe('Senior Product Manager');
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('does not write the query into the saved profile', async () => {
    const { db, logger } = ctx();
    const before = readFileSync(join(root, 'config', 'candidate.json'), 'utf8');
    await runQuerySearch({ config, db, logger, query: 'Senior Product Manager', deps: { searchFn } });
    expect(readFileSync(join(root, 'config', 'candidate.json'), 'utf8')).toBe(before);
  });

  it('rejects an empty or oversized query', async () => {
    const { db, logger } = ctx();
    await expect(runQuerySearch({ config, db, logger, query: '  ', deps: { searchFn } }))
      .rejects.toThrow(/needs a query/);
    await expect(runQuerySearch({ config, db, logger, query: 'x'.repeat(200), deps: { searchFn } }))
      .rejects.toThrow(/too long/);
  });

  it('explains itself when no query-capable source is enabled', async () => {
    const { db, logger } = ctx();
    const disabled = {
      ...config,
      jobboards: {
        ...config.jobboards,
        sources: config.jobboards.sources.map((s) => (
          isQueryFirstAdapter(s.adapter) ? { ...s, enabled: false } : s
        )),
      },
    };
    await expect(runQuerySearch({ config: disabled, db, logger, query: 'anything', deps: { searchFn } }))
      .rejects.toThrow(/no query-capable source/);
  });
});
