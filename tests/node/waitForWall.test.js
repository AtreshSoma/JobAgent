/**
 * Pause on a wall, then continue (audit A2).
 *
 * A sign-in, CAPTCHA or "verify you are human" page used to end the run at
 * once; the person solved it in the open window and had to start the run
 * again. With a wait budget (options.waitForWallMs, off by default) the run
 * stays on the same page, re-checks it, and continues when the wall is gone.
 *
 * THE SAFETY HALF: waiting never skips the guard. The page is inspected again
 * and the same blocker check decides; a wall that never clears still ends the
 * run blocked, now saying how long it waited, and a cancel ends the wait.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { assistApply } from '../../src/automation/applyRunner.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';

const ORIGIN = 'https://jobs.example.test';
const SOLVE_AFTER_MS = 2500; // after the run has opened the page and found the wall

// A "verify you are human" wall that swaps itself for the form when the person
// solves it (the test flips /__solved), the way a solved challenge does: same
// URL, new content.
const PAGE = `<!doctype html><title>Apply</title><body>
<div id="wall"><h1>Verify you are human</h1><p>Checking your browser before you continue.</p><div class="g-recaptcha"></div></div>
<form id="app" hidden><label for="em">Email Address</label><input id="em" type="email">
<button type="button" id="next">Next</button></form>
<script>setInterval(async () => {
  if (!document.getElementById('wall')) return;
  const solved = await fetch('/__solved').then((r) => r.text()).catch(() => 'no');
  if (solved === 'yes') { document.getElementById('wall').remove(); document.getElementById('app').hidden = false; }
}, 100);</script>`;

const config = { candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.test' } }, screeningAnswers: { answers: [] }, runtime: {} };
const packet = {
  job: { id: 'wall-1', url: `${ORIGIN}/apply` }, blockers: [], owner: { candidateName: 'Dana Okafor' },
  fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] },
};

describe('a wall that clears while the run waits', () => {
  let browser;
  beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch({ headless: true })); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  skipWithoutBrowser(() => browser);

  async function run({ options = {}, deps = {}, solveAfter = null }) {
    const context = await browser.newContext();
    let solved = false;
    await context.route(`${ORIGIN}/**`, (route) => (new URL(route.request().url()).pathname === '/__solved'
      ? route.fulfill({ status: 200, contentType: 'text/plain', body: solved ? 'yes' : 'no' })
      : route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })));
    if (solveAfter != null) setTimeout(() => { solved = true; }, solveAfter);
    const page = await context.newPage();
    const trail = [];
    const result = await assistApply({
      packet, config, options: { headless: true, statePath: false, maxSteps: 1, ...options },
      deps: { createSession: async () => ({ page, close: async () => {} }), onState: (s) => trail.push(s), ...deps },
    });
    return { result, page, context, trail };
  }

  it('is blocked straight away when waiting is off (the default)', async () => {
    const { result, context } = await run({});
    expect(result.status).toBe('assist_blocked');
    expect(result.blockers.join(' ')).toMatch(/page blocked/);
    expect(result.blockers.join(' ')).not.toMatch(/waited/);
    await context.close();
  }, 60_000);

  it('continues and fills once the wall is gone', async () => {
    const { result, page, context } = await run({ options: { waitForWallMs: 15_000 }, solveAfter: SOLVE_AFTER_MS });
    expect(await page.locator('#em').inputValue()).toBe('dana@example.test');
    // One page was filled, so the run ends at its step limit, not at the wall.
    expect(result.blockers.join(' ')).not.toMatch(/page blocked/);
    expect(result.blockers.join(' ')).toMatch(/step limit/);
    await context.close();
  }, 60_000);

  it('gives up when the wall stays, and says how long it waited', async () => {
    const { result, page, context } = await run({ options: { waitForWallMs: 1500 } });
    expect(result.status).toBe('assist_blocked');
    expect(result.blockers.join(' ')).toMatch(/page blocked.*waited/i);
    expect(await page.locator('#em').inputValue().catch(() => '')).toBe('');
    await context.close();
  }, 60_000);

  it('stops waiting when the person cancels', async () => {
    let calls = 0;
    const started = Date.now();
    const { result, context } = await run({
      options: { waitForWallMs: 30_000 },
      deps: { shouldCancel: () => { calls += 1; return calls > 2; } },
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.status).toBe('cancelled');
    await context.close();
  }, 60_000);
});
