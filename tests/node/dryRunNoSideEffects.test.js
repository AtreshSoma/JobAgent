/**
 * A dry run has no side effects (audit N2).
 *
 * `assistApply({dryRun: true})` was documented as "resolve-only (no
 * typing/attaching)", but only the static plan and uploads honoured it: the
 * dynamic fill, the conditional fill and every Next/Continue click ignored it,
 * so a "dry run" typed into and advanced a live application. These drive the
 * real runner in a real browser against local fixture pages and check the
 * page, the URL, the files and the saved state afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { join } from 'node:path';

import { assistApply } from '../../src/automation/applyRunner.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';

const ORIGIN = 'https://jobs.example.test';
const RESUME = join(process.cwd(), 'tests', 'node', 'fixtures', 'sample_resume.txt');

// Step one of a two-step form: a static field, two dynamic ones, a choice that
// reveals a conditional question, a resume upload and a Next button.
const STEP_ONE = `<!doctype html><title>Apply</title><form>
  <label for="email">Email</label><input id="email" type="email">
  <label for="first">First name</label><input id="first" name="first">
  <label for="city">City</label><input id="city" name="city">
  <label for="relocate">Are you willing to relocate?</label>
  <select id="relocate"><option value=""></option><option>Yes</option><option>No</option></select>
  <div id="more" hidden><label for="where">Which cities?</label><input id="where"></div>
  <label for="resume">Resume</label><input id="resume" type="file">
  <button type="button" id="next">Next</button></form>
<script>
  document.getElementById('relocate').addEventListener('change', () => { document.getElementById('more').hidden = false; });
  document.getElementById('next').addEventListener('click', () => { history.pushState({}, '', '/apply/step-2'); document.body.innerHTML = '<h1>Step 2</h1>'; });
</script>`;

const config = {
  candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.test' }, location: { city: 'Durham' } },
  screeningAnswers: { answers: [{ id: 'relocate', patterns: ['willing to relocate'], answer: 'Yes' }] },
  runtime: {},
};
const packet = {
  job: { id: 'dry-1', url: `${ORIGIN}/apply` }, blockers: [], owner: { candidateName: 'Dana Okafor' },
  fillPlan: {
    steps: [{ field: 'email', label: 'Email', value: 'dana@example.test', source: 'profile', selector: '#email' }],
    uploads: [{ type: 'resume', path: RESUME, selector: '#resume' }],
  },
  screeningPlan: { answered: [], needsUser: [] },
};

describe('a dry run', () => {
  let browser;
  beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch({ headless: true })); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  skipWithoutBrowser(() => browser);

  async function run(options) {
    const context = await browser.newContext();
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: STEP_ONE }));
    const page = await context.newPage();
    const saved = [];
    const result = await assistApply({
      packet, config,
      options: { headless: true, maxSteps: 3, ...options },
      deps: {
        createSession: async () => ({ page, close: async () => {} }),
        stateStore: { load: async () => null, save: async (state) => { saved.push(state.phase); } },
      },
    });
    return { result, page, context, saved };
  }

  it('types nothing, attaches nothing and clicks nothing', async () => {
    const { result, page, context } = await run({ dryRun: true });
    expect(new URL(page.url()).pathname).toBe('/apply');
    for (const id of ['#email', '#first', '#city', '#where']) expect(await page.inputValue(id), id).toBe('');
    expect(await page.inputValue('#relocate')).toBe('');
    expect(await page.$eval('#resume', (el) => el.files.length)).toBe(0);
    expect(await page.$eval('#more', (el) => el.hidden)).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.status).toBe('dry_run');
    await context.close();
  }, 60_000);

  it('reports what it would have done', async () => {
    const { result, context } = await run({ dryRun: true });
    const would = result.filled.map((f) => f.selector);
    expect(would).toEqual(expect.arrayContaining(['#email', '#city']));
    expect(result.filled.every((f) => f.action === 'dry-run')).toBe(true);
    expect(result.wouldClick).toMatch(/Next/);
    await context.close();
  }, 60_000);

  it('saves no application state', async () => {
    const { saved, context } = await run({ dryRun: true });
    expect(saved).toEqual([]);
    await context.close();
  }, 60_000);

  it('never submits, even when auto-submit is asked for', async () => {
    const { page, result, context } = await run({ dryRun: true, autoSubmit: true });
    expect(new URL(page.url()).pathname).toBe('/apply');
    expect(result.status).toBe('dry_run');
    await context.close();
  }, 60_000);

  it('without dryRun, the same page is filled and advanced (the fixture is live)', async () => {
    const { page, result, context } = await run({});
    expect(new URL(page.url()).pathname).toBe('/apply/step-2');
    expect(result.dryRun).not.toBe(true);
    await context.close();
  }, 60_000);
});
