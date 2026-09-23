/**
 * When the runner hands a window to the human and they submit, the ATS
 * confirmation page is recorded as a human submission PENDING confirmation —
 * never as applied=1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { assistApply, watchForHumanSubmission } from '../../src/automation/applyRunner.js';
import { recordAssistResult } from '../../src/cli/commands.js';
import { openDatabase } from '../../src/logging/db.js';
import { APPLICATION_PHASE } from '../../src/apply/applicationState.js';
import { LIFECYCLE } from '../../src/lifecycle.js';

const FORM = `<form><label>Email <input id="email" type="email"></label>
  <button id="submit" type="button">Submit application</button></form>
  <script>document.getElementById('submit').addEventListener('click', () => {
    history.pushState({}, '', '#done');
    document.body.innerHTML = '<h1>Thank you for applying!</h1><p>We have received your application.</p>';
  });</script>`;

describe('human-submit detection', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);

  it('the watcher fires on a confirmation page and stops when the page closes', async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    let seen = null;
    const watch = watchForHumanSubmission({ page, url: 'about:blank', pollMs: 50, onConfirmed: (v) => { seen = v; } });
    await watch.ready;
    expect(seen).toBeNull();
    await page.click('#submit');
    await expect.poll(() => seen?.signals ?? null, { timeout: 5000 }).toContain('confirmation message');
    expect(watch.stopped).toBe(true);

    const other = await browser.newPage();
    await other.setContent(FORM);
    const w2 = watchForHumanSubmission({ page: other, url: 'about:blank', pollMs: 50, onConfirmed: () => {} });
    await w2.ready;
    await other.close();
    await expect.poll(() => w2.stopped).toBe(true);
    await page.close();
  }, 30_000);

  it('ignores a confirmation phrase that was already on the page until it navigates', async () => {
    const page = await browser.newPage();
    await page.setContent('<aside>Thanks for applying to our other roles!</aside><form><input id="e"></form>');
    let fired = false;
    const watch = watchForHumanSubmission({ page, url: 'about:blank', pollMs: 30, onConfirmed: () => { fired = true; } });
    await watch.ready;
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(false);
    watch.stop();
    await page.close();
  }, 30_000);

  it('the runner hands off, detects the human submission and records it as submit_unverified', async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Acme', title: 'DE', url: 'https://x.test/apply', status: 'prepared' });
    let saved = null;
    const r = await assistApply({
      packet: {
        job: { id: 'j1', url: 'https://x.test/apply' }, blockers: [], owner: { candidateName: 'Dana Okafor' },
        fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] },
      },
      config: { candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'd@o.dev' } }, screeningAnswers: {}, runtime: {} },
      // headless:false is what leaves the window with the human.
      options: { headless: false, humanSubmitPollMs: 50 },
      deps: {
        stateStore: { path: 'memory://', load: async () => null, save: async (s) => { saved = s; } },
        createSession: async () => ({ page, close: async () => {} }),
        openPage: async (p) => ({ status: 200, html: await p.content(), guard: { blocked: false } }),
        wait: async () => {},
        onHumanSubmitted: (update) => recordAssistResult(db, 'j1', update),
      },
    });
    recordAssistResult(db, 'j1', r);
    expect(r.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(r.watchingForHumanSubmit).toBe(true);
    await page.click('#submit');
    await expect.poll(() => db.getJob('j1').status, { timeout: 5000 }).toBe(LIFECYCLE.SUBMIT_UNVERIFIED);
    expect(Number(db.getJob('j1').applied)).toBe(0);
    expect(db.getJob('j1').submitted_confirmation).toMatch(/confirmation page seen/);
    expect(saved.phase).toBe(APPLICATION_PHASE.USER_SUBMITTED);
    db.close();
    await page.close();
  }, 30_000);
});
