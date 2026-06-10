/**
 * Upload runner.
 *
 * Attaches the tailored resume (and optional cover letter) to the file inputs
 * named in a packet's fill plan, using Playwright's `setInputFiles`. It verifies
 * each file exists before attaching and reports anything it could not resolve as
 * a blocker. It uploads only the artifacts the packet already prepared — it does
 * not fabricate or substitute documents.
 */

import { existsSync } from 'node:fs';

/**
 * @param {object} page Playwright page (or compatible)
 * @param {object} fillPlan packet.fillPlan ({ uploads: [{type, path, selector}] })
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] resolve only; do not attach
 * @param {Function} [options.fileExists=existsSync]
 * @returns {Promise<{ uploaded: object[], blockers: string[], skipped: object[] }>}
 */
export async function uploadFiles(page, fillPlan = {}, { dryRun = false, fileExists = existsSync } = {}) {
  const uploads = Array.isArray(fillPlan.uploads) ? fillPlan.uploads : [];
  const uploaded = [];
  const blockers = [];
  const skipped = [];

  for (const u of uploads) {
    if (!u.path) {
      skipped.push({ type: u.type, reason: 'no file path' });
      continue;
    }
    if (!fileExists(u.path)) {
      blockers.push(`${u.type}: file not found at ${u.path}`);
      continue;
    }
    if (!u.selector) {
      blockers.push(`${u.type}: no upload selector resolved`);
      continue;
    }
    let count = 0;
    try {
      count = await page.locator(u.selector).count();
    } catch {
      count = 0;
    }
    if (count < 1) {
      blockers.push(`${u.type}: upload input not found (${u.selector})`);
      continue;
    }
    if (dryRun) {
      skipped.push({ type: u.type, path: u.path, selector: u.selector, reason: 'dry run' });
      continue;
    }
    try {
      await page.locator(u.selector).first().setInputFiles(u.path);
      uploaded.push({ type: u.type, path: u.path, selector: u.selector });
    } catch (err) {
      blockers.push(`${u.type}: upload failed (${err.message})`);
    }
  }

  return { uploaded, blockers, skipped };
}
