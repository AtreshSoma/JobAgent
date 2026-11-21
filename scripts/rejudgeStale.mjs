#!/usr/bin/env node
/**
 * Re-admit postings the old discovery window discarded as `stale` (audit D1).
 * See src/pipeline/rejudgeStale.js for what is selected and why.
 *
 *   npm run rejudge-stale              # report only
 *   npm run rejudge-stale -- --apply   # write the change
 *
 * Re-admitted rows become `needs_description`; the next discovery run or
 * `npm run enrich` reads their descriptions and the normal judge scores them.
 */
import { loadConfig } from '../src/config/loadConfig.js';
import { openDatabase } from '../src/logging/db.js';
import { rejudgeStale } from '../src/pipeline/rejudgeStale.js';

const apply = process.argv.includes('--apply');
const config = loadConfig({ loadEnv: true, env: process.env });
const db = openDatabase({});
try {
  const out = rejudgeStale({ db, config, apply });
  console.log(`stale rows inside retention considered: ${out.considered}`);
  console.log(`  title does not fit the profile (left as is): ${out.notFit}`);
  console.log(`  failed a hard exclusion on title/location (relabelled with the true reason): ${out.relabelled}`);
  for (const [kind, n] of Object.entries(out.reasons)) console.log(`      ${kind}: ${n}`);
  console.log(`  ${apply ? 're-admitted' : 'would be re-admitted'} for judging: ${out.readmitted}`);
  if (out.sample.length) {
    console.log('\nExamples:');
    for (const r of out.sample) console.log(`  ${String(r.posted_at).slice(0, 10)}  ${r.company} — ${r.title}`);
  }
  if (!apply && (out.readmitted || out.relabelled)) console.log('\nRe-run with --apply to write these changes.');
} finally {
  db.close();
}
