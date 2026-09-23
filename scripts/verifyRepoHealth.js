/**
 * Repository health check (run before relying on the agent).
 *
 * Verifies the workspace is structurally sound and SAFE:
 *   1. Required folders and key files exist.
 *   2. Configuration loads and validates against its JSON schemas.
 *   3. The local SQLite database opens.
 *   4. SAFETY: submission stays gated. The legacy always-on auto-submit
 *      surface (LIVE_SUBMIT mode, submit countdowns) must not exist, and the
 *      one legitimate submit path — applyRunner's tryAutoSubmit — must remain
 *      strictly behind the explicit per-run `options.autoSubmit === true`
 *      opt-in. By default the assistant fills and stops before Submit.
 *
 * Exits with code 0 when healthy, 1 when any check fails. Read-only: it never
 * writes or deletes anything.
 *
 * Usage:
 *   node scripts/verifyRepoHealth.js
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

import { loadConfig } from '../src/config/loadConfig.js';
import { openDatabase } from '../src/logging/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail: detail || 'ok' });
  } catch (err) {
    checks.push({ name, ok: false, detail: err.message });
  }
}

/** Required directories (relative to the repo root). */
const REQUIRED_DIRS = [
  'config', 'config/schemas',
  'src', 'src/pipeline', 'src/reports', 'src/automation', 'src/apply',
  'src/scoring', 'src/search', 'src/resume', 'src/config', 'src/utils',
  'scripts', 'tests/node', 'tests/python',
  'resumes/base', 'resumes/output', 'applications/output', 'data', 'logs',
];

/** Required files (relative to the repo root). */
const REQUIRED_FILES = [
  'package.json',
  'src/index.js',
  'src/pipeline/index.js',
  'src/reports/reportGenerator.js',
  'src/reports/jobTracker.js',
  'config/candidate.json',
  'config/scoring.json',
];

/** Source folders scanned for forbidden auto-submit patterns. */
const SAFETY_SCAN_DIRS = ['src', 'scripts'];
const FORBIDDEN = [
  /\bLIVE_SUBMIT\b(?!\sis\s)/, // the removed auto-submit mode
  /autoSubmitCountdown/,
  /confirmBeforeSubmit/,
  /evaluateSubmitGate/,
];
/** Files allowed to MENTION the forbidden tokens (e.g. explanatory comments). */
const SAFETY_ALLOW = new Set([
  join(ROOT, 'src', 'utils', 'credentialManager.js'),
  join(ROOT, 'scripts', 'verifyRepoHealth.js'),
]);

function walkJsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const s = statSync(path);
    if (s.isDirectory()) walkJsFiles(path, out);
    else if (/\.(js|mjs)$/.test(entry)) out.push(path);
  }
  return out;
}

check('required directories exist', () => {
  const missing = REQUIRED_DIRS.filter((d) => !existsSync(join(ROOT, d)));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  return `${REQUIRED_DIRS.length} present`;
});

check('required files exist', () => {
  const missing = REQUIRED_FILES.filter((f) => !existsSync(join(ROOT, f)));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
  return `${REQUIRED_FILES.length} present`;
});

check('configuration loads and validates', () => {
  const config = loadConfig({ root: ROOT, loadEnv: false });
  const mode = config.runtime.mode;
  if (!['DRY_RUN', 'PREPARE', 'LIVE_ASSIST'].includes(mode)) {
    throw new Error(`runtime mode is not one of DRY_RUN/PREPARE/LIVE_ASSIST: ${mode}`);
  }
  return `mode=${mode}`;
});

check('database opens', () => {
  const db = openDatabase();
  try {
    // COUNT(*): listJobs() reads every row, descriptions included, just to count them.
    const n = typeof db.db?.prepare === 'function'
      ? Number(db.db.prepare('SELECT count(*) AS n FROM jobs').get().n)
      : db.listJobs().length;
    return `${n} job(s) in store`;
  } finally {
    db.close();
  }
});

check('no legacy auto-submit surface (safety)', () => {
  const offenders = [];
  for (const d of SAFETY_SCAN_DIRS) {
    for (const file of walkJsFiles(join(ROOT, d))) {
      if (SAFETY_ALLOW.has(file)) continue;
      const text = readFileSync(file, 'utf8');
      for (const re of FORBIDDEN) {
        if (re.test(text)) offenders.push(`${file.replace(ROOT, '.')} (${re})`);
      }
    }
  }
  if (offenders.length) throw new Error(`forbidden auto-submit references: ${offenders.join('; ')}`);
  return 'clean';
});

check('submit path is opt-in gated (safety)', () => {
  // The ONLY automated submit lives in applyRunner.tryAutoSubmit and must be
  // guarded by the explicit per-run flag. If the guard line ever disappears
  // while a submit click remains, this fails loudly.
  const runner = readFileSync(join(ROOT, 'src', 'automation', 'applyRunner.js'), 'utf8');
  if (!/const autoSubmit = options\.autoSubmit === true;/.test(runner)) {
    throw new Error('applyRunner no longer gates submission on options.autoSubmit === true');
  }
  if (!/if \(!autoSubmit\) return false;/.test(runner)) {
    throw new Error('tryAutoSubmit no longer short-circuits when the opt-in flag is absent');
  }
  return 'submission requires options.autoSubmit === true per run';
});

let failed = 0;
for (const c of checks) {
  console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  if (!c.ok) failed += 1;
}

console.log(`\n${failed === 0 ? 'Repository healthy.' : `${failed} check(s) failed.`}`);
process.exit(failed === 0 ? 0 : 1);
