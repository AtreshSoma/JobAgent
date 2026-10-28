/**
 * Interview Prep (/learn/) as the dashboard serves it, under the dashboard's
 * real Content-Security-Policy (`script-src 'self'`).
 *
 * REGRESSION: the page wired its learning-path cards, hero buttons and brand
 * with inline `onclick=` handlers. The CSP refuses inline handlers, so under
 * the dashboard every one of those controls was dead, with a CSP violation
 * logged on each page load.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';

const LEARN = join(process.cwd(), 'src', 'dashboard', 'public', 'learn');

describe('Interview Prep page', () => {
  it('uses no inline event handlers (the CSP would block them)', () => {
    const files = [join(LEARN, 'index.html'),
      ...readdirSync(join(LEARN, 'assets', 'js')).map((f) => join(LEARN, 'assets', 'js', f))];
    for (const f of files) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    }
  });

  describe('in a browser, served by the dashboard', () => {
    let browser;
    let dash;
    let db;
    beforeAll(async () => {
      db = openDatabase({ path: ':memory:' });
      dash = await startDashboard({ config: {}, db, logger: null, port: 0, deps: { extensionKey: 'k'.repeat(32) } });
      browser = await chromium.launch({ headless: true });
    }, 60_000);
    afterAll(async () => {
      await browser?.close();
      await dash?.close();
      db?.close();
    }, 30_000);

    it('navigates from its cards, hero buttons and brand with no CSP violations', async () => {
      const page = await browser.newPage();
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(String(e)));

      await page.goto(`${dash.url}/learn/`);
      await page.waitForSelector('.path-card');
      expect(await page.locator('.path-card').count()).toBe(10);

      await page.locator('.path-card').first().click();
      await page.waitForSelector('.syllabus');
      expect(page.url()).toMatch(/#\/sql$/);

      await page.locator('.brand').click();
      await page.waitForSelector('.hero');
      await page.locator('.hero .cta a', { hasText: 'Start learning' }).click();
      await page.waitForSelector('#completeBtn');
      expect(page.url()).toMatch(/#\/intro\/welcome$/);

      // Progress marks and un-marks.
      await page.locator('#completeBtn').click();
      await expect.poll(() => page.locator('#progressText').textContent()).toMatch(/^1 of/);
      await page.locator('#completeBtn').click();
      await expect.poll(() => page.locator('#progressText').textContent()).toMatch(/^0 of/);

      expect(errors, errors.join('\n')).toEqual([]);
      await page.close();
    }, 60_000);
  });
});
