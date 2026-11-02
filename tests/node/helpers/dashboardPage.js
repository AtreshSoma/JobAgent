/**
 * A real dashboard on a PRIVATE copy of the test workspace, plus a real browser.
 *
 * The profile dialogs are interaction bugs (a dialog that closes, a field that
 * resets), so they can only be tested in a browser against the real front-end
 * modules — pulling functions out of the source text and running them in a blank
 * page cannot see a re-render, a focus change or a backdrop click.
 *
 * Why a private workspace: the suite-wide one from globalSetup is shared by every
 * test file running in parallel, and these tests SAVE (they edit candidate.json
 * and screening_answers.json). A private copy keeps those writes from changing
 * what another file reads.
 *
 * Launching honours BROWSER_CHANNEL (the same variable the product uses), so a
 * machine with Chrome but no downloaded Chromium can run them:
 *   BROWSER_CHANNEL=chrome npx vitest run tests/node/profileDialogStability.test.js
 */

import { rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { buildTestRoot } from '../globalSetup.js';
import { loadConfig } from '../../../src/config/loadConfig.js';
import { openDatabase } from '../../../src/logging/db.js';
import { startDashboard } from '../../../src/dashboard/server.js';

export function launchBrowser() {
  const channel = process.env.BROWSER_CHANNEL;
  return chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
}

/**
 * @param {object} [options]
 * @param {(root: string) => void} [options.prepare] edit the private workspace before the server reads it
 * @returns {Promise<{ url: string, root: string, stop: () => Promise<void> }>}
 */
export async function startTestDashboard({ prepare } = {}) {
  const root = buildTestRoot();
  prepare?.(root);
  const loadHere = (opts = {}) => loadConfig({ ...opts, root });
  const config = loadHere({ loadEnv: false });
  const db = openDatabase({ path: ':memory:' });
  const dash = await startDashboard({
    config, db, logger: null, port: 0, deps: { loadConfigImpl: loadHere },
  });
  return {
    url: dash.url,
    root,
    async stop() {
      await dash.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Rewrite one JSON file of the private workspace. */
export function editJson(root, relPath, mutate) {
  const file = join(root, relPath);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  mutate(doc);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** A page on the dashboard, with the board loaded. */
export async function openDashboard(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${url}/`);
  await page.waitForSelector('#accountMenu', { state: 'attached' });
  return { page, context };
}

/** Header menu -> Application profile, the way a person gets there. */
export async function openApplicationProfile(page) {
  await page.locator('[data-action="toggle-account-menu"]').click();
  await page.getByRole('menuitem', { name: 'Application profile' }).click();
  await page.locator('#dlgProfile[open] .pf-section').first().waitFor();
}

/** Expand the collapsed "Saved answers" list, as a person does before editing one. */
export async function expandSavedAnswers(page) {
  const summary = page.locator('#dlgProfile summary', { hasText: 'Saved answers' });
  if (!(await page.locator('#dlgProfile details.pf-saved[open]').count())) await summary.click();
}

export const answerBox = (page, id) => page.locator(`[data-a-answer="${id}"]`);

/**
 * Run `action`, then wait until the Application profile dialog has REBUILT its
 * body. A test that asserts "my text survived the re-render" must know the
 * re-render happened first; asserting straight after the click passes by
 * accident, because the save's toast appears before the rebuild finishes.
 */
export async function afterRerender(page, action) {
  await page.evaluate(() => {
    document.querySelector('#profileBody').firstElementChild.dataset.stale = '1';
  });
  await action();
  await page.waitForFunction(() => {
    const body = document.querySelector('#profileBody');
    return body.children.length > 0 && !body.querySelector(':scope > [data-stale]');
  });
}
