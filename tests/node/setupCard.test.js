/**
 * The setup card on a fresh profile (S1), in a real browser.
 *
 * Before: a red notice listed 19 template values, one per line, each repeating
 * the same instruction, with a CLI command in it. It filled the first screen at
 * 1440×900, so the job list was below the fold. These pin the replacement: one
 * line, neutral, grouped, remembered when collapsed, each item opening the
 * screen that fixes it, and the job list (or its empty state) on the first
 * screen at desktop and phone sizes in both themes, with axe passing.
 */
import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const REPO = join(import.meta.dirname, '..', '..');
const HOOK_TIMEOUT = 60_000;
const SIZES = [[1440, 900], [390, 844]];
const CLI = /\b(npm run|npx|node scripts|pip install)\b/;

/** The shipped example configs: what a fresh install has before anyone edits them. */
function freshProfile(root) {
  for (const name of ['candidate', 'screening_answers', 'cover_letter']) {
    copyFileSync(join(REPO, 'config', `${name}.example.json`), join(root, 'config', `${name}.json`));
  }
}

let browser;
let fresh;
let withJob;

beforeAll(async () => {
  browser = await launchOrSkip(() => launchBrowser());
  if (!browser) return;
  fresh = await startTestDashboard({ prepare: freshProfile });
  withJob = await startTestDashboard({ prepare: freshProfile });
  const now = new Date().toISOString();
  withJob.db.upsertJob({
    id: 'sc-1', company: 'Acme Analytics', title: 'Senior Data Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1',
    source: 'greenhouse', score: 88, tier: 'Priority', sponsorship: 'Confirmed', status: 'scored',
    location: 'Remote, US', posted_at: now, created_at: now, jd_text: 'Build pipelines with Python and SQL.',
  });
}, HOOK_TIMEOUT);

afterAll(async () => {
  await browser?.close();
  await fresh?.stop();
  await withJob?.stop();
}, HOOK_TIMEOUT);

skipWithoutBrowser(() => browser);

/** One page; `storage` survives across pages of the same context, like a person's next visit. */
async function withContext(fn, { size = SIZES[0], theme = 'light', dash = fresh } = {}) {
  const context = await browser.newContext({
    viewport: { width: size[0], height: size[1] }, colorScheme: theme, reducedMotion: 'reduce', bypassCSP: true,
  });
  try {
    const open = async (view = 'board') => {
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      await page.goto(`${dash.url}/`);
      await waitUntilConnected(page);
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await page.locator(`[data-action="set-view"][data-view="${view}"]`).first().click();
      await page.locator('#setupCard').waitFor();
      return page;
    };
    return await fn(open);
  } finally {
    await context.close();
  }
}

/** Is the element's top edge inside the first screen, with no scrolling? */
async function onFirstScreen(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  const height = page.viewportSize().height;
  const scrolled = await page.evaluate(() => window.scrollY);
  return Boolean(box) && scrolled === 0 && box.y >= 0 && box.y + 24 <= height;
}

async function axeViolations(page) {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (tags) => {
    // eslint-disable-next-line no-undef
    const result = await axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] });
    return result.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  }, TAGS);
}

describe('the setup card on a fresh profile', { timeout: 120_000 }, () => {
  for (const size of SIZES) {
    for (const theme of ['light', 'dark']) {
      const where = `${size[0]}×${size[1]} ${theme}`;

      it(`is one compact line, and the empty board is on the first screen (${where})`, async () => {
        await withContext(async (open) => {
          const page = await open('board');
          const card = page.locator('#setupCard');
          expect(await card.locator('.sp-title').innerText()).toMatch(/^Finish setup to apply: 0 of 13 done$/);
          expect(await card.getByRole('progressbar', { name: 'Setup progress' }).getAttribute('aria-valuenow')).toBe('0');
          expect(await card.getByRole('button', { name: 'Continue setup' }).isVisible()).toBe(true);
          // Neutral, not an error, and no command line anywhere.
          expect(await page.locator('#systemNotices .notice.is-error').count()).toBe(0);
          expect(await page.locator('#systemNotices').innerText()).not.toMatch(CLI);
          expect((await card.boundingBox()).height).toBeLessThanOrEqual(72);
          await page.locator('#rows .empty').getByText('No jobs yet').waitFor();
          expect(await onFirstScreen(page, '#rows .empty')).toBe(true);
          expect(await axeViolations(page)).toEqual([]);
        }, { size, theme });
      });

      it(`with its steps open, the board is still on the first screen (${where})`, async () => {
        await withContext(async (open) => {
          const page = await open('board');
          await page.locator('.sp-toggle').click();
          await page.locator('#setupCardBody').waitFor();
          expect(await page.locator('#setupCardBody').innerText()).not.toMatch(CLI);
          await page.locator('#rows .empty').getByText('No jobs yet').waitFor();
          expect(await onFirstScreen(page, '#rows .empty')).toBe(true);
          expect(await axeViolations(page)).toEqual([]);
        }, { size, theme });
      });

      it(`a job in the list is on the first screen (${where})`, async () => {
        await withContext(async (open) => {
          const page = await open('board');
          await page.locator('#rows').getByText('Senior Data Engineer').first().waitFor();
          expect(await onFirstScreen(page, '#rows tr')).toBe(true);
        }, { size, theme, dash: withJob });
      });
    }
  }
});

