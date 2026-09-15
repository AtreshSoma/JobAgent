#!/usr/bin/env node
/**
 * Materialize the local-only files a checkout cannot carry.
 *
 * Why this exists
 * ---------------
 * `config/candidate.json`, `config/screening_answers.json` and the master resume
 * are gitignored on purpose — they hold a real person's name, contact details,
 * work authorization, salary expectations and EEO answers. But ~24 test files
 * call `loadConfig()` at module scope, so on a fresh clone every one of them
 * failed to LOAD with `Config file not found: config/candidate.json`. 27 of 96
 * files never collected and 353 tests never ran, which is why CI on `main` was
 * red for as long as the pattern existed while the author's laptop stayed green.
 *
 * This copies each shipped `.example` into place when — and only when — the real
 * file is absent. An existing local config is never touched, so running it on a
 * machine that already has real answers is a no-op.
 *
 * The materialized files are deliberately still PLACEHOLDERS. They let the code
 * load and the suite run; they do not let the pipeline apply to anything. The
 * sentinel guard in `src/config/placeholders.js` fails preflight on exactly
 * these values, so a fresh clone can run its tests but cannot submit template
 * text to an employer.
 *
 * Usage
 * -----
 *   npm run setup            # fill in anything missing, report what it did
 *   node scripts/setupLocalConfig.mjs --check    # report only, exit 1 if missing
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Local file -> the tracked example it is seeded from.
 * Paths are repo-relative and POSIX-style for readability; joined per-platform.
 */
export const SEEDED_FILES = [
  { target: ['config', 'candidate.json'], example: ['config', 'candidate.example.json'] },
  { target: ['config', 'screening_answers.json'], example: ['config', 'screening_answers.example.json'] },
  {
    target: ['resumes', 'base', 'MASTER_RESUME.docx'],
    example: ['resumes', 'base', 'MASTER_RESUME.example.docx'],
  },
];

/**
 * Copy every missing local file from its example.
 *
 * @param {object} [options]
 * @param {string} [options.root=ROOT] repo root to operate on
 * @param {boolean} [options.check=false] report only; never write
 * @returns {{ created: string[], present: string[], missingExample: string[] }}
 */
export function materializeLocalFiles({ root = ROOT, check = false } = {}) {
  const created = [];
  const present = [];
  const missingExample = [];

  for (const { target, example } of SEEDED_FILES) {
    const targetPath = join(root, ...target);
    const examplePath = join(root, ...example);
    const label = target.join('/');

    if (existsSync(targetPath)) {
      present.push(label);
      continue;
    }
    if (!existsSync(examplePath)) {
      missingExample.push(example.join('/'));
      continue;
    }
    if (!check) {
      mkdirSync(dirname(targetPath), { recursive: true });
      copyFileSync(examplePath, targetPath);
    }
    created.push(label);
  }

  return { created, present, missingExample };
}

// Run directly (not when imported by vitest's globalSetup).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const { created, present, missingExample } = materializeLocalFiles({ check });

  for (const f of present) console.log(`  ok       ${f} (already present — left untouched)`);
  for (const f of created) console.log(`  ${check ? 'MISSING ' : 'created '} ${f}${check ? '' : ' (from its .example)'}`);
  for (const f of missingExample) console.error(`  ERROR    ${f} is missing from the repository`);

  if (missingExample.length) process.exit(2);
  if (check && created.length) {
    console.error('\nRun `npm run setup` to create them.');
    process.exit(1);
  }
  if (created.length) {
    console.log('\nThese are PLACEHOLDERS, not your details. Edit them before running the'
      + '\npipeline — `npm run doctor` will refuse to proceed while template values remain.');
  }
}
