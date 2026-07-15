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
import { basename } from 'node:path';

/**
 * Read the browser's live FileList after setInputFiles. A successful API call
 * alone is not enough: custom ATS widgets can immediately clear/reject a file.
 * `verified: null` means the page double does not expose FileList inspection;
 * real Playwright locators do.
 */
export async function verifyUploadAttached(locator, path) {
  if (!locator || typeof locator.evaluate !== 'function') {
    return { verified: null, verificationMethod: 'file-list-unavailable' };
  }
  try {
    const files = await locator.evaluate((input) => Array.from(input.files ?? []).map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    })));
    const wanted = basename(path).toLowerCase();
    const match = Array.isArray(files) && files.some((file) => String(file?.name ?? '').toLowerCase() === wanted);
    return {
      verified: match,
      verificationMethod: 'input-file-list',
      attachedFileCount: Array.isArray(files) ? files.length : 0,
    };
  } catch (err) {
    return { verified: false, verificationMethod: 'input-file-list', verificationError: err.message };
  }
}

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
      const locator = page.locator(u.selector).first();
      await locator.setInputFiles(u.path);
      const verification = await verifyUploadAttached(locator, u.path);
      uploaded.push({ type: u.type, path: u.path, selector: u.selector, ...verification });
      if (verification.verified === false) {
        blockers.push(`${u.type}: upload did not remain attached after selection`);
      }
    } catch (err) {
      blockers.push(`${u.type}: upload failed (${err.message})`);
    }
  }

  return { uploaded, blockers, skipped };
}
