/**
 * Eligibility gates: a posting's stated floor (years, degree, clearance)
 * against the candidate — extracted conservatively, applied as a bounded
 * penalty, never as a discard.
 *
 * The snippets are shaped after real descriptions in the corpus, including the
 * false positives the extractor had to learn to ignore.
 */
import { describe, it, expect } from 'vitest';

import {
  analyzeRequirements, extractYearsRequirement, extractDegreeRequirement,
  candidateYearsOfExperience, candidateDegreeLevel, parseResumeMonth,
  assessEligibility, eligibilityPenalty, DEGREE_LEVELS, DEFAULT_ELIGIBILITY_PENALTY, ELIGIBILITY_VERSION,
} from '../../src/scoring/eligibility.js';
import { scoreJob } from '../../src/scoring/scorer.js';
import { explainScore } from '../../src/scoring/explainScore.js';
import { scoringFingerprint, scoringFingerprintMaterial } from '../../src/scoring/fingerprint.js';
import { applyExclusions, hardClearanceRequirement } from '../../src/scoring/exclusionFilter.js';
import { normalizeText } from '../../src/utils/textNormalize.js';
import { loadTestConfig } from './helpers/testConfig.js';

const NOW = new Date('2026-09-23T12:00:00Z');
const years = (jd) => extractYearsRequirement(jd)?.years ?? null;

describe('years-of-experience floor extraction', () => {
  it.each([
    ['Requirements:\n- 5+ years of experience in data engineering', 5],
    ['Minimum of 8 years of professional experience building distributed systems.', 8],
    ['At least 10 years of experience in data architecture', 10],
    ['Minimum five (5) years of experience as a data engineer', 5],
    ['Eight or more years of professional experience working as a data analyst', 8],
    ['Relevant Work Experience\n5-7 Years', 5],
    ['Minimum 5 year(s) of experience is required', 5],
  ])('%j -> %i', (jd, want) => {
    expect(years(jd)).toBe(want);
  });

  it('reads a range as its low end: "3-5 years"', () => {
    expect(years('Qualifications\n3-5 years of experience with Python')).toBe(3);
    expect(years('3–5 years of professional data engineering experience')).toBe(3);
  });

  it('ignores company age', () => {
    expect(extractYearsRequirement('We have been in business for 30 years. You will build pipelines.')).toBe(null);
    expect(extractYearsRequirement('For over 25 years, Acme has served clients across the country.')).toBe(null);
    expect(extractYearsRequirement('A transportation company with over 20 years of experience delivering logistics solutions.')).toBe(null);
    expect(extractYearsRequirement('Within 2 years you will lead the team.')).toBe(null);
  });

  it('treats preferred material as no floor', () => {
    expect(extractYearsRequirement('5+ years preferred')).toEqual(
      expect.objectContaining({ years: null, preferredOnly: true }),
    );
    expect(years('Nice to have:\n- 8+ years with Scala')).toBe(null);
    expect(years('Requirements:\n• 3+ years of SQL\n\nPreferred Qualifications:\n• 8+ years of experience')).toBe(3);
  });

  it('does not let a "desired" bullet mark the rest of the list optional', () => {
    expect(years('Kafka experience is desired\n7+ years of experience in Spark')).toBe(7);
  });

  it('keeps a floor whose domain is only preferably narrower', () => {
    expect(years('5+ years of experience in product management, preferably in automotive')).toBe(5);
  });

  it('takes the main floor, not a sub-requirement inside it', () => {
    expect(years('8+ years of data engineering, software engineering, or data-platform experience, including 2+ years leading engineers')).toBe(8);
    expect(years('7+ years of software engineering\n3+ years with Spark')).toBe(7);
  });

  it('takes the easiest of education-keyed alternative paths', () => {
    expect(years("Bachelor's degree and 8 years of experience, or Master's degree and 6 years of experience")).toBe(6);
    const paths = analyzeRequirements(
      "Bachelor's degree with 10+ years of relevant experience, or\nMaster's degree with 6+ years of relevant experience\nHigh school diploma and 12 years of experience",
    );
    expect(paths.years.years).toBe(6);
    expect(paths.degree).toBe(null);
  });

  it('reads Walmart-style options as alternatives', () => {
    const r = analyzeRequirements(
      "Option 1: Bachelor's degree in Computer Science and 2 years' experience in data engineering.\n"
      + "Option 2: 5 years' experience in data engineering.\n"
      + "Option 3: Master's degree in Computer Science and 1 year's experience in data engineering.",
    );
    expect(r.years.years).toBe(1);
    expect(r.degree).toBe(null);
  });

  it('returns null when nothing is stated', () => {
    expect(extractYearsRequirement('')).toBe(null);
    expect(extractYearsRequirement(null)).toBe(null);
    expect(extractYearsRequirement('Build pipelines with Spark and dbt.')).toBe(null);
  });

  it('quotes the evidence phrase', () => {
    expect(extractYearsRequirement('Requirements:\n- 5+ years of experience in data engineering').evidence)
      .toBe('5+ years of experience in data engineering');
  });
});

