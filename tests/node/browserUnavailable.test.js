/**
 * A missing Playwright browser is an environment problem with one clean
 * message, never a "failed" application carrying Playwright's ASCII banner.
 */
import { describe, expect, it } from 'vitest';

import { assistApply } from '../../src/automation/applyRunner.js';
import {
  checkBrowserAvailable, isBrowserMissingError, stripPlaywrightBanner,
} from '../../src/automation/browser.js';
import { LIFECYCLE } from '../../src/lifecycle.js';

const BANNER = `browserType.launch: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app
╔═════════════════════════════════════════════════════════════════════════╗
║ Looks like Playwright Test or Playwright was just installed or updated. ║
║ Please run the following command to download new browsers:              ║
║                                                                         ║
║     npx playwright install                                              ║
╚═════════════════════════════════════════════════════════════════════════╝`;

describe('missing browser', () => {
  it('is recognised and its banner stripped to one line', () => {
    expect(isBrowserMissingError(new Error(BANNER))).toBe(true);
    expect(isBrowserMissingError(new Error('Target page, context or browser has been closed'))).toBe(false);
    const line = stripPlaywrightBanner(BANNER);
    expect(line).not.toMatch(/[╔║╚═\n]/);
    expect(line).toMatch(/^browserType\.launch: Executable doesn't exist .* npx playwright install$/);
  });

  it('the runner records assist_blocked with a browser_unavailable: reason', async () => {
    const r = await assistApply({
      packet: { job: { id: 'j', url: 'https://boards.greenhouse.io/a/jobs/1' }, blockers: [], fillPlan: {} },
      config: { runtime: {} },
      options: { statePath: false, headless: true },
      deps: { createSession: async () => { throw new Error(BANNER); } },
    });
    expect(r.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
    expect(r.statusReason).toBe('browser_unavailable: Browser not installed — run: npx playwright install chromium');
    expect(r.blockers).toContain(r.statusReason);
    expect(r.blockers.join('\n')).not.toMatch(/╔|║/);
  });

  it('other launch failures stay failed, but without the banner', async () => {
    const r = await assistApply({
      packet: { job: { id: 'j', url: 'https://x.test/1' }, blockers: [], fillPlan: {} },
      config: { runtime: {} },
      options: { statePath: false, headless: true },
      deps: { createSession: async () => { throw new Error('profile is locked\n║ box ║'); } },
    });
    expect(r.status).toBe(LIFECYCLE.FAILED);
    expect(r.blockers.join(' ')).toMatch(/could not start browser: profile is locked box/);
  });

  it('checkBrowserAvailable reports a missing executable', async () => {
    const chromium = { executablePath: () => '/nope/chrome' };
    expect(await checkBrowserAvailable({ chromium, exists: () => false }))
      .toMatchObject({ ok: false, code: 'browser_unavailable' });
    expect((await checkBrowserAvailable({ chromium, exists: () => true })).ok).toBe(true);
    expect((await checkBrowserAvailable({ channel: 'msedge' })).ok).toBe(true);
  });
});
