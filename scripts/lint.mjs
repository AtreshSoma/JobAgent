#!/usr/bin/env node
/**
 * `npm run lint` — ESLint for the JavaScript, then Ruff for the Python.
 *
 * Ruff is a Python tool and not an npm dependency, so it runs only when it is
 * installed (`ruff` on PATH, or `python -m ruff` with the interpreter the app
 * uses, the project .venv first); otherwise that half is skipped with the
 * install command rather than failing a Node-only setup. ruff is pinned in
 * requirements.txt, which CI installs, so it is never skipped there.
 *
 * Exit code: non-zero when either linter reports errors.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pythonExe } from '../src/resume/pythonEnv.js';

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

// The same interpreter the app uses: $PYTHON, else the project's .venv, else PATH.
const python = pythonExe(process.env, { root: ROOT });
const ruff = available('ruff', []) ? ['ruff', []]
  : available(python, ['-m', 'ruff']) ? [python, ['-m', 'ruff']]
    : null;
if (ruff) {
  console.log('ruff check .');
  if (run(ruff[0], [...ruff[1], 'check', '.']) !== 0) failed = true;
} else {
  console.log('ruff not installed — Python lint skipped. Install it with:  pip install -r requirements.txt (into the project .venv)');
}

process.exit(failed ? 1 : 0);
