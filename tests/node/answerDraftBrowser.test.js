/**
 * "Answers for this job" in the job detail (audit A4), in a real browser on the
 * real dashboard: draft from the resume with the cited lines shown, edit and
 * approve for this job, take back. The model is stubbed; nothing is typed
 * anywhere. Also checked with axe in both themes.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

let dash; let browser; let available = true;
beforeAll(async () => {
  try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
  dash = await startTestDashboard({
    deps: {
      draftAnswerFn: async () => ({
        ok: true, text: 'I built Azure Databricks pipelines at Contoso that cut load time by 40%.',
        evidence: [{ id: 'u1', text: 'Built medallion pipelines on Azure Databricks, cutting load time by 40%.' }],
        provenance: { task: 'free-text-answer@1' },
      }),
    },
  });
  const now = new Date().toISOString();
  dash.db.upsertJob({
    id: 'ad-1', company: 'Globex', title: 'Senior Data Engineer', url: 'https://boards.greenhouse.io/globex/jobs/9',
    source: 'greenhouse', score: 88, tier: 'Priority', status: 'prepared', posted_at: now, created_at: now,
  });
}, 60_000);
afterAll(async () => { await browser?.close(); await dash?.stop(); });

describe('answers for this job (real browser)', { timeout: 120_000 }, () => {
  for (const theme of ['light', 'dark']) {
    it(`drafts, shows the cited lines, approves and takes back (${theme})`, async (ctx) => {
      if (!available) return ctx.skip();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, bypassCSP: true, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      await page.goto(dash.url);
      await waitUntilConnected(page);
      await page.getByRole('button', { name: 'Jobs', exact: true }).click();
      await page.getByRole('row', { name: /Globex.*Senior Data Engineer/ }).click();
      const panel = page.locator('[data-section="answers"]');
      await panel.waitFor();

      await panel.getByLabel('Question').fill('Why do you want to work at this company?');
      await panel.getByRole('button', { name: 'Draft from my resume' }).click();
      const box = panel.getByLabel('Your answer (edit freely)');
      await box.waitFor().catch(async (e) => { throw new Error(`${e.message}\nPANEL: ${await panel.textContent()}`); });
      expect(await box.inputValue()).toMatch(/Azure Databricks pipelines at Contoso/);
      expect(await panel.textContent()).toContain('Built medallion pipelines on Azure Databricks');

      await page.addScriptTag({ path: AXE_PATH });
      const violations = await page.evaluate(async () => {
        // eslint-disable-next-line no-undef
        const r = await axe.run(document.querySelector('[data-section="answers"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } });
        return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);
      });
      expect(violations).toEqual([]);

      await box.fill('I built Azure Databricks pipelines at Contoso, and I want that work at Globex.');
      await panel.getByRole('button', { name: 'Approve for this job' }).click();
      await panel.getByText('Take back').waitFor();
      expect(await panel.textContent()).toContain('want that work at Globex');
      const stored = await fetch(`${dash.url}/api/jobs/ad-1/approved-answers`).then((r) => r.json());
      expect(stored.answers).toHaveLength(1);

      await panel.getByRole('button', { name: 'Take back' }).click();
      await page.waitForFunction(() => !document.querySelector('[data-section="answers"]')?.textContent.includes('want that work at Globex'));
      expect((await fetch(`${dash.url}/api/jobs/ad-1/approved-answers`).then((r) => r.json())).answers).toEqual([]);
      await context.close();
    });
  }
});
