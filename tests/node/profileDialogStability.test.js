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
  afterRerender, answerBox, clickBackdrop, createProfile, expandSavedAnswers, isOpen, launchBrowser,
  openAddProfileDialog, openApplicationProfile, openDashboard, openEditProfileDialog, startTestDashboard,
  watchPatches,
} from './helpers/dashboardPage.js';

let browser;
let dash;
let available = true;

// Launching a browser and booting a dashboard can take longer than vitest's 10s
// default hook limit on a busy machine; that is slowness, not a failure.
const HOOK_TIMEOUT = 60_000;

beforeAll(async () => {
  try {
    browser = await launchBrowser();
  } catch (err) {
    available = browserUnavailable(err);
    return;
  }
  dash = await startTestDashboard();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await dash?.stop();
}, HOOK_TIMEOUT);

/** Run `fn` on a fresh page of a dashboard (the shared one by default), always cleaning up. */
async function withPage(fn, which = dash) {
  const { page, context } = await openDashboard(browser, which.url);
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

describe('Unsaved text is never thrown away by closing', { timeout: 30_000 }, () => {
  let own;
  beforeAll(async () => {
    if (!available) return;
    own = await startTestDashboard();
    await createProfile(own.url, {
      fullName: 'Casey Fixture', email: 'casey@example.com', targetRoles: ['Data Engineer'], city: 'Austin', state: 'TX',
    });
  }, HOOK_TIMEOUT);
  afterAll(async () => { await own?.stop(); }, HOOK_TIMEOUT);

  const typeAnAnswer = async (page) => {
    await openApplicationProfile(page);
    await expandSavedAnswers(page);
    await answerBox(page, 'work_authorization').fill('Typed, not saved yet');
  };

  it('ignores a click on the backdrop while there is unsaved text', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await typeAnAnswer(page);
      await clickBackdrop(page);
      expect(await isOpen(page, 'dlgProfile')).toBe(true);
      expect(await answerBox(page, 'work_authorization').inputValue()).toBe('Typed, not saved yet');
    }, own);
  });

  it('still closes on a backdrop click when nothing was changed', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await clickBackdrop(page);
      expect(await isOpen(page, 'dlgProfile')).toBe(false);
    }, own);
  });

  it('asks before discarding on Esc, and "Keep editing" returns to the same text', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await typeAnAnswer(page);
      await page.keyboard.press('Escape');
      await page.locator('#dlgConfirm[open]').waitFor();
      expect(await page.locator('#dlgConfirmTitle').innerText()).toBe('Discard unsaved changes?');

      await page.getByRole('button', { name: 'Keep editing' }).click();
      expect(await isOpen(page, 'dlgConfirm')).toBe(false);
      expect(await isOpen(page, 'dlgProfile')).toBe(true);
      expect(await answerBox(page, 'work_authorization').inputValue()).toBe('Typed, not saved yet');
    }, own);
  });

  it('"Discard changes" closes it, and the next visit starts from what is saved', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await typeAnAnswer(page);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Discard changes' }).click();
      expect(await isOpen(page, 'dlgProfile')).toBe(false);

      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      expect(await answerBox(page, 'work_authorization').inputValue()).not.toBe('Typed, not saved yet');
    }, own);
  });

  it('asks on the Close button too, but closes straight away when nothing changed', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await page.locator('#dlgProfile .dlg-foot').getByRole('button', { name: 'Close' }).click();
      expect(await isOpen(page, 'dlgProfile')).toBe(false); // clean: no prompt

      await typeAnAnswer(page);
      await page.locator('#dlgProfile .dlg-foot').getByRole('button', { name: 'Close' }).click();
      await page.locator('#dlgConfirm[open]').waitFor();
      expect(await isOpen(page, 'dlgProfile')).toBe(true);
    }, own);
  });

  it('Add profile: a click outside and Esc both protect what was typed', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openAddProfileDialog(page);
      await page.locator('#personName').fill('Jordan Fixture');
      await clickBackdrop(page);
      expect(await isOpen(page, 'dlgPerson')).toBe(true);
      await page.keyboard.press('Escape');
      await page.locator('#dlgConfirm[open]').waitFor();
      expect(await page.locator('#personName').inputValue()).toBe('Jordan Fixture');
    }, own);
  });
});

describe('Edit profile: Enter never saves or closes by accident', { timeout: 30_000 }, () => {
  let own;
  beforeAll(async () => {
    if (!available) return;
    own = await startTestDashboard();
    await createProfile(own.url, {
      fullName: 'Casey Fixture', email: 'casey@example.com', targetRoles: ['Data Engineer'], city: 'Austin', state: 'TX',
    });
  }, HOOK_TIMEOUT);
  afterAll(async () => { await own?.stop(); }, HOOK_TIMEOUT);

  it('Enter in a field leaves the dialog open and saves nothing', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const patches = watchPatches(page);
      await openEditProfileDialog(page);
      await page.locator('#personCity').fill('Denver');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      expect(await isOpen(page, 'dlgPerson')).toBe(true);
      expect(patches).toEqual([]);
      expect(await page.locator('#personCity').inputValue()).toBe('Denver');
    }, own);
  });

  it('a second Enter after adding a job title does not save or close either', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const patches = watchPatches(page);
      await openEditProfileDialog(page);
      await page.locator('#personRoleInput').fill('Analytics Engineer');
      await page.keyboard.press('Enter'); // adds the chip
      expect(await page.locator('#personRoleList li').count()).toBe(2);
      await page.keyboard.press('Enter'); // the press that used to save and close
      await page.waitForTimeout(600);
      expect(await isOpen(page, 'dlgPerson')).toBe(true);
      expect(patches).toEqual([]);
    }, own);
  });

  it('Ctrl+Enter is the deliberate keyboard save', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const patches = watchPatches(page);
      await openEditProfileDialog(page);
      await page.locator('#personCity').fill('Denver');
      await page.keyboard.press('Control+Enter');
      await page.locator('#dlgPerson').waitFor({ state: 'hidden' });
      expect(patches.length).toBe(1);
    }, own);
  });

  it('in the Application profile details, Enter does not save but Ctrl+Enter does', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      let saves = 0;
      page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/profile')) saves += 1; });
      await openApplicationProfile(page);
      await page.locator('#pf-city').fill('Denver');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      expect(saves).toBe(0);
      await afterRerender(page, () => page.keyboard.press('Control+Enter'));
      expect(saves).toBe(1);
    }, own);
  });
});
