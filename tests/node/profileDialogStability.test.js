/**
 * The profile dialogs must be stable while someone fills them in.
 *
 * Reported as "the popup closes and nothing is saved". Reproduced in a real
 * browser, the causes were three separate things:
 *
 *   1. Application profile: every save rebuilt the WHOLE dialog from the
 *      server's copy, so text typed into any other section was thrown away
 *      (and the "Saved answers" list snapped shut).
 *   2. Every dialog: a click on the backdrop, or Esc, closed it instantly,
 *      with no check for unsaved text.
 *   3. Add/Edit profile: Enter in ANY field submitted the form and the save
 *      then closed the dialog; a second Enter after adding a job title did it
 *      without the person ever pressing Save.
 *
 * These drive the real dashboard in a real browser (see helpers/dashboardPage.js).
 * They self-skip when no browser can launch, like the other browser suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserUnavailable } from './helpers/browser.js';
import {
  afterRerender, answerBox, expandSavedAnswers, launchBrowser, openApplicationProfile,
  openDashboard, startTestDashboard,
} from './helpers/dashboardPage.js';

let browser;
let dash;
let available = true;

beforeAll(async () => {
  try {
    browser = await launchBrowser();
  } catch (err) {
    available = browserUnavailable(err);
    return;
  }
  dash = await startTestDashboard();
});

afterAll(async () => {
  await browser?.close();
  await dash?.stop();
});

/** Run `fn` on a fresh page of the dashboard, always cleaning up. */
async function withPage(fn) {
  const { page, context } = await openDashboard(browser, dash.url);
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

describe('Application profile: unsaved edits survive a re-render', { timeout: 30_000 }, () => {
  it('keeps an unsaved answer, and the open list, when the details section is saved', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      await answerBox(page, 'work_authorization').fill('Typed here, not saved yet');
      await page.locator('#pf-city').fill('Denver');

      await afterRerender(page, () => page.getByRole('button', { name: 'Save details' }).click());

      // The city WAS saved, so the rebuilt form shows it ...
      expect(await page.locator('#pf-city').inputValue()).toBe('Denver');
      // ... and the answer that was never saved is still what the person typed.
      expect(await answerBox(page, 'work_authorization').inputValue()).toBe('Typed here, not saved yet');
      // The list they had open is still open (it used to snap shut).
      expect(await page.locator('#dlgProfile details.pf-saved[open]').count()).toBe(1);
    });
  });

  it('keeps an unsaved details edit when the answers are saved', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      await page.locator('#pf-phone').fill('555 0100 typed');
      await answerBox(page, 'relocation').fill('Yes, open to relocating within the US.');

      await afterRerender(page, () => page.getByRole('button', { name: 'Save all answers' }).click());

      expect(await answerBox(page, 'relocation').inputValue()).toBe('Yes, open to relocating within the US.');
      expect(await page.locator('#pf-phone').inputValue()).toBe('555 0100 typed');
    });
  });
});