describe('degree requirement extraction', () => {
  it('reads a required degree level', () => {
    expect(extractDegreeRequirement('PhD in Computer Science or related field required'))
      .toEqual(expect.objectContaining({ level: DEGREE_LEVELS.doctorate, equivalent: false }));
    expect(extractDegreeRequirement('B.S. in Computer Science. 7+ years building data platforms.'))
      .toEqual(expect.objectContaining({ level: DEGREE_LEVELS.bachelor }));
  });

  it('takes the lowest degree a clause accepts', () => {
    expect(extractDegreeRequirement("Bachelor's or Master's degree in Computer Science").level).toBe(DEGREE_LEVELS.bachelor);
    // Measured: 89 of 3,000 stored descriptions use the "BS, MS, or PhD"
    // shape, which read as a PhD requirement. With this fix and the two below
    // (PhD as a shortcut, PhD as a noun), an 8-year M.S. candidate went from
    // "ineligible" on 206 of those 3,000 postings to 176.
    expect(extractDegreeRequirement('BS, MS, or PhD in Computer Science or a related field').level).toBe(DEGREE_LEVELS.bachelor);
    expect(extractDegreeRequirement('MS or Ph.D. in quantitative fields').level).toBe(DEGREE_LEVELS.master);
    expect(extractDegreeRequirement('PhD/Master in machine learning or statistics').level).toBe(DEGREE_LEVELS.master);
  });

  it('does not read a PhD offered as a shortcut, or PhD as a noun, as a requirement', () => {
    expect(extractDegreeRequirement('5+ years (or Ph.D. with 3+ years) of experience in machine learning')).toBe(null);
    expect(extractDegreeRequirement('As a partner to the AI/ML PhD recruiting team, you will drive hiring')).toBe(null);
  });

  it('reads "For Ph.D. holders / For M.S. holders" as alternative paths', () => {
    const r = analyzeRequirements(
      'Minimum qualifications:\nFor Ph.D. holders: 8+ years of industry experience in applied science.\n'
      + 'For M.S. holders: 12+ years of industry experience in applied science.',
    );
    expect(r.degree.level).toBe(DEGREE_LEVELS.master);
    expect(r.years.years).toBe(8);
  });

  it('ignores a preferred degree', () => {
    expect(extractDegreeRequirement("Bachelor's degree in Computer Science required. Master's degree preferred.").level)
      .toBe(DEGREE_LEVELS.bachelor);
  });

  it('softens on "or equivalent experience", not on "or foreign equivalent"', () => {
    expect(extractDegreeRequirement("Bachelor's degree or equivalent experience").equivalent).toBe(true);
    expect(extractDegreeRequirement("Bachelor's degree or four or more years of work experience").equivalent).toBe(true);
    expect(extractDegreeRequirement("Bachelor's degree or foreign equivalent in CS").equivalent).toBe(false);
  });

  it('softens on a posting-wide equivalence statement', () => {
    const jd = "Education\nBachelor's Degree\nWhile possessing the stated degree is preferred, we also may consider "
      + 'applicants who hold some combination of coursework and experience.';
    expect(extractDegreeRequirement(jd).equivalent).toBe(true);
  });

  it('does not read "master data" or a tuition benefit as a degree requirement', () => {
    expect(extractDegreeRequirement('Experience with master data management; scrum master certification')).toBe(null);
    expect(extractDegreeRequirement(
      'Live Better U pays for education, from high school completion to bachelor\'s degrees, including English learning.',
    )).toBe(null);
  });
});

