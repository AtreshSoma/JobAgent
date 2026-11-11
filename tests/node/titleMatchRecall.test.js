/**
 * titleFit recall: target titles must match the ways real postings title the
 * same role — "Data Engineering", "Engineer, Data" — without turning "Data
 * Entry" or an "Engineering Manager" into a data engineer.
 *
 * The positive cases are real titles from the live corpus that scored ZERO
 * title points against a profile targeting "Data Engineer" and friends.
 */
import { describe, it, expect } from 'vitest';

import { matchedTitlePhrases, foldTitle, TITLE_MATCH_VERSION } from '../../src/scoring/titleMatch.js';
import { scoreJob } from '../../src/scoring/scorer.js';
import { scoringFingerprint, scoringFingerprintMaterial } from '../../src/scoring/fingerprint.js';
import { loadTestConfig } from './helpers/testConfig.js';

const TARGETS = [
  'Senior Data Engineer', 'Data Engineer', 'Lead Data Engineer', 'Staff Data Engineer',
  'Analytics Engineer', 'Data Architect', 'Data Platform Engineer', 'BI Developer',
  'Business Intelligence Engineer',
];

const match = (title) => matchedTitlePhrases(title, TARGETS);

describe('title matching folds discipline words into role nouns', () => {
  it.each([
    ['Principal Engineer Data Engineering', 'Data Engineer'],
    ['Head of Financial Crimes Data Engineering', 'Data Engineer'],
    ['Specialist Solutions Architect - Data Engineering (Healthcare & Life Sciences)', 'Data Engineer'],
    ['Director, Data Architecture', 'Data Architect'],
    ['Data Engineering Lead', 'Data Engineer'],
    ['Sr Engineers, Data', 'Data Engineer'],
  ])('%s -> %s', (title, target) => {
    expect(match(title)).toContain(target);
  });

  it('does not fold a discipline word that describes somebody else\'s job', () => {
    expect(match('Data Engineering Recruiter')).toEqual([]);
    expect(match('Data Architecture Program Manager')).toEqual([]);
    expect(match('Sr. Product Manager, Data Engineering')).toEqual([]);
    expect(match('Audit Manager II (Business Intelligence Engineering)')).toEqual([]);
  });

  it('leaves "analytical" alone but reads "analytic" as "analytics"', () => {
    expect(match('Analytic Engineer')).toContain('Analytics Engineer');
    expect(match('Analytical Engineer')).toEqual([]);
  });
});

describe('title matching is order-insensitive for the role core', () => {
  it('matches the head noun followed by its modifiers', () => {
    expect(match('Engineer, Data')).toContain('Data Engineer');
    expect(match('Software Engineer, Data Platform')).toEqual(
      expect.arrayContaining(['Data Engineer', 'Data Platform Engineer']),
    );
    expect(match('Senior Engineer, Business Intelligence')).toContain('Business Intelligence Engineer');
    expect(match('Developer - BI')).toContain('BI Developer');
  });

  it('credits a level-qualified target only when the title states that level', () => {
    expect(match('Sr. Engineer, Data')).toEqual(expect.arrayContaining(['Senior Data Engineer', 'Data Engineer']));
    expect(match('Engineer, Data')).not.toContain('Senior Data Engineer');
    expect(match('Staff Software Engineer, Data Platform')).toContain('Staff Data Engineer');
    expect(match('Staff Software Engineer, Data Platform')).not.toContain('Lead Data Engineer');
  });

  it('does not reorder into a different compound noun', () => {
    expect(match('Engineer - Data Center Operations')).toEqual([]);
    expect(match('Engineer, Data Entry')).toEqual([]);
    expect(match('Engineer, Data Scientist')).toEqual([]);
    expect(match('Solutions Architect - Data & AI')).toEqual([]);
    expect(match('Systems Engineer - Data and Insights')).toEqual([]);
  });

  it('does not reorder behind a qualifier naming another craft', () => {
    expect(match('Senior Sales Engineer - Data')).toEqual([]);
    expect(match('Site Reliability Engineer, Data Platform')).toEqual([]);
    expect(match('Machine Learning Engineer, Data Infrastructure')).toEqual([]);
    expect(match('Field Service Engineer Analytics')).toEqual([]);
  });

  it('never turns non-data titles into data roles', () => {
    for (const title of ['Data Entry Clerk', 'Engineering Manager', 'Product Engineer - Datacenter',
      'Software Engineer', 'Director of Engineering', 'Architecture Intern']) {
      expect(match(title)).toEqual([]);
    }
  });
});

describe('title matching is a superset of the literal matcher', () => {
  it('keeps every literal match', () => {
    expect(match('Senior Data Engineer')).toEqual(expect.arrayContaining(['Senior Data Engineer', 'Data Engineer']));
    expect(match('BI Developer (Power BI)')).toContain('BI Developer');
  });

  it('preserves the caller\'s casing and ignores blank phrases', () => {
    expect(matchedTitlePhrases('Engineer, Data', ['DATA ENGINEER', '', null])).toEqual(['DATA ENGINEER']);
    expect(matchedTitlePhrases('', TARGETS)).toEqual([]);
    expect(matchedTitlePhrases('Engineer, Data', undefined)).toEqual([]);
  });

  it('treats a bare hyphen as part of a word and other punctuation as a break', () => {
    const { tokens, breakBefore } = foldTitle('Data-Engineering, Lead');
    expect(tokens).toEqual(['data', 'engineer', 'lead']);
    expect(breakBefore).toEqual([false, false, true]);
  });
});

describe('titleFit scoring uses the folded matcher', () => {
  const base = loadTestConfig({ loadEnv: false, env: {} });
  const scoring = {
    ...base.scoring,
    categories: [{ id: 'titleFit', label: 'Title fit', weight: 18, fullAt: 1, match: 'title', from: 'targetTitles' }],
  };
  const candidate = { ...base.candidate, targetTitles: ['Data Engineer'] };

  it('awards title points to "Principal Engineer Data Engineering"', () => {
    const score = scoreJob({ title: 'Principal Engineer Data Engineering', jdText: '' }, {
      scoring, sponsorship: { status: 'Unconfirmed' }, candidate,
    });
    expect(score.breakdown.titleFit.points).toBe(18);
    expect(score.breakdown.titleFit.matched).toEqual(['Data Engineer']);
  });

  it('still awards nothing to "Data Entry Specialist"', () => {
    const score = scoreJob({ title: 'Data Entry Specialist', jdText: '' }, {
      scoring, sponsorship: { status: 'Unconfirmed' }, candidate,
    });
    expect(score.breakdown.titleFit.points).toBe(0);
  });
});

describe('the scoring fingerprint carries the title-matching semantics', () => {
  it('fingerprints the matcher version, so a semantics change re-scores stored verdicts', () => {
    const base = loadTestConfig({ loadEnv: false, env: {} });
    expect(TITLE_MATCH_VERSION).toBeGreaterThanOrEqual(2);
    expect(scoringFingerprintMaterial(base).titleMatcher).toBe(TITLE_MATCH_VERSION);
    expect(scoringFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
  });
});
