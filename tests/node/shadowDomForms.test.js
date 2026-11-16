/**
 * Forms inside open shadow roots (audit A8).
 *
 * Web-component application forms (SmartRecruiters and others) keep their
 * inputs in open shadow roots. The scanner counted them only to say "form not
 * readable". Now they are read and filled like any control. The safety half
 * matters as much: the required-field check the auto-submit gate relies on
 * must see inside shadow roots too, or a shadow form with a blank required
 * question would look complete.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { assistApply } from '../../src/automation/applyRunner.js';
import { detectValidationErrors, scanFields, unfilledRequiredControls } from '../../src/automation/domScanner.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';

const ORIGIN = 'https://jobs.example.test';

const SHADOW_FORM = `<!doctype html><title>Apply</title><body><h1>Data Engineer</h1><apply-form></apply-form>
<script>
  customElements.define('apply-form', class extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = \`
        <form>
          <label for="em">Email Address</label><input id="em" type="email" required>
          <label for="rel">Are you willing to relocate?</label>
          <select id="rel" required><option value=""></option><option>Yes</option><option>No</option></select>
          <label for="why">Describe your most relevant project</label><textarea id="why" required></textarea>
          <button type="button" id="next">Next</button>
        </form>\`;
    }
  });
</script>`;

const config = {
  candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.test' } },
  screeningAnswers: { answers: [{ id: 'relocate', patterns: ['willing to relocate'], answer: 'Yes' }] },
  runtime: {},
};
const packet = {
  job: { id: 'shadow-1', url: `${ORIGIN}/apply` }, blockers: [], owner: { candidateName: 'Dana Okafor' },
  fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] },
};

describe('a form inside an open shadow root', () => {
  let browser;
  beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch({ headless: true })); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  skipWithoutBrowser(() => browser);

  async function openPage() {
    const context = await browser.newContext();
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: SHADOW_FORM }));
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/apply`);
    return { page, context };
  }

  it('the scanner reads its controls, with their labels', async () => {
    const { page, context } = await openPage();
    const fields = await scanFields(page);
    expect(fields.map((f) => f.label)).toEqual(expect.arrayContaining([
      'Email Address', 'Are you willing to relocate?', 'Describe your most relevant project',
    ]));
    expect(fields.find((f) => f.label === 'Email Address')).toMatchObject({ required: true });
    await context.close();
  }, 30_000);

  it('the required-field check sees a blank required question inside it', async () => {
    const { page, context } = await openPage();
    expect((await unfilledRequiredControls(page)).sort()).toEqual([
      'Are you willing to relocate?', 'Describe your most relevant project', 'Email Address',
    ]);
    await page.locator('#em').fill('dana@example.test');
    expect((await unfilledRequiredControls(page)).sort()).toEqual([
      'Are you willing to relocate?', 'Describe your most relevant project',
    ]);
    await context.close();
  }, 30_000);

  it('validation errors inside it are reported', async () => {
    const { page, context } = await openPage();
    await page.evaluate(() => {
      document.querySelector('apply-form').shadowRoot.getElementById('em').setAttribute('aria-invalid', 'true');
    });
    expect((await detectValidationErrors(page)).join(' ')).toMatch(/invalid field: Email Address/);
    await context.close();
  }, 30_000);

  it('the run fills what it can answer, and stops for the question only the person can', async () => {
    const { page, context } = await openPage();
    const result = await assistApply({
      packet, config, options: { headless: true, statePath: false, maxSteps: 1 },
      deps: { createSession: async () => ({ page, close: async () => {} }) },
    });
    expect(await page.locator('#em').inputValue()).toBe('dana@example.test');
    expect(await page.locator('#rel').inputValue()).toBe('Yes');
    // The free-text project question has no saved answer: the run asks, and does not call the form ready.
    expect(result.status).toBe('assist_blocked');
    expect(result.needsUser.map((q) => q.label)).toContain('Describe your most relevant project');
    expect(result.blockers.join(' ')).not.toMatch(/form not readable/);
    await context.close();
  }, 60_000);
});