describe('candidate side', () => {
  it('prefers a stated number of years', () => {
    expect(candidateYearsOfExperience({ background: { yearsExperience: 9 }, yearsExperience: 3 })).toBe(9);
    expect(candidateYearsOfExperience({ yearsExperience: '7' })).toBe(7);
  });

  it('derives years from work history, merging overlapping roles', () => {
    const years = candidateYearsOfExperience({
      workHistory: [
        { employer: 'A', startDate: 'Jan 2015', endDate: 'Dec 2018' },
        { employer: 'B', startDate: '2018-06', endDate: '', current: true },
      ],
    }, NOW);
    expect(years).toBeCloseTo(11.8, 1);
  });

  it('treats template placeholders as unknown', () => {
    expect(candidateYearsOfExperience({
      workHistory: [{ employer: 'Example Corp', startDate: 'January 2020', current: true }],
    }, NOW)).toBe(null);
    expect(candidateDegreeLevel({
      education: [{ institution: 'Example University', degree: 'Master of Science' }],
    })).toBe(null);
  });

  it('reads the highest degree', () => {
    expect(candidateDegreeLevel({ education: [
      { institution: 'State U', degree: 'Bachelor of Technology' },
      { institution: 'Tech U', degree: 'M.S. Computer Science' },
    ] })).toBe(DEGREE_LEVELS.master);
    expect(candidateDegreeLevel({ education: [] })).toBe(null);
  });

  it('parses the date shapes résumés use', () => {
    expect(parseResumeMonth('January 2020')).toBe(2020 * 12);
    expect(parseResumeMonth('Sept 2021')).toBe(2021 * 12 + 8);
    expect(parseResumeMonth('03/2019')).toBe(2019 * 12 + 2);
    expect(parseResumeMonth('2019-03')).toBe(2019 * 12 + 2);
    expect(parseResumeMonth('2017')).toBe(2017 * 12);
    expect(parseResumeMonth('someday')).toBe(null);
  });
});

describe('eligibility verdict', () => {
  const sixYearsBachelor = { yearsExperience: 6, education: [{ institution: 'State U', degree: 'Bachelor of Science' }] };

  it('is eligible when the floor is met', () => {
    expect(assessEligibility({ jdText: '5+ years of experience' }, sixYearsBachelor, { now: NOW }).verdict).toBe('eligible');
  });

  it('is a stretch 1-2 years short', () => {
    const r = assessEligibility({ jdText: 'Minimum of 8 years of experience' }, sixYearsBachelor, { now: NOW });
    expect(r.verdict).toBe('stretch');
    expect(r.reasons[0]).toMatch(/requires 8\+ years, you have 6/);
  });

  it('is ineligible 3+ years short', () => {
    expect(assessEligibility({ jdText: 'At least 10 years of experience' }, sixYearsBachelor, { now: NOW }).verdict)
      .toBe('ineligible');
  });

  it('is ineligible for a required degree above the candidate\'s, unless equivalence is allowed', () => {
    expect(assessEligibility({ jdText: "Master's degree in Statistics required" }, sixYearsBachelor, { now: NOW }).verdict)
      .toBe('ineligible');
    const soft = assessEligibility({ jdText: "Master's degree or equivalent experience" }, sixYearsBachelor, { now: NOW });
    expect(soft.verdict).toBe('eligible');
    expect(soft.reasons[0]).toMatch(/or equivalent experience/);
  });

  it('is unknown when the candidate\'s side is unknown', () => {
    expect(assessEligibility({ jdText: 'At least 10 years of experience' }, {}, { now: NOW }).verdict).toBe('unknown');
    expect(assessEligibility({ jdText: "PhD required" }, { yearsExperience: 4 }, { now: NOW }).verdict).toBe('unknown');
  });

  it('reuses the exclusion stage\'s clearance rule rather than its own', () => {
    const exclusions = { securityClearance: ['active clearance', 'ts/sci'], clearanceAllowance: [] };
    const jd = 'Must currently hold an active clearance (TS/SCI).';
    expect(hardClearanceRequirement(normalizeText(jd), exclusions)).toEqual(['active clearance', 'ts/sci']);
    expect(applyExclusions({ jdText: jd }, exclusions).category).toBe('security_clearance');
    const r = assessEligibility({ jdText: jd }, sixYearsBachelor, { now: NOW, exclusions });
    expect(r.verdict).toBe('ineligible');
    expect(r.blocking).toBe(true);
    // Softened exactly as the exclusion stage softens it.
    expect(assessEligibility({ jdText: 'An active clearance is a nice to have.' }, sixYearsBachelor, { now: NOW, exclusions }).verdict)
      .toBe('eligible');
    // A candidate who states a clearance is not blocked.
    expect(assessEligibility({ jdText: jd }, { ...sixYearsBachelor, securityClearance: 'TS/SCI' }, { now: NOW, exclusions }).verdict)
      .toBe('eligible');
  });
});

