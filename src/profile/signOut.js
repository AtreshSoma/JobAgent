/**
 * "Sign out everywhere" (audit P5).
 *
 * Each person's browser profile folder (`.browser-profile-<profile id>`, one
 * per browser channel) holds live sign-ins to every application site they used.
 * Removing it signs them out of all of those on this computer; the next
 * auto-fill opens a fresh browser and asks them to sign in again.
 *
 * Only that person's folders are touched (an id that merely starts the same,
 * or another profile's folder, is left alone), only folders directly in the
 * workspace, and never while that browser is open.
 */
import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { browserProfileDirName } from '../automation/assistSupport.js';

const CHANNELS = new Set(['chrome', 'chrome-beta', 'msedge', 'msedge-beta', 'msedge-dev', 'chromium']);

/**
 * This person's browser profile folders in the workspace.
 * @param {string} root workspace root
 * @param {string|null} profileId active profile id, or null for the original shared folder
 * @returns {Array<{name: string, path: string}>}
 */
export function browserProfileDirs(root, profileId) {
  const base = browserProfileDirName({ profileId });
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => name === base || (name.startsWith(`${base}-`) && CHANNELS.has(name.slice(base.length + 1))))
    .sort()
    .map((name) => ({ name, path: join(root, name) }));
}

/**
 * Remove this person's browser profile folders.
 * @param {string} root
 * @param {string|null} profileId
 * @param {{openDirs?: string[]}} [options] folders a browser in this process has open
 * @returns {{removed: string[]}}
 */
export function signOutEverywhere(root, profileId, { openDirs = [] } = {}) {
  const dirs = browserProfileDirs(root, profileId);
  const open = new Set(openDirs.map((d) => resolve(d)));
  const busy = dirs.filter((d) => open.has(resolve(d.path)));
  if (busy.length) {
    throw Object.assign(new Error('Close the auto-fill browser window first: it is still open, so its sign-ins cannot be removed.'), { statusCode: 409 });
  }
  const top = resolve(root);
  for (const d of dirs) {
    // Directly inside the workspace and named as a browser profile; checked again here.
    if (resolve(d.path, '..') !== top || !d.name.startsWith('.browser-profile')) continue;
    rmSync(d.path, { recursive: true, force: true });
  }
  return { removed: dirs.map((d) => d.name) };
}
