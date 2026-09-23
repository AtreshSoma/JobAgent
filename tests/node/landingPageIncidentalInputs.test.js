/**
 * A JD landing page with a header search box, a cookie banner and a
 * newsletter signup is still a FIELDLESS landing page: its "Apply now" button
 * is the way into the application, and none of those inputs are filled.
 *
 * Regression: allowApplyStart required scanned.length === 0, so the search box
 * alone kept the runner from ever opening the application, and the filler
 * typed the candidate's email into the job-alert form.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { applicationFields, scanFields } from '../../src/automation/domScanner.js';
import { assistApply } from '../../src/automation/applyRunner.js';

const LANDING = `
<style>input,button{display:block;width:200px;height:26px;margin:4px}</style>
<header><form action="/search"><input name="q" placeholder="Search jobs"><button type="button">Go</button></form></header>
<div id="onetrust-banner"><label><input type="checkbox" id="c1"> Accept analytics cookies</label></div>
<main><h1>Senior Data Engineer</h1><p>Build pipelines.</p>
  <button id="apply" type="button">Apply now</button></main>
<footer><form id="job-alerts"><h3>Get notified about new jobs</h3>
  <label>Email <input id="alert-email" type="email"></label><button type="button">Subscribe</button></form></footer>
<script>
  document.getElementById('apply').addEventListener('click', () => {
    window.__applyClicks = (window.__applyClicks || 0) + 1;
    document.querySelector('main').innerHTML = '<form><label>Email <input id="email" type="email"></label></form>';
  });
</script>`;

describe('incidental inputs on a landing page', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  it('are tagged by the scanner and excluded from application fields', async () => {
    const page = await browser.newPage();
    await page.setContent(LANDING);
    const fields = await scanFields(page);
    const byId = Object.fromEntries(fields.map((f) => [f.selector, f.incidental ?? null]));
    expect(byId['input[name="q"]']).toBe('search');
    expect(byId['#c1']).toBe('consent-banner');
    expect(byId['#alert-email']).toBe('signup');
    expect(applicationFields(fields)).toEqual([]);
    await page.close();
  }, 30_000);

  it('the runner clicks Apply now and never types into them', async () => {
    const page = await browser.newPage();
    await page.setContent(LANDING);
    const r = await assistApply({
      packet: {
        job: { id: 'j', url: 'https://careers.acme.test/jobs/1' }, blockers: [],
        owner: { candidateName: 'Dana Okafor' },
        fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] },
      },
      config: {
        candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.test' } },
        screeningAnswers: {}, runtime: {},
      },
      options: { headless: true, statePath: false, maxSteps: 2 },
      deps: {
        createSession: async () => ({ page, close: async () => {} }),
        openPage: async (p) => ({ status: 200, html: await p.content(), guard: { blocked: false } }),
        wait: async () => {},
      },
    });
    expect(await page.evaluate(() => window.__applyClicks)).toBe(1);
    expect(await page.inputValue('input[name="q"]')).toBe('');
    expect(await page.inputValue('#alert-email')).toBe('');
    expect(await page.inputValue('#email')).toBe('dana@example.test');
    expect(r.filled.map((f) => f.selector)).toEqual(['#email']);
    await page.close();
  }, 30_000);
});
