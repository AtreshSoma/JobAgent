#!/usr/bin/env node
/**
 * Everything the launchers do before `npm run app`, in ONE place.
 *
 * start-job-agent.sh, Start-JobAgent.ps1 and start-job-agent.cmd (and
 * start-dashboard.cmd, which wraps the .cmd) each used to carry their own copy
 * of "install if node_modules is missing" — and each only checked that the
 * folder EXISTED, so a `git pull` that changed package-lock.json left users on
 * a stale install indefinitely. Three shell dialects drift; one Node script
 * does not. The launchers only check that Node itself is new enough, then call
 * this.
 *
 * Steps:
 *   1. Dependencies: if node_modules is missing, or package-lock.json's sha256
 *      differs from the stamp written by the last install, run `npm ci`. If
 *      that fails, say why and fall back to `npm install`. Stamp on success.
 *   2. Personal config: seed any missing candidate.json / screening answers /
 *      cover letter / master resume from the tracked examples. Never
 *      overwrites (scripts/setupLocalConfig.mjs).
 *   3. Browser: if Playwright's Chromium is not downloaded, print the one-line
 *      install command, and in an interactive terminal offer to run it. The
 *      dashboard works without it; only form filling needs it.
 *
 * Zero dependencies until step 3 (which imports playwright only after step 1
 * has made sure it is installed).
 *
 * Exit codes: 0 ready, 1 dependencies could not be installed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { installNeeded, writeInstallStamp } from '../src/cli/dependencyCheck.js';
import { materializeLocalFiles } from './setupLocalConfig.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run npm. On Windows npm is `npm.cmd`, which Node (since the CVE-2024-27980
 * fix) only spawns through a shell.
 */
function npm(args, { root = ROOT, spawnImpl = spawnSync } = {}) {
  const r = spawnImpl('npm', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  return { ok: r.status === 0 && !r.error, status: r.status, error: r.error };
}

/**
 * Make node_modules match package-lock.json.
 * @param {object} [options]
 * @param {string} [options.root]
 * @param {Function} [options.run] npm runner (tests)
 * @param {(line: string) => void} [options.log]
 * @returns {{ ok: boolean, installed: boolean, via?: string, reason: string }}
 */
export function ensureDependencies({ root = ROOT, run = (args) => npm(args, { root }), log = console.log } = {}) {
  const need = installNeeded(root);
  if (!need.needed) return { ok: true, installed: false, reason: need.reason };

  log(`Installing dependencies (${need.reason})…`);
  const ci = run(['ci']);
  if (ci.ok) {
    writeInstallStamp(root);
    return { ok: true, installed: true, via: 'npm ci', reason: need.reason };
  }
  // `npm ci` refuses when package.json and the lockfile disagree, and on
  // Windows it can fail to delete a node_modules file another process holds.
  // `npm install` tolerates both; say which path was taken and why.
  log(`npm ci failed (exit ${ci.status ?? ci.error?.message ?? '?'}) — usually package.json and `
    + 'package-lock.json disagree, or a file in node_modules is locked by a running process. '
    + 'Trying npm install instead…');
  const install = run(['install']);
  if (install.ok) {
    writeInstallStamp(root);
    return { ok: true, installed: true, via: 'npm install', reason: need.reason };
  }
  return { ok: false, installed: false, reason: `npm ci and npm install both failed (${need.reason})` };
}

/**
 * Is Playwright's Chromium downloaded? null when playwright is not importable.
 * @param {string} [root]
 * @returns {Promise<boolean|null>}
 */
export async function chromiumInstalled(root = ROOT) {
  try {
    const entry = join(root, 'node_modules', 'playwright', 'index.mjs');
    const { chromium } = await import(pathToFileURL(entry).href);
    const exe = chromium.executablePath();
    return Boolean(exe && existsSync(exe));
  } catch {
    return null;
  }
}

/** Ask a yes/no question on an interactive terminal. Default: no. */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  const deps = ensureDependencies();
  if (!deps.ok) {
    console.error(`Could not install dependencies: ${deps.reason}. Fix the npm error above and run the launcher again.`);
    process.exit(1);
  }

  const { created } = materializeLocalFiles({ root: ROOT });
  if (created.length) {
    console.log(`Created from examples (PLACEHOLDERS — edit them with your real details): ${created.join(', ')}`);
  }

  const chromium = await chromiumInstalled();
  if (chromium === false) {
    const cmd = 'npx playwright install chromium';
    console.log(`Browser for form filling is not installed. The dashboard works without it. Install it with:  ${cmd}`);
    const interactive = process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
    if (interactive && await confirm('Download it now (about 150 MB)?')) {
      const r = spawnSync('npx', ['playwright', 'install', 'chromium'],
        { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
      if (r.status !== 0) console.log(`That failed; run "${cmd}" yourself later. Continuing without it.`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`Launch preparation failed: ${err.message}`);
    process.exit(1);
  });
}
