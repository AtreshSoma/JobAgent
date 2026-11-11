#!/usr/bin/env node
/**
 * Fetch the descriptions of jobs that were stored but never actually read, then
 * re-score them for real.
 *
 * Discovery stores many postings with only a list-page teaser (Workday and
 * SmartRecruiters list endpoints carry no description). With no description
 * the reachable score is ~44/100 against a 50 floor, so such rows are held as
 * `needs_description` rather than judged. This reads them.
 *
 * The logic lives in src/search/enrich.js, which the dashboard also runs
 * (More actions → Discovery & data quality). This is the command-line entry.
 *
 * Usage
 * -----
 *   node scripts/enrichDescriptions.mjs                 # dry run: report only
 *   node scripts/enrichDescriptions.mjs --apply         # write descriptions + rescore
 *   node scripts/enrichDescriptions.mjs --limit=500     # cap work this pass
 *   node scripts/enrichDescriptions.mjs --source=workday
 *
 * Politeness matches discovery: a per-host concurrency ceiling and spacing,
 * the same identifying User-Agent, bounded retries for 429/5xx only, and a
 * per-source budget. Nothing is written without --apply. Rows you shortlisted,
 * prepared or applied to are never touched.
 */

import { pathToFileURL } from 'node:url';

import { loadConfig } from '../src/config/loadConfig.js';
import { openDatabase } from '../src/logging/db.js';
import {
  runEnrichment, enrichmentBacklog, enrichmentSettings,
} from '../src/search/enrich.js';

// Kept for callers and tests that import the helpers from here.
export { workdayDetailApi, isExpiredRow, judgeEnriched } from '../src/search/enrich.js';

function parseArgs(argv) {
  const args = { apply: false, limit: 250, source: null };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--limit=')) args.limit = Math.max(1, Math.min(1000, Number(a.split('=')[1]) || 250));
    else if (a.startsWith('--source=')) args.source = a.split('=')[1];
    else if (a.startsWith('--min-score=')) {
      console.warn('  --min-score is no longer used: only active rows with a title your profile does not reject are read.');
    } else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`
Fetch descriptions for stored jobs that were never read, then re-score them.

  --apply          Write descriptions and re-score (default: dry run)
  --limit=N        Maximum jobs to read this pass (default 250, max 1000)
  --source=NAME    Only this source (workday, smartrecruiters, oracleRecruiting, icims)
  -h, --help       Show this help
`);
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig({ loadEnv: true, env: process.env });
  const db = openDatabase({});
  const overrides = { maxPerPass: args.limit, perSourceBudget: Math.max(args.limit, enrichmentSettings(config).perSourceBudget) };

  console.log('Enriching jobs that were stored but never read\n');
  const backlog = enrichmentBacklog(db, config, { settings: enrichmentSettings(config, overrides) });
  console.log(`  ${backlog.unread.toLocaleString()} active job(s) are waiting for a description`);
  for (const [s, n] of Object.entries(backlog.bySource).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(20)} ${n}`);
  }
  if (backlog.unsupported) console.log(`  ${backlog.unsupported} sit on sources whose descriptions cannot be fetched`);
  if (backlog.coolingDown || backlog.gaveUp) {
    console.log(`  ${backlog.coolingDown} failed recently (retried later), ${backlog.gaveUp} given up on`);
  }
  if (!args.apply) console.log('\n  DRY RUN — nothing will be written. Re-run with --apply.\n');

  const stats = await runEnrichment({
    db, config, overrides, source: args.source, apply: args.apply,
    onProgress: (p) => { if (p.done && p.done % 25 === 0) console.log(`  … ${p.done}/${p.total}`); },
  });

  console.log('\n================ RESULT ================');
  console.log(`  read this pass       : ${stats.total}`);
  console.log(`  descriptions fetched : ${stats.fetched}`);
  console.log(`  fetch failed         : ${stats.failed} (${stats.gone} posting(s) gone)`);
  console.log(`  NOW ACTIONABLE       : ${stats.nowActionable}`);
  console.log(`  read and weak        : ${stats.stillWeak}`);
  console.log(`  excluded once read   : ${stats.excluded}`);
  for (const p of stats.recovered.slice(0, 25)) {
    console.log(`  ${String(p.score).padStart(3)} ${String(p.tier).padEnd(10)} ${(p.company ?? '').slice(0, 24).padEnd(25)} ${(p.title ?? '').slice(0, 46)}`);
  }
  console.log(args.apply ? '\n  Written. Run again to continue with the rest.' : '\n  DRY RUN — nothing written.');
  db.close();
}

// Run only when executed directly, so tests can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`enrichDescriptions failed: ${err.stack ?? err.message}`);
    process.exitCode = 1;
  });
}
