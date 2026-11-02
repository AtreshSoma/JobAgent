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
  afterRerender, answerBox, clickBackdrop, createProfile, editJson, expandSavedAnswers, isOpen, launchBrowser,
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

describe('Template text is a placeholder, never a saved value', { timeout: 30_000 }, () => {
  const TEMPLATE_YEARS = 'YOUR total years of professional experience.';
  const TEMPLATE_CHECK = 'YOUR answer about background checks.';
  let own;
  beforeAll(async () => {
    if (!available) return;
    own = await startTestDashboard({
      prepare: (root) => {
        editJson(root, 'config/screening_answers.json', (doc) => {
          doc.answers.find((a) => a.id === 'years_experience').answer = TEMPLATE_YEARS;
          doc.answers.find((a) => a.id === 'background_check').answer = TEMPLATE_CHECK;
        });
        editJson(root, 'config/candidate.json', (c) => { c.location.city = 'Your City'; });
      },
    });
  }, HOOK_TIMEOUT);
  afterAll(async () => { await own?.stop(); }, HOOK_TIMEOUT);

  /** Record every POST the page sends, with its parsed JSON body. */
  const watchPosts = (page) => {
    const sent = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') sent.push({ url: new URL(r.url()).pathname, body: JSON.parse(r.postData() || '{}') });
    });
    return sent;
  };

  it('shows template text as grey placeholder text in an empty box', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      const years = answerBox(page, 'years_experience');
      expect(await years.inputValue()).toBe('');
      expect(await years.getAttribute('placeholder')).toBe(TEMPLATE_YEARS);
      expect(await page.locator('#pf-city').inputValue()).toBe('');
      expect(await page.locator('#pf-city').getAttribute('placeholder')).toBe('Your City');

      // Grey: the placeholder's colour is not the colour typed text would have.
      const [placeholder, typed] = await years.evaluate((n) => [
        getComputedStyle(n, '::placeholder').color, getComputedStyle(n).color,
      ]);
      expect(placeholder).not.toBe(typed);
    }, own);
  });

  it('saves an untouched template exactly as stored, and sends no template detail at all', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const posts = watchPosts(page);
      await openApplicationProfile(page);
      await expandSavedAnswers(page);

      await page.locator('#pf-phone').fill('9195550199');
      await afterRerender(page, () => page.getByRole('button', { name: 'Save details' }).click());
      const details = posts.find((p) => p.url === '/api/profile');
      // The city is still template text and was never touched: it is not sent.
      expect(Object.keys(details.body.values)).not.toContain('location.city');
      expect(details.body.values['contact.phone']).toBe('9195550199');

      await afterRerender(page, () => page.getByRole('button', { name: 'Save all answers' }).click());
      const answers = posts.find((p) => p.url === '/api/profile/answers').body.answers;
      // An untouched template answer is the entry as it already is on disk,
      // not an answer the person typed.
      expect(answers.find((a) => a.id === 'years_experience').answer).toBe(TEMPLATE_YEARS);
    }, own);
  });

  it('typing replaces the placeholder, and the typed text is what is saved and shown next time', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      const posts = watchPosts(page);
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      await answerBox(page, 'background_check').fill('Yes, willing to complete one.');
      await afterRerender(page, () => page.getByRole('button', { name: 'Save all answers' }).click());
      const sent = posts.find((p) => p.url === '/api/profile/answers').body.answers;
      expect(sent.find((a) => a.id === 'background_check').answer).toBe('Yes, willing to complete one.');
    }, own);

    await withPage(async (page) => {
      await openApplicationProfile(page);
      await expandSavedAnswers(page);
      const box = answerBox(page, 'background_check');
      expect(await box.inputValue()).toBe('Yes, willing to complete one.');
      expect(await box.getAttribute('placeholder')).toBeNull();
    }, own);
  });

  it('Add profile: boxes carry grey examples and the level starts on a "Select" prompt', async (ctx) => {
    if (!available) return ctx.skip();
    await withPage(async (page) => {
      await openAddProfileDialog(page);
      for (const id of ['personName', 'personEmail', 'personCity', 'personState']) {
        expect(await page.locator(`#${id}`).inputValue()).toBe('');
        expect(await page.locator(`#${id}`).getAttribute('placeholder')).toMatch(/^e\.g\., /);
      }
      const level = page.locator('#personSeniority');
      expect(await level.evaluate((n) => n.selectedOptions[0].textContent)).toBe('Select a level (optional)');
      const prompt = await level.evaluate((n) => getComputedStyle(n).color);
      await level.selectOption('senior');
      expect(await level.evaluate((n) => getComputedStyle(n).color)).not.toBe(prompt);
    }, own);
  });
});