describe('eligibility penalty', () => {
  it('is linear in the years gap and complete at 3 years short', () => {
    expect(eligibilityPenalty({ verdict: 'stretch', gapYears: 1, blocking: false, reasons: ['r'] }, 9).points).toBe(-3);
    expect(eligibilityPenalty({ verdict: 'ineligible', gapYears: 5, blocking: false, reasons: ['r'] }, 9).points).toBe(-9);
  });

  it('costs the full weight for a degree or clearance, and defaults to 8', () => {
    expect(eligibilityPenalty({ verdict: 'ineligible', gapYears: null, blocking: true, reasons: ['r'] }).points)
      .toBe(-DEFAULT_ELIGIBILITY_PENALTY);
  });

  it('subtracts nothing for eligible or unknown', () => {
    expect(eligibilityPenalty({ verdict: 'eligible', gapYears: null, blocking: false, reasons: [] }, 8)).toBe(null);
    expect(eligibilityPenalty({ verdict: 'unknown', gapYears: null, blocking: false, reasons: [] }, 8)).toBe(null);
  });
});

describe('eligibility in scoring and the explanation', () => {
  const base = loadTestConfig({ loadEnv: false, env: {} });
  const candidate = { ...base.candidate, yearsExperience: 5, workHistory: [], education: [] };
  const job = (jdText) => ({ title: 'Senior Data Engineer', jdText, source: 'greenhouse', postedAt: NOW.toISOString() });
  const score = (jdText, cand = candidate, scoring = base.scoring) => scoreJob(job(jdText), {
    scoring, sponsorship: { status: 'Confirmed' }, candidate: cand, now: NOW,
  });

  it('subtracts a bounded penalty without touching the denominator', () => {
    const ok = score('Requirements: 5+ years of experience with Spark and SQL.');
    const short = score('Requirements: 10+ years of experience with Spark and SQL.');
    expect(ok.eligibility.verdict).toBe('eligible');
    expect(short.eligibility.verdict).toBe('ineligible');
    expect(short.max).toBe(ok.max);
    expect(short.breakdown.eligibility).toEqual(expect.objectContaining({ points: -8, weight: 0 }));
    expect(ok.breakdown.eligibility).toBeUndefined();
    expect(short.raw).toBeCloseTo(ok.raw - 8, 5);
  });

  it('honours scoring.weights.eligibility', () => {
    const scoring = { ...base.scoring, weights: { ...base.scoring.weights, eligibility: 4 } };
    expect(score('At least 10 years of experience.', candidate, scoring).breakdown.eligibility.points).toBe(-4);
  });

  it('changes nothing for a candidate with unknown history', () => {
    const unknown = { ...candidate, yearsExperience: null };
    const r = score('At least 10 years of experience.', unknown);
    expect(r.eligibility.verdict).toBe('unknown');
    expect(r.breakdown.eligibility).toBeUndefined();
  });

  it('states the reason in the explanation', () => {
    const r = score('Minimum of 7 years of experience in data engineering.');
    const { explanation } = explainScore(r, base.scoring, { candidate });
    expect(explanation).toMatch(/Eligibility: stretch — requires 7\+ years, you have 5/);
    expect(explanation).toMatch(/\(-5\.33 pts\)/);
  });
});

describe('eligibility in the scoring fingerprint', () => {
  const base = loadTestConfig({ loadEnv: false, env: {} });

  it('fingerprints the version and the candidate\'s whole years and degree', () => {
    const material = scoringFingerprintMaterial({ ...base, candidate: { ...base.candidate, yearsExperience: 6.9 } });
    expect(material.eligibility).toEqual({ version: ELIGIBILITY_VERSION, years: 6, degree: expect.anything() });
  });

  it('changes when the candidate\'s years or degree change', () => {
    const a = scoringFingerprint({ ...base, candidate: { ...base.candidate, yearsExperience: 6 } });
    const b = scoringFingerprint({ ...base, candidate: { ...base.candidate, yearsExperience: 9 } });
    const c = scoringFingerprint({
      ...base,
      candidate: { ...base.candidate, yearsExperience: 6, education: [{ institution: 'X', degree: 'PhD' }] },
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('does not change for a fraction of a year', () => {
    const a = scoringFingerprint({ ...base, candidate: { ...base.candidate, yearsExperience: 6.1 } });
    const b = scoringFingerprint({ ...base, candidate: { ...base.candidate, yearsExperience: 6.8 } });
    expect(a).toBe(b);
  });
});
