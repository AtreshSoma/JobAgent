#!/usr/bin/env node
/**
 * `npm run lint` — ESLint for the JavaScript, then Ruff for the Python.
 *
 * Ruff is a Python tool and not an npm dependency, so it runs only when it is
 * installed (`ruff` on PATH, or `python -m ruff`); otherwise that half is
 * skipped with the install command rather than failing a Node-only setup. CI
 * installs it, so it is never skipped there.
 *
 * Exit code: non-zero when either linter reports errors.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';

/** Run a command inheriting stdio; returns its status (null when it could not start). */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: win });
  return r.error ? null : r.status;
}

/** Is a command runnable at all? (Probes with --version, output discarded.) */
function available(cmd, args) {
  const r = spawnSync(cmd, [...args, '--version'], { cwd: ROOT, stdio: 'ignore', shell: win });
  return !r.error && r.status === 0;
}

let failed = false;

console.log('eslint .');
const eslint = run(join(ROOT, 'node_modules', '.bin', win ? 'eslint.cmd' : 'eslint'), ['.']);
if (eslint !== 0) failed = true;

const python = process.env.PYTHON || process.env.PYTHON_EXECUTABLE || (win ? 'python' : 'python3');
const ruff = available('ruff', []) ? ['ruff', []]
  : available(python, ['-m', 'ruff']) ? [python, ['-m', 'ruff']]
    : null;
if (ruff) {
  console.log('ruff check .');
  if (run(ruff[0], [...ruff[1], 'check', '.']) !== 0) failed = true;
} else {
  console.log('ruff not installed — Python lint skipped. Install it with:  python -m pip install ruff');
}

process.exit(failed ? 1 : 0);
