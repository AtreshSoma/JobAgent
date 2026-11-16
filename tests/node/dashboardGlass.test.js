/**
 * The dashboard's liquid glass: a switch's selected option is one glass lens
 * that sits exactly under it and follows it when the choice changes, including
 * when the stage tabs are rebuilt from scratch. The option underneath keeps its
 * own state attribute, so nothing assistive technology hears changes.
 *
 * Self-skips when no browser can launch, like the other browser suites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

let browser;
let dash;
let available = true;

beforeAll(async () => {
  dash = await startTestDashboard();
  try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await dash?.stop();
}, 60_000);

/** How far the lens sits from the selected option, in pixels. */
const offset = (page, host, selected) => page.evaluate(([h, s]) => {
  const lens = document.querySelector(`${h} > .glass-lens`).getBoundingClientRect();
  const target = document.querySelector(`${h} ${s}`).getBoundingClientRect();
  // `+ 0` folds -0 into 0: a lens one rounding off to the left is still on target.
  return { x: Math.round(lens.left - target.left) + 0, w: Math.round(lens.width - target.width) + 0, shown: lens.width > 0 };
}, [host, selected]);

describe('liquid glass switches', { timeout: 120_000 }, () => {
  it('puts one lens under the selected view and stage, and moves it with the choice', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${dash.url}/`);
      await waitUntilConnected(page);
      expect(await page.locator('.viewswitch > .glass-lens').count()).toBe(1);
      expect(await page.locator('#tabs > .glass-lens').count()).toBe(1);

      await page.locator('.viewswitch [data-view="board"]').click();
      await expect.poll(() => offset(page, '.viewswitch', 'button[aria-pressed="true"]'), { timeout: 5_000 }).toEqual({ x: 0, w: 0, shown: true });

      // The stage tabs are rebuilt on every change; the lens follows the new selection all the same.
      const tabs = page.locator('#tabs .tab');
      await tabs.nth(2).click();
      expect(await tabs.nth(2).getAttribute('aria-selected')).toBe('true');
      await expect.poll(() => offset(page, '#tabs', '.tab[aria-selected="true"]'), { timeout: 5_000 }).toEqual({ x: 0, w: 0, shown: true });
      expect(await page.locator('#tabs > .glass-lens').count()).toBe(1);
      // The lens is decoration: hidden from assistive technology, and it never takes a click.
      expect(await page.locator('#tabs > .glass-lens').getAttribute('aria-hidden')).toBe('true');
      expect(await page.locator('#tabs > .glass-lens').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    } finally {
      await page.close();
    }
  });

  it('moves at once when the reader prefers reduced motion', async (ctx) => {
    if (!available) return ctx.skip();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
      await page.goto(`${dash.url}/`);
      await waitUntilConnected(page);
      await page.locator('.viewswitch [data-view="board"]').click();
      await page.locator('#tabs .tab').nth(1).click();
      // No transition to wait for: it is under the new tab on the next frame.
      await page.waitForTimeout(80);
      expect(await offset(page, '#tabs', '.tab[aria-selected="true"]')).toEqual({ x: 0, w: 0, shown: true });
      // The app's reduced-motion rule leaves every duration at a thousandth of a millisecond, or none.
      const seconds = await page.locator('#tabs > .glass-lens').evaluate((el) => Math.max(...getComputedStyle(el).transitionDuration.split(',').map(parseFloat)));
      expect(seconds).toBeLessThan(0.001);
    } finally {
      await context.close();
    }
  });
});
