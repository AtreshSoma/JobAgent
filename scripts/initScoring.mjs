#!/usr/bin/env node
/**
 * Point the scoring engine at YOUR field.
 *
 * Why this exists
 * ---------------
 * The shipped keyword categories were six hardcoded JavaScript identifiers
 * written for one data-engineering profile, and they own 64 of the 110
 * available points. Measured against perfectly-matching postings, with a
 * discard floor of 50:
 *
 *   data engineer  78   (the profile it was written for)
 *   nurse          21   frontend engineer  26
 *   accountant     27   marketing manager  27
 *
 * Every one of those was a flawless match for the role in question. Discovery
 * found them correctly; scoring then threw them away, because the points that
 * decide a score could only be earned by naming Azure, Databricks and Power BI.
 *
 * `scoring.categories` fixed the structure. This writes a category set that
 * reads YOUR profile, so the vocabulary follows your resume instead of someone
 * else's stack:
 *
 *   titleFit    <- candidate.targetTitles
 *   coreSkills  <- candidate.technicalStack
 *
 * The same five personas score 72-84 against that set, while every mismatched
 * pairing stays at 14-21 — so it is not "score everything highly", it is the
 * same discrimination applied to whoever is actually using the tool.
 *
 * Usage
 * -----
 *   npm run scoring:init              # show what would change (dry run)
 *   npm run scoring:init -- --apply   # write it, keeping a .bak
 *   npm run scoring:init -- --apply --from-resume
 *                                     # also fill an empty technicalStack from
 *                                     # the master resume's skills section
 *
 * Nothing is written without --apply, and the previous scoring.json and
 * candidate.json are copied aside first.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractDocxText } from '../src/resume/docxText.js';
import { extractResumeEvidence } from '../src/resume/resumeProfile.js';
import { PROFILE_CATEGORY_SPEC } from '../src/profile/derive.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCORING = join(ROOT, 'config', 'scoring.json');
const CANDIDATE = join(ROOT, 'config', 'candidate.json');
const RESUME = join(ROOT, 'resumes', 'base', 'MASTER_RESUME.docx');

/**
 * The profile-driven category set.
 *
 * Defined in src/profile/derive.js, which is where activating a search profile
 * writes it from. Re-exported here so this script and profile activation can
 * never drift into producing two different scoring configs.
 */
export const PROFILE_DRIVEN_CATEGORIES = PROFILE_CATEGORY_SPEC;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const fromResume = args.includes('--from-resume');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const backup = (p) => { const b = `${p}.bak`; copyFileSync(p, b); return b; };

function main() {
  if (!existsSync(SCORING) || !existsSync(CANDIDATE)) {
    console.error('config/scoring.json and config/candidate.json must both exist. Run `npm run setup` first.');
    return 1;
  }
  const scoring = readJson(SCORING);
  const candidate = readJson(CANDIDATE);

  const titles = candidate.targetTitles ?? [];
  const stack = Object.values(candidate.technicalStack ?? {}).flat().filter(Boolean);

  console.log('Current profile');
  console.log(`  target titles : ${titles.length}${titles.length ? ` — ${titles.slice(0, 4).join(', ')}${titles.length > 4 ? '…' : ''}` : ''}`);
  console.log(`  skill terms   : ${stack.length}${stack.length ? ` — ${stack.slice(0, 5).join(', ')}${stack.length > 5 ? '…' : ''}` : ''}`);
  console.log(`  scoring shape : ${Array.isArray(scoring.categories) && scoring.categories.length
    ? `declarative (${scoring.categories.length} categories)` : 'legacy hardcoded categories'}`);

  // Filling the stack matters more than the categories: with `coreSkills`
  // reading an empty technicalStack, every job scores zero there and the switch
  // makes matching WORSE, not better.
  let stackAdded = [];
  if (fromResume) {
    if (!existsSync(RESUME)) {
      console.error('\n--from-resume needs resumes/base/MASTER_RESUME.docx, which is not there.');
      return 1;
    }
    const evidence = extractResumeEvidence(extractDocxText(readFileSync(RESUME)).paragraphs);
    const have = new Set(stack.map((t) => String(t).toLowerCase()));
    stackAdded = evidence.skills.filter((sk) => !have.has(sk.toLowerCase()));
    console.log(`\nFrom your master resume: ${evidence.skills.length} skill term(s), ${stackAdded.length} not yet in your profile.`);
    if (stackAdded.length) console.log(`  ${stackAdded.slice(0, 12).join(', ')}${stackAdded.length > 12 ? ` … +${stackAdded.length - 12} more` : ''}`);
  }

  const projectedStack = stack.length + stackAdded.length;
  console.log('\nWould write scoring.categories:');
  for (const c of PROFILE_DRIVEN_CATEGORIES) {
    const src = c.from === 'targetTitles' ? `${titles.length} target title(s)`
      : c.from === 'technicalStack' ? `${projectedStack} skill term(s)`
        : `scoring.keywords.${c.keywordSet}`;
    console.log(`  ${String(c.weight).padStart(3)} pts  ${c.id.padEnd(11)} <- ${src}`);
  }

  const problems = [];
  if (!titles.length) problems.push('candidate.targetTitles is empty — titleFit would score 0 on every job.');
  if (projectedStack < 5) {
    problems.push(`only ${projectedStack} skill term(s) in candidate.technicalStack — coreSkills is 30 points and would score near 0. `
      + 'Add your real skills first, or re-run with --from-resume.');
  }
  if (problems.length) {
    console.log('\nBEFORE APPLYING:');
    for (const p of problems) console.log(`  ! ${p}`);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply (add --from-resume to fill the stack too).');
    return 0;
  }
  if (problems.length) {
    console.error('\nRefusing to apply: this would score every job WORSE than the current setup. Fix the above first.');
    return 1;
  }

  if (stackAdded.length) {
    const b = backup(CANDIDATE);
    candidate.technicalStack = {
      ...(candidate.technicalStack ?? {}),
      other: [...(candidate.technicalStack?.other ?? []), ...stackAdded],
    };
    delete candidate._note;
    writeJson(CANDIDATE, candidate);
    console.log(`\nwrote config/candidate.json (+${stackAdded.length} skill terms, backup ${b})`);
  }

  const b = backup(SCORING);
  scoring._categoriesNote = 'Scoring categories are declarative and read your profile: titleFit follows '
    + 'candidate.targetTitles and coreSkills follows candidate.technicalStack, so editing your profile '
    + 'changes what is scored. To restore the previous hardcoded data-engineering categories, delete '
    + 'this "categories" array — the scorer falls back to the legacy weights/keywords shape unchanged.';
  scoring.categories = PROFILE_DRIVEN_CATEGORIES;
  writeJson(SCORING, scoring);
  console.log(`wrote config/scoring.json (backup ${b})`);
  console.log('\nRun `npm run score` to re-score the existing board against the new categories.');
  return 0;
}

// Only run when invoked directly. Without this the whole generator executed on
// import — including process.exit — which made PROFILE_DRIVEN_CATEGORIES
// impossible to reuse from a test or another script.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
