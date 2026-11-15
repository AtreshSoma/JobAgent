/**
 * Work history and education filler (audit A3).
 *
 * Workday's "My Experience" step, and iCIMS and Taleo's equivalents, ask for one
 * entry per job and degree behind an "Add" button. They are usually required,
 * and the runner used to leave them to the person. It now adds one entry per
 * role and degree from the profile, fills it, and reads each value back.
 *
 * LOCAL fixture only (a hand-written Workday-shaped page, not captured from a
 * live site). What must hold: values come only from the profile (nothing
 * invented), "Add" is pressed only for work and education sections, an entry
 * already on the page is not added twice, a dry run clicks nothing, and every
 * value is read back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { assistApply } from '../../src/automation/applyRunner.js';
import { fillRepeatedSections, parseResumeDate } from '../../src/automation/repeatedSections.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';

const PAGE = readFileSync(join(process.cwd(), 'tests', 'node', 'fixtures', 'ats', 'workday_experience.html'), 'utf8');
const ORIGIN = 'https://acme.wd1.example.test';

const candidate = {
  workHistory: [
    { employer: 'Northwind', title: 'Senior Data Engineer', location: 'Remote', startDate: 'January 2022', endDate: '', current: true,
      highlights: ['Led a Python and Spark migration', 'Cut warehouse cost 30%'] },
    { employer: 'Contoso', title: 'Data Engineer', location: 'Durham, NC', startDate: 'March 2019', endDate: 'December 2021', current: false,
      highlights: ['Built Airflow pipelines'] },
  ],
  education: [{ institution: 'Duke University', degree: "Master's Degree", field: 'Computer Science', graduationYear: '2016' }],
};

describe('parseResumeDate', () => {
  it('reads month names, numbers and bare years', () => {
    expect(parseResumeDate('January 2022')).toEqual({ month: 1, year: 2022 });
    expect(parseResumeDate('Mar 2019')).toEqual({ month: 3, year: 2019 });
    expect(parseResumeDate('03/2019')).toEqual({ month: 3, year: 2019 });
    expect(parseResumeDate('2016')).toEqual({ month: null, year: 2016 });
    expect(parseResumeDate('Present')).toBeNull();
    expect(parseResumeDate('')).toBeNull();
  });
});

describe('the repeated-section filler', () => {
  let browser;
  beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch({ headless: true })); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  skipWithoutBrowser(() => browser);

  async function open(html = PAGE) {
    const context = await browser.newContext();
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/apply`);
    return { page, context };
  }
  const val = (page, id) => page.locator(`#${id}`).inputValue();

  it('adds one entry per role and degree, fills it from the profile, and reads each value back', async () => {
    const { page, context } = await open();
    const r = await fillRepeatedSections(page, { candidate });
    expect(r.errors).toEqual([]);
    expect(r.sections.map((s) => [s.kind, s.added])).toEqual([['work', 2], ['education', 1]]);

    expect(await val(page, 'w1-title')).toBe('Senior Data Engineer');
    expect(await val(page, 'w1-co')).toBe('Northwind');
    expect(await val(page, 'w1-loc')).toBe('Remote');
    expect(await page.locator('#w1-cur').isChecked()).toBe(true);
    expect([await val(page, 'w1-fm'), await val(page, 'w1-fy')]).toEqual(['01', '2022']);
    expect([await val(page, 'w1-tm'), await val(page, 'w1-ty')]).toEqual(['', '']); // current role: no end date

    expect(await val(page, 'w2-co')).toBe('Contoso');
    expect(await page.locator('#w2-cur').isChecked()).toBe(false);
    expect([await val(page, 'w2-fm'), await val(page, 'w2-fy'), await val(page, 'w2-tm'), await val(page, 'w2-ty')]).toEqual(['03', '2019', '12', '2021']);

    expect(await val(page, 'e1-school')).toBe('Duke University');
    expect(await val(page, 'e1-degree')).toBe("Master's Degree");
    expect(await val(page, 'e1-field')).toBe('Computer Science');
    expect(await val(page, 'e1-year')).toBe('2016');
    await context.close();
  }, 60_000);

  it('the role description is the profile\'s own highlights, nothing written for it', async () => {
    const { page, context } = await open();
    await fillRepeatedSections(page, { candidate });
    const text = await val(page, 'w1-desc');
    expect(text.split('\n')).toEqual(['Led a Python and Spark migration', 'Cut warehouse cost 30%']);
    await context.close();
  }, 60_000);

  it('does not add an entry that is already on the page', async () => {
    const { page, context } = await open();
    await fillRepeatedSections(page, { candidate });
    const again = await fillRepeatedSections(page, { candidate });
    expect(again.sections.map((s) => s.added)).toEqual([0, 0]);
    expect(await page.locator('#work-entries fieldset').count()).toBe(2);
    expect(await page.locator('#edu-entries fieldset').count()).toBe(1);
    await context.close();
  }, 60_000);

  it('a dry run presses nothing and says what it would add', async () => {
    const { page, context } = await open();
    const r = await fillRepeatedSections(page, { candidate, dryRun: true });
    expect(await page.locator('#work-entries fieldset').count()).toBe(0);
    expect(r.sections.map((s) => [s.kind, s.wouldAdd, s.added])).toEqual([['work', 2, 0], ['education', 1, 0]]);
    await context.close();
  }, 60_000);

  it('with no history it presses nothing', async () => {
    const { page, context } = await open();
    const r = await fillRepeatedSections(page, { candidate: { workHistory: [], education: [] } });
    expect(r.sections.every((s) => s.added === 0)).toBe(true);
    expect(await page.locator('#work-entries fieldset').count()).toBe(0);
    await context.close();
  }, 60_000);

  it('presses "Add" only for work and education, never "Add Website" or the Next button', async () => {
    const { page, context } = await open();
    await fillRepeatedSections(page, { candidate });
    expect(await page.evaluate(() => window.__siteAdded)).toBeUndefined();
    expect(await page.evaluate(() => window.__next)).toBeUndefined();
    await context.close();
  }, 60_000);

  it('an Add that opens no fields is reported once and not repeated', async () => {
    const dead = PAGE.replace("document.getElementById('add-work').addEventListener('click', () => {", "document.getElementById('add-work').addEventListener('click', () => { if (true) return;");
    const { page, context } = await open(dead);
    const r = await fillRepeatedSections(page, { candidate });
    expect(r.errors.join(' ')).toMatch(/opened no fields/i);
    expect(r.sections.find((s) => s.kind === 'work').added).toBe(0);
    await context.close();
  }, 60_000);

  it('inside a run: filled entries are listed, and nothing is submitted or advanced', async () => {
    const context = await browser.newContext();
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
    const page = await context.newPage();
    const result = await assistApply({
      packet: { job: { id: 'wd-1', url: `${ORIGIN}/apply` }, blockers: [], owner: {}, fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] } },
      config: { candidate, screeningAnswers: { answers: [] }, runtime: {} },
      options: { headless: true, statePath: false, maxSteps: 1 },
      deps: { createSession: async () => ({ page, close: async () => {} }) },
    });
    expect(result.repeatedSections?.map((s) => [s.kind, s.added])).toEqual([['work', 2], ['education', 1]]);
    expect(await val(page, 'w1-co')).toBe('Northwind');
    expect(result.status).not.toBe('submitted');
    await context.close();
  }, 90_000);

  it('a dry run of the whole run adds no entries', async () => {
    const context = await browser.newContext();
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
    const page = await context.newPage();
    const result = await assistApply({
      packet: { job: { id: 'wd-2', url: `${ORIGIN}/apply` }, blockers: [], owner: {}, fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] } },
      config: { candidate, screeningAnswers: { answers: [] }, runtime: {} },
      options: { headless: true, statePath: false, maxSteps: 1, dryRun: true },
      deps: { createSession: async () => ({ page, close: async () => {} }) },
    });
    expect(await page.locator('#work-entries fieldset').count()).toBe(0);
    expect(result.status).toBe('dry_run');
    await context.close();
  }, 90_000);
});
