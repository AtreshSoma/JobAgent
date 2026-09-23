/**
 * M1 / M4 / small precision fixes in scoring and discovery signals.
 *
 *  - Seniority read from a JD body only from an explicit level statement.
 *  - Contract length needs contract context, takes the max, skips C2H.
 *  - Pay is parsed strictly from description text and scored as a penalty
 *    only when both the posting and the candidate state a figure.
 *  - Discovery's seniority signal is whole-word.
 *  - The sponsorship-gate threshold can be passed instead of read from a global.
 */
import { describe, it, expect } from 'vitest';

import { scoreJob } from '../../src/scoring/scorer.js';
import {
  parseContractMonths, parsePayRange, postedPay, checkSearchConstraints,
} from '../../src/scoring/searchConstraints.js';
import { explainScore, isSponsorshipGated, resolveApplyThreshold } from '../../src/scoring/explainScore.js';
import { classifyDiscovery } from '../../src/search/discoveryFilter.js';
import { loadTestConfig } from './helpers/testConfig.js';

const config = loadTestConfig({ loadEnv: false, env: {} });
const score = (job, candidate = config.candidate) => scoreJob(job, {
  scoring: config.scoring, sponsorship: { status: 'Unconfirmed' }, candidate, now: new Date('2026-09-22T12:00:00Z'),
});

describe('seniority from the description', () => {
  const base = { title: 'Data Engineer', source: 'greenhouse', postedAt: '2026-09-21' };

  it.each([
    'You will report to our CTO and partner with the VP of Data.',
    'The hiring manager will lead the interview loop.',
    'You will lead the design of our lakehouse.',
  ])('prose mentioning a level is "unstated": %s', (jd) => {
    const s = score({ ...base, jdText: jd });
    expect(s.breakdown.seniorityFit.matched).toContain('seniority unstated');
  });

  it('an explicit level statement is read', () => {
    expect(score({ ...base, jdText: 'This is a senior-level role on the platform team.' }).breakdown.seniorityFit.matched)
      .not.toContain('seniority unstated');
    expect(score({ ...base, jdText: 'Level: Senior\nLocation: Remote' }).breakdown.seniorityFit.matched)
      .not.toContain('seniority unstated');
  });
});

describe('parseContractMonths', () => {
  it.each([
    ['Benefits eligible after 3 months. 12 month contract.', 12],
    ['6-12 month contract', 12],
    ['Contract length: 9 months', 9],
    ['Duration - 6 to 9 months', 9],
    ['1 year engagement', 12],
    ['3 month assignment with a possible 6 month contract extension', 6],
  ])('%s -> %s', (text, months) => {
    expect(parseContractMonths(text)).toBe(months);
  });

  it('ignores durations with no contract context, and contract-to-hire', () => {
    expect(parseContractMonths('We offer benefits after 3 months')).toBeNull();
    expect(parseContractMonths('This is a 6 month contract to hire role')).toBeNull();
    expect(parseContractMonths('')).toBeNull();
  });
});

describe('parsePayRange', () => {
  it.each([
    ['The pay range for this role is $120,000 - $150,000 per year.', 120000, 150000],
    ['Rate: $60–$75/hr on W2', 60 * 2080, 75 * 2080],
    ['Base salary $140k to $170k', 140000, 170000],
    ['Salary: $8,000 - $9,000 per month', 96000, 108000],
  ])('%s', (text, min, max) => {
    expect(parsePayRange(text)).toMatchObject({ min, max });
  });

  it.each([
    'We raised $5M in funding last year.',
    'Serving 50,000 customers worldwide.',
    'Our $2 billion portfolio.',
    'Compensation includes a $20,000 sign-on bonus.',
    '$25 gift card for referrals and a competitive salary',
  ])('is not pay: %s', (text) => {
    expect(parsePayRange(text)).toBeNull();
  });

  it('a compensation field wins over the description', () => {
    expect(postedPay({ rawMetadata: { compensation: '$200,000' }, jdText: 'salary $100,000 - $110,000' })).toMatchObject({ max: 200000, source: 'field' });
    expect(postedPay({ jdText: 'salary $100,000 - $110,000' })).toMatchObject({ max: 110000, source: 'description' });
  });
});

describe('pay in scoring and the salary floor', () => {
  const job = (jd) => ({ title: 'Senior Data Engineer', source: 'greenhouse', postedAt: '2026-09-21', jdText: jd });
  const withPay = { ...config.candidate, salaryPreference: { minAnnualUSD: 130000, targetAnnualUSD: 170000 } };

  it('penalizes a posted range under target, with an explanation line', () => {
    const low = score(job('Build pipelines in Spark and SQL. The salary range is $135,000 - $140,000 per year.'), withPay);
    const none = score(job('Build pipelines in Spark and SQL.'), withPay);
    expect(low.breakdown.payFit.points).toBeLessThan(0);
    expect(low.total).toBeLessThan(none.total);
    expect(none.breakdown.payFit).toBeUndefined();
    const { explanation } = explainScore(low, config.scoring, { candidate: withPay });
    expect(explanation).toMatch(/Pay: posted pay up to 140,000/);
  });

  it('costs nothing at or above target, and nothing when the candidate states no figure', () => {
    const high = score(job('The pay range is $170,000 - $200,000 annually.'), withPay);
    expect(high.breakdown.payFit.points).toBe(0);
    const unset = score(job('The pay range is $70,000 - $80,000 annually.'), { ...config.candidate, salaryPreference: {} });
    expect(unset.breakdown.payFit).toBeUndefined();
  });

  it('the salary floor applies to a range parsed from the description', () => {
    const out = checkSearchConstraints(job('The pay range is $90,000 - $110,000 per year.'), withPay);
    expect(out).toMatchObject({ violated: true, category: 'below_salary_floor' });
    expect(checkSearchConstraints(job('We raised $5M in funding.'), withPay).violated).toBe(false);
  });
});

describe('discovery seniority signal is whole-word', () => {
  it('does not find "sr" in Israel or "lead" in leadership', () => {
    const candidate = { ...config.candidate, seniority: 'senior' };
    const hit = classifyDiscovery({ title: 'Data Engineer', jdText: 'Our office in Israel values leadership.' }, { candidate });
    expect(hit.signals.some((s) => s.startsWith('seniority:'))).toBe(false);
    const real = classifyDiscovery({ title: 'Sr. Data Engineer', jdText: '' }, { candidate });
    expect(real.signals).toContain('seniority:senior');
  });
});

describe('sponsorship-gate threshold', () => {
  it('uses an explicit threshold or the caller\'s scoring config before the global', () => {
    const row = { tier: 'Queue', score: 72, sponsorship: 'Unconfirmed' };
    expect(isSponsorshipGated(row, { threshold: 70 })).toBe(true);
    expect(isSponsorshipGated(row, { scoring: { tiers: { apply: 80 } } })).toBe(false);
    expect(resolveApplyThreshold({ threshold: 'x' })).toBeGreaterThan(0);
  });
});
