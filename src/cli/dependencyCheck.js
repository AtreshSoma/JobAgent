/**
 * Are the installed node_modules the ones package-lock.json describes?
 *
 * Why this exists
 * ---------------
 * The launchers used to check only that node_modules EXISTED. After a `git
 * pull` that moved the lockfile, a user kept running the old install — on one
 * machine vitest was 2.1.9 while the lockfile said 4.1.10 — and the failures
 * that followed looked like bugs in the code, not a stale install.
 *
 * Two answers, for two callers:
 *   - `lockfileHash` / `readInstallStamp` / `writeInstallStamp`: a cheap
 *     "did package-lock.json change since the last install?" for the launchers
 *     (scripts/prepareLaunch.mjs). The stamp lives INSIDE node_modules, so
 *     deleting node_modules also deletes the stamp.
 *   - `installedVersionDrift`: the precise per-package answer for `doctor`,
 *     comparing each direct dependency's installed version to the lockfile.
 *
 * Zero dependencies on purpose: this runs BEFORE dependencies are installed.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Stamp file, inside node_modules so it disappears with it. */
export const INSTALL_STAMP = join('node_modules', '.jobagent-lock');

/** Minimum supported Node.js: node:sqlite is unflagged from 22.13.0. */
export const MIN_NODE_VERSION = '22.13.0';

/**
 * sha256 of package-lock.json, or null when there is no lockfile.
 * @param {string} root
 * @returns {string|null}
 */
export function lockfileHash(root) {
  const lock = join(root, 'package-lock.json');
  if (!existsSync(lock)) return null;
  return createHash('sha256').update(readFileSync(lock)).digest('hex');
}

/** The lockfile hash recorded by the last successful install, or null. */
export function readInstallStamp(root) {
  try {
    return readFileSync(join(root, INSTALL_STAMP), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Record that node_modules now matches the current lockfile. */
export function writeInstallStamp(root, hash = lockfileHash(root)) {
  if (hash) writeFileSync(join(root, INSTALL_STAMP), `${hash}\n`, 'utf8');
}

/**
 * Does node_modules need (re)installing?
 * @param {string} root
 * @returns {{ needed: boolean, reason: string }}
 */
export function installNeeded(root) {
  if (!existsSync(join(root, 'node_modules'))) return { needed: true, reason: 'node_modules is missing' };
  const current = lockfileHash(root);
  const stamp = readInstallStamp(root);
  if (!stamp) return { needed: true, reason: 'no install stamp (installed before this check existed, or by hand)' };
  if (current && stamp !== current) return { needed: true, reason: 'package-lock.json changed since the last install' };
  return { needed: false, reason: 'up to date' };
}

/**
 * Direct dependencies whose installed version differs from the lockfile.
 *
 * @param {string} root
 * @returns {{ checked: number, drift: Array<{name: string, installed: string|null, locked: string}> }|null}
 *   null when there is no readable lockfile / package.json to compare against
 */
export function installedVersionDrift(root) {
  let pkg;
  let lock;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  } catch {
    return null;
  }
  const names = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) });
  const drift = [];
  let checked = 0;
  for (const name of names) {
    const locked = lock.packages?.[`node_modules/${name}`]?.version;
    if (!locked) continue;
    checked += 1;
    let installed = null;
    try {
      installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version ?? null;
    } catch { /* not installed */ }
    if (installed !== locked) drift.push({ name, installed, locked });
  }
  return { checked, drift };
}

/**
 * Compare two dotted versions numerically (a prerelease suffix is ignored).
 * @returns {number} <0, 0, >0
 */
export function compareVersions(a, b) {
  const parts = (v) => String(v).replace(/^v/, '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  return 0;
}

/** True when `version` (e.g. process.version) meets MIN_NODE_VERSION. */
export function nodeVersionSupported(version) {
  return compareVersions(version, MIN_NODE_VERSION) >= 0;
}
