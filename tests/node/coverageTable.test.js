/**
 * The auto-fill coverage table in System health (audit A1), in a real browser.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { recordCoverage } from '../../src/automation/coverageProbe.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const rec = (over) => ({
  at: '2026-11-16T10:00:00.000Z', ats: 'jobvite', host: 'jobs.jobvite.example.test', path: '/acme/apply',
  found: 5, mapped: 4, needsYou: 1, requiredNeedsYou: 1, uploads: 1, advance: null, fields: [], ...over,
});

describe('System health: auto-fill coverage', { timeout: 90_000 }, () => {
  let browser; let withData; let empty;
  beforeAll(async () => {
    browser = await launchOrSkip(() => launchBrowser());
    if (!browser) return;
    withData = await startTestDashboard({ prepare: (root) => {
      recordCoverage(root, rec());
      recordCoverage(root, rec({ ats: 'taleo', found: 3, mapped: 3, needsYou: 0, requiredNeedsYou: 0 }));
    } });
    empty = await startTestDashboard();
  }, 60_000);
  afterAll(async () => { await browser?.close(); await withData?.stop(); await empty?.stop(); }, 60_000);
  skipWithoutBrowser(() => browser);

  async function openHealth(dash, theme) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', bypassCSP: true });
    const page = await context.newPage();
    await page.goto(`${dash.url}/`);
    await waitUntilConnected(page);
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.locator('[data-action="toggle-activity-menu"]').first().click();
    await page.getByRole('menuitem', { name: 'System health' }).click();
    await page.locator('#coverageTitle').waitFor({ timeout: 30_000 });
    return { page, context };
  }

  it('shows each platform, what it would fill and what needs you, and says it is not live', async () => {
    const { page, context } = await openHealth(withData, 'light');
    const section = page.locator('section.coverage');
    const rows = await section.locator('tbody tr').allInnerTexts();
    expect(rows.map((r) => r.replace(/\s+/g, ' ').trim())).toEqual([
      'jobvite 1 5 4 1 (1 required) 80%',
      'taleo 1 3 3 0 100%',
    ]);
    expect(await section.innerText()).toMatch(/No live site has been probed/);
    await context.close();
  });

  it('with nothing probed, says what a probe is', async () => {
    const { page, context } = await openHealth(empty, 'light');
    expect(await page.locator('section.coverage').innerText()).toMatch(/No form has been probed yet/);
    await context.close();
  });

  for (const theme of ['light', 'dark']) {
    it(`passes axe in the ${theme} theme`, async () => {
      const { page, context } = await openHealth(withData, theme);
      await page.addScriptTag({ path: AXE_PATH });
      const violations = await page.evaluate(async () => {
        // eslint-disable-next-line no-undef
        const r = await axe.run('section.coverage', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
        return r.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
      });
      expect(violations, theme).toEqual([]);
      await context.close();
    });
  }
});
