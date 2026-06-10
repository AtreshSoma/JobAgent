/**
 * Clean up generated outputs (reset the workspace to a pristine state).
 *
 * Removes ONLY machine-generated artifacts so you can start a fresh run. It
 * never touches anything you authored or that is the source of truth:
 *   - KEEPS: config/, resumes/base/ (your master resume), src/, tests/,
 *            scripts/, and the SQLite database (data/applied_jobs.db).
 *   - REMOVES: tailored resumes + cover letters (resumes/output/*),
 *              application packets (applications/output/*), pipeline JSON
 *              snapshots (data/found_jobs.json, scored_jobs.json,
 *              queued_jobs.json, unknown_date_review.json, job_tracker.csv),
 *              reports/*, and logs/*.
 *
 * Safe by default:
 *   - DRY-RUN by default — lists what WOULD be removed and deletes nothing.
 *   - Pass `--apply` to actually delete.
 *   - `.gitkeep` files are preserved so tracked folders survive.
 *
 * Usage:
 *   node scripts/cleanupGeneratedOutputs.js           # preview
 *   node scripts/cleanupGeneratedOutputs.js --apply    # delete generated files
 */

import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

/** Folders whose CONTENTS are generated (the folder itself is kept). */
const CLEAN_DIRS = [
  join(ROOT, 'resumes', 'output'),
  join(ROOT, 'applications', 'output'),
  join(ROOT, 'reports'),
  join(ROOT, 'logs'),
];

/** Individual generated files to remove. */
const CLEAN_FILES = [
  join(ROOT, 'data', 'found_jobs.json'),
  join(ROOT, 'data', 'scored_jobs.json'),
  join(ROOT, 'data', 'queued_jobs.json'),
  join(ROOT, 'data', 'unknown_date_review.json'),
  join(ROOT, 'data', 'job_tracker.csv'),
];

/** Files that must never be deleted even inside a cleaned folder. */
const PRESERVE = new Set(['.gitkeep', '.gitignore']);

function removePath(path) {
  console.log(`  ${APPLY ? 'remove' : 'would remove'}: ${path.replace(ROOT, '.')}`);
  if (APPLY) rmSync(path, { recursive: true, force: true });
}

function main() {
  console.log(APPLY
    ? 'Cleaning generated outputs (your config, master resume, and database are kept)…'
    : '[dry-run] The following generated outputs WOULD be removed:');

  let count = 0;

  for (const dir of CLEAN_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (PRESERVE.has(entry)) continue;
      const path = join(dir, entry);
      removePath(path);
      count += 1;
    }
  }

  for (const file of CLEAN_FILES) {
    if (existsSync(file) && statSync(file).isFile() && !PRESERVE.has(basename(file))) {
      removePath(file);
      count += 1;
    }
  }

  if (count === 0) {
    console.log('  (nothing to clean — already pristine)');
    return;
  }

  console.log(`${APPLY ? 'Done' : 'Preview complete'}: ${count} item(s).`);
  if (!APPLY) console.log('Re-run with --apply to delete them.');
}

main();
