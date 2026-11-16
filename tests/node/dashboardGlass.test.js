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
      await expect.poll(() => tabs.nth(2).getAttribute('aria-selected')).toBe('true');
      await expect.poll(() => offset(page, '#tabs', '.tab[aria-selected="true"]'), { timeout: 5_000 }).toEqual({ x: 0, w: 0, shown: true });
      expect(await page.locator('#tabs > .glass-lens').count()).toBe(1);
      // The lens is decoration: hidden from assistive technology, and it never takes a click.
      expect(await page.locator('#tabs > .glass-lens').getAttribute('aria-hidden')).toBe('true');
      expect(await page.locator('#tabs > .glass-lens').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    } finally {
      await page.close();
    }
  });

  it('sets off on the press, glides on transform alone, and keeps tab widths steady', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${dash.url}/`);
      await waitUntilConnected(page);
      await page.locator('.viewswitch [data-view="board"]').click();
      await expect.poll(() => offset(page, '#tabs', '.tab[aria-selected="true"]'), { timeout: 5_000 }).toEqual({ x: 0, w: 0, shown: true });
      const lens = page.locator('#tabs > .glass-lens');
      // The lens fades in as the tab row comes out of hiding; let that finish.
      await page.waitForTimeout(400);
      const widths = () => page.locator('#tabs .tab').evaluateAll((tabs) => tabs.map((t) => t.offsetWidth));
      const before = await widths();
      const target = page.locator('#tabs .tab').nth(3);
      const box = await target.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      // Still pressed: nothing is selected yet, and the lens is already on its way.
      await page.waitForTimeout(60);
      expect(await target.getAttribute('aria-selected')).toBe('false');
      const glides = await lens.evaluate((el) => el.getAnimations().map((a) => Object.keys(a.effect.getKeyframes()[0]).filter((k) => !['offset', 'easing', 'composite', 'computedOffset'].includes(k))));
      expect(glides.length).toBe(1);
      // Only transform is animated: it runs off the main thread.
      expect(glides[0]).toEqual(['transform']);
      await page.mouse.up();
      await expect.poll(() => target.getAttribute('aria-selected')).toBe('true');
      await expect.poll(() => offset(page, '#tabs', '.tab[aria-selected="true"]'), { timeout: 5_000 }).toEqual({ x: 0, w: 0, shown: true });
      // The heavier selected label never pushes the row sideways.
      expect(await widths()).toEqual(before);
      // The tab row was rebuilt by the selection; the lens is the same one.
      expect(await page.locator('#tabs > .glass-lens').count()).toBe(1);
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

  it('asks for a search only when one is due, and offers the way back up on a long list', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${dash.url}/`);
      await waitUntilConnected(page);
      // The test workspace has never searched: Find jobs says so.
      await expect.poll(() => page.locator('.split.menu').getAttribute('data-stale')).toBe('');
      expect(await page.locator('#btnDiscover').getAttribute('title')).toMatch(/^No search has run yet\. /);
      // After a recent search it rests, and its own description comes back.
      // A string, so the test runner does not rewrite the page's own import().
      await page.evaluate(`import('/assets/js/analytics.js').then((m) => m.renderHealth({
        lastDiscoveryAt: new Date(Date.now() - 3600000).toISOString(), totals: { postedLast7d: 1 },
      }))`);
      expect(await page.locator('.split.menu').getAttribute('data-stale')).toBeNull();
      expect(await page.locator('#btnDiscover').getAttribute('title')).toMatch(/^Search every configured job board/);
      // Back to top lives in the docked pager, hidden at the top of the page.
      expect(await page.locator('.pagerbar .to-top').count()).toBe(1);
      expect(await page.locator('.pagerbar .to-top').isHidden()).toBe(true);
    } finally {
      await page.close();
    }
  });
});
