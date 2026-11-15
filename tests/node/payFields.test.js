/**
 * The stated pay range, parsed and stored (audit D6).
 *
 * Salary was a preference, not a field: constraints read what a posting states,
 * but nothing kept it, so the list could not be sorted or filtered by pay. The
 * parsed range is now stored on the job (annual figures, period, currency,
 * where it was read), and "not stated" is a visible answer, never a low number.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { payFields, payLabel } from '../../src/scoring/payFields.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { openDatabase } from '../../src/logging/db.js';
import { buildTestRoot } from './globalSetup.js';

describe('payFields', () => {
  it('reads a stated annual range from the compensation field', () => {
    expect(payFields({ compensationText: '$120,000 - $150,000 per year' })).toMatchObject({
      pay_min: 120000, pay_max: 150000, pay_period: 'year', pay_currency: 'USD', pay_source: 'field', pay_checked: 1,
    });
  });

  it('annualises an hourly figure and keeps the period it was stated in', () => {
    const f = payFields({ compensationText: '$60 - $75 per hour' });
    expect(f.pay_period).toBe('hour');
    expect(f.pay_min).toBe(60 * 2080);
    expect(f.pay_max).toBe(75 * 2080);
  });

  it('reads a pay-transparency sentence in the description', () => {
    const f = payFields({ jdText: 'About us. The pay range for this role is $130,000 - $160,000 per year. Benefits include health.' });
    expect(f).toMatchObject({ pay_min: 130000, pay_max: 160000, pay_source: 'description' });
  });

  it('does not read funding or bonus figures as pay', () => {
    expect(payFields({ jdText: 'We raised $50M in Series B funding and offer a $5,000 sign-on bonus.' })).toMatchObject({
      pay_min: null, pay_max: null, pay_checked: 1,
    });
  });

  it('is "not stated" as nulls, marked checked, never zero', () => {
    const f = payFields({ jdText: 'A great place to work.', compensationText: '' });
    expect(f).toEqual({ pay_min: null, pay_max: null, pay_period: null, pay_currency: null, pay_source: null, pay_checked: 1 });
  });
});

describe('payLabel', () => {
  it('says "Not stated" plainly, and shows a range with where it came from', () => {
    expect(payLabel({ pay_min: null, pay_max: null })).toBe('Not stated');
    expect(payLabel({ pay_min: 120000, pay_max: 150000, pay_period: 'year', pay_source: 'field' })).toBe('$120,000 to $150,000 a year (compensation field)');
    expect(payLabel({ pay_min: 124800, pay_max: 156000, pay_period: 'hour', pay_source: 'description' })).toBe('$124,800 to $156,000 a year, stated hourly (posting text)');
    expect(payLabel({ pay_min: 150000, pay_max: 150000, pay_period: 'year', pay_source: 'field' })).toBe('$150,000 a year (compensation field)');
  });
});

describe('in the store', () => {
  let db;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); });
  afterEach(() => { db.close(); });

  it('a new row gets its pay stored when the posting and its pay field are written', () => {
    db.upsertJob({ id: 'a', company: 'A', title: 'T', compensation_text: '$100,000 - $120,000', jd_text: 'x', discovery_mode: 'profile' });
    expect(db.getJob('a')).toMatchObject({ pay_min: 100000, pay_max: 120000, pay_source: 'field', pay_checked: 1 });
  });

  it('a row written before the columns existed is backfilled in batches, once', () => {
    for (const [id, jd] of [['b', 'Salary: $90,000 - $110,000 per year.'], ['c', 'No pay here.']]) {
      db.upsertJob({ id, company: id, title: 'T', jd_text: jd, discovery_mode: 'profile' });
    }
    expect(db.getJob('b').pay_checked ?? null).toBeNull(); // description only, no pay field written: left to the backfill
    expect(db.backfillPay({ batch: 1 })).toEqual({ checked: 2, stated: 1 });
    expect(db.getJob('b')).toMatchObject({ pay_min: 90000, pay_max: 110000, pay_source: 'description' });
    expect(db.getJob('c')).toMatchObject({ pay_min: null, pay_checked: 1 });
    expect(db.backfillPay()).toEqual({ checked: 0, stated: 0 });
  });

  it('can be sorted by the top of the range, rows without pay last', () => {
    db.upsertJob({ id: 'lo', company: 'L', title: 'T', compensation_text: '$80,000 - $90,000', jd_text: 'x', score: 50, discovery_mode: 'profile' });
    db.upsertJob({ id: 'hi', company: 'H', title: 'T', compensation_text: '$150,000 - $190,000', jd_text: 'x', score: 40, discovery_mode: 'profile' });
    db.upsertJob({ id: 'none', company: 'N', title: 'T', compensation_text: '', jd_text: 'x', score: 90, discovery_mode: 'profile' });
    expect(db.listJobsSummaryPage({ orderBy: 'pay' }).map((r) => r.id)).toEqual(['hi', 'lo', 'none']);
  });
});

describe('in the dashboard', () => {
  let root; let db; let dash;
  beforeEach(async () => {
    root = buildTestRoot();
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'p1', company: 'Pay Co', title: 'Data Engineer', compensation_text: '$120,000 - $150,000 per year', jd_text: 'Requirements\n- Python', status: 'scored', score: 70, discovery_mode: 'profile' });
    db.upsertJob({ id: 'p2', company: 'No Pay Co', title: 'Data Engineer', compensation_text: '', jd_text: 'Requirements\n- Python', status: 'scored', score: 80, discovery_mode: 'profile' });
    const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
    dash = await startDashboard({ config: load(), db, logger: null, port: 0, deps: { loadConfigImpl: load } });
  });
  afterEach(async () => { await dash.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

  it('the job detail says what the pay is, or that it is not stated', async () => {
    const a = await fetch(`${dash.url}/api/jobs/p1`).then((r) => r.json());
    const b = await fetch(`${dash.url}/api/jobs/p2`).then((r) => r.json());
    expect(a.pay).toMatchObject({ min: 120000, max: 150000, label: expect.stringMatching(/\$120,000 to \$150,000 a year/) });
    expect(b.pay).toMatchObject({ min: null, max: null, label: 'Not stated' });
  });

  it('the board can be sorted by pay, highest first, unstated last', async () => {
    const page = await fetch(`${dash.url}/api/jobs?sort=pay`).then((r) => r.json());
    expect(page.jobs.map((j) => j.id)).toEqual(['p1', 'p2']);
  });
});