describe('what the card holds', { timeout: 60_000 }, () => {
  it('groups by where each value is fixed, with a count per group and no duplicates', async () => {
    await withContext(async (open) => {
      const page = await open('board');
      await page.locator('.sp-toggle').click();
      const groups = page.locator('#setupCard .sp-group');
      const summaries = await groups.locator('summary').allInnerTexts();
      expect(summaries.map((s) => s.replace(/\s+/g, ' ').trim())).toEqual([
        'Contact 0 of 8', 'Work authorization and sponsorship 0 of 1', 'Experience 0 of 2', 'Screening answers 0 of 2',
      ]);
      const labels = await page.locator('#setupCard .sp-item-label').allTextContents();
      expect(labels).toEqual([
        'Name', 'Preferred name', 'Email', 'Phone', 'City', 'State', 'ZIP code', 'LinkedIn',
        'Work authorization and sponsorship', 'Years of experience', 'Work history and education',
        'Salary expectation', 'Start date',
      ]);
      // Only Experience offers the resume; work authorization and salary say only you can answer.
      const fromResume = page.locator('#setupCard [data-action="fill-profile-from-resume"]');
      expect(await fromResume.count()).toBe(1);
      expect(await fromResume.evaluate((b) => b.closest('.sp-group').dataset.group)).toBe('experience');
      const personOnly = page.locator('#setupCard .sp-item', { hasText: 'Only you can answer this' }).locator('.sp-item-label');
      expect(await personOnly.allTextContents()).toEqual(['Work authorization and sponsorship', 'Salary expectation']);
    });
  });

  it('stays collapsed, or open, between visits', async () => {
    await withContext(async (open) => {
      let page = await open('board');
      expect(await page.locator('#setupCardBody').isHidden()).toBe(true);
      await page.locator('.sp-toggle').click();
      expect(await page.locator('.sp-toggle').getAttribute('aria-expanded')).toBe('true');
      page = await open('board');
      expect(await page.locator('#setupCardBody').isVisible()).toBe(true);
      await page.locator('.sp-toggle').click();
      page = await open('board');
      expect(await page.locator('#setupCardBody').isHidden()).toBe(true);
      expect(await page.locator('.sp-toggle').getAttribute('aria-expanded')).toBe('false');
    });
  });

  it('Continue setup opens the Application profile at the first field still to fill in', async () => {
    await withContext(async (open) => {
      const page = await open('board');
      await page.getByRole('button', { name: 'Continue setup' }).click();
      await page.locator('#dlgProfile[open] [data-path="identity.fullName"]').waitFor();
      await page.waitForFunction(() => document.activeElement?.dataset?.path === 'identity.fullName');
    });
  });

  it('a Saved-answer item opens the answers, scrolled to that answer', async () => {
    await withContext(async (open) => {
      const page = await open('board');
      await page.locator('.sp-toggle').click();
      await page.locator('#setupCard .sp-group[data-group="authorization"] summary').click();
      await page.getByRole('button', { name: 'Fix Work authorization and sponsorship' }).click();
      await page.locator('#dlgProfile[open] details.pf-saved[open]').waitFor();
      await page.waitForFunction(() => document.activeElement?.dataset?.aAnswer === 'work_authorization');
    });
  });

  it('the Next panel offers the first search, not "nothing new in 24 hours", and it is not held by setup', async () => {
    await withContext(async (open) => {
      const page = await open('board');
      const next = page.locator('#nextActions');
      await next.getByRole('button', { name: 'Run your first search' }).waitFor();
      expect(await next.innerText()).not.toMatch(/24 hours/);
      expect(await next.getByRole('button', { name: 'Run your first search' }).isDisabled()).toBe(false);
    });
  });

  it('a held Prepare says why and links to the card', async () => {
    await withContext(async (open) => {
      const page = await open('board');
      await page.locator('#rows').getByText('Senior Data Engineer').first().click();
      const box = page.locator('.resume-card .prepare-problem');
      await box.waitFor();
      expect(await box.innerText()).toMatch(/Prepare is off until setup is finished/);
      expect(await box.innerText()).not.toMatch(CLI);
      expect(await page.locator('.resume-card [data-action="prepare-one"]').isDisabled()).toBe(true);
      await box.getByRole('button', { name: 'Finish setup' }).click();
      await page.locator('#setupCardBody').waitFor();
      expect(await page.locator('.sp-toggle').getAttribute('aria-expanded')).toBe('true');
    }, { dash: withJob });
  });
});
