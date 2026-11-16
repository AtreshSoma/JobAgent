/**
 * iCIMS, Taleo and Jobvite forms (audit A15).
 *
 * LOCAL contract fixtures only (tests/node/fixtures/ats/README.md): hand-written
 * from each platform's general form structure, not captured from a live site,
 * so they prove how the assist run handles that SHAPE of form, never that a
 * real employer's current form works. Nothing is submitted: each form's submit
 * control sets a flag, and every test checks the flag was never set.
 *
 *   iCIMS   inside an iframe on the employer's own page, two steps
 *   Taleo   ids full of dots, links styled as buttons ("Next", "Submit")
 *   Jobvite name-based fields, a file input hidden behind an "Attach resume" label
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { detectAts } from '../../src/apply/atsDetector.js';
import { assistApply } from '../../src/automation/applyRunner.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';

const FIX = (name) => readFileSync(join(process.cwd(), 'tests', 'node', 'fixtures', 'ats', name), 'utf8');
const RESUME = join(process.cwd(), 'tests', 'node', 'fixtures', 'sample_resume.txt');

const config = {
  candidate: {
    identity: { fullName: 'Dana Okafor' },
    contact: { email: 'dana@example.test', phone: '5550100' },
    workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  },
  screeningAnswers: { answers: [{ id: 'work_authorization', patterns: ['legally authorized to work'], answer: 'Yes' }] },
  runtime: {},
};

const packet = (url, uploads = [{ type: 'resume', path: RESUME }]) => ({
  job: { id: 'ats-1', url }, blockers: [], owner: { candidateName: 'Dana Okafor' },
  fillPlan: { steps: [], uploads }, screeningPlan: { answered: [], needsUser: [] },
});

describe('iCIMS, Taleo and Jobvite style forms (local fixtures, nothing submitted)', () => {
  let browser;
  beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch({ headless: true })); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  skipWithoutBrowser(() => browser);

  async function run({ url, routes, options = {}, uploads }) {
    const context = await browser.newContext();
    await context.route('**/*', (route) => {
      const u = new URL(route.request().url());
      const body = routes(u);
      return body == null ? route.abort() : route.fulfill({ status: 200, contentType: 'text/html', body });
    });
    const page = await context.newPage();
    const result = await assistApply({
      packet: packet(url, uploads), config,
      options: { headless: true, statePath: false, maxSteps: 4, ...options },
      deps: { createSession: async () => ({ page, close: async () => {} }) },
    });
    return { result, page, context };
  }
  const submitted = (page) => page.evaluate(() => window.__submitted === true);

  it('detects the three platforms from their hosts', () => {
    expect(detectAts({ url: 'https://careers-acme.icims.com/jobs/1/apply' }).platform).toBe('icims');
    expect(detectAts({ url: 'https://acme.taleo.net/careersection/2/jobdetail.ftl' }).platform).toBe('taleo');
    expect(detectAts({ url: 'https://jobs.jobvite.com/acme/job/oX1' }).platform).toBe('jobvite');
  });

  it('iCIMS: finds the form in its iframe, fills step one, advances, answers the question, stops before Submit', async () => {
    const { result, page, context } = await run({
      url: 'https://jobs.acme.test/careers/1',
      routes: (u) => {
        if (u.host === 'jobs.acme.test') return FIX('icims_host.html');
        if (u.host === 'careers-acme.icims.com') return u.pathname.includes('/questions') ? null : FIX('icims_step1.html');
        return null;
      },
    });
    const frame = page.frames().find((f) => /icims\.com/.test(f.url()));
    expect(frame, 'the iCIMS frame').toBeTruthy();
    expect(result.filled.map((f) => f.label)).toEqual(expect.arrayContaining(['First Name', 'Last Name', 'Email Address']));
    expect(result.advancedSteps).toBe(1);
    expect(await frame.locator('#auth').inputValue()).toBe('Yes');
    expect(result.status).toBe('ready_for_submit');
    expect(await frame.evaluate(() => window.__submitted === true)).toBe(false);
    await context.close();
  }, 90_000);

  it('Taleo: fills fields whose ids are full of dots, clicks a link-button Next, attaches the resume, stops before Submit', async () => {
    const { result, page, context } = await run({
      url: 'https://acme.taleo.net/careersection/2/jobapply.ftl',
      routes: (u) => (u.host === 'acme.taleo.net' ? FIX('taleo_step1.html') : null),
    });
    expect(result.filled.map((f) => f.label)).toEqual(expect.arrayContaining(['First name', 'Last name', 'Email address']));
    expect(result.advancedSteps).toBe(1);
    expect(result.uploads.uploaded.map((u) => u.type)).toContain('resume');
    expect(result.status).toBe('ready_for_submit');
    expect(await submitted(page)).toBe(false);
    await context.close();
  }, 90_000);

  it('Jobvite: fills name-based fields, attaches the resume through the hidden input, stops before Submit Application', async () => {
    const { result, page, context } = await run({
      url: 'https://jobs.jobvite.com/acme/apply',
      routes: (u) => (u.host === 'jobs.jobvite.com' ? FIX('jobvite_form.html') : null),
    });
    expect(result.filled.map((f) => f.label)).toEqual(expect.arrayContaining(['First Name', 'Last Name', 'Email', 'Phone']));
    expect(await page.locator('#jv-first').inputValue()).toBe('Dana');
    expect(await page.$eval('#jv-resume', (el) => el.files.length)).toBe(1);
    expect(result.status).toBe('ready_for_submit');
    expect(await submitted(page)).toBe(false);
    await context.close();
  }, 90_000);

  it('a dry run of each types and attaches nothing', async () => {
    const { page, context } = await run({
      url: 'https://jobs.jobvite.com/acme/apply', options: { dryRun: true },
      routes: (u) => (u.host === 'jobs.jobvite.com' ? FIX('jobvite_form.html') : null),
    });
    expect(await page.locator('#jv-first').inputValue()).toBe('');
    expect(await page.$eval('#jv-resume', (el) => el.files.length)).toBe(0);
    await context.close();
  }, 60_000);
});
