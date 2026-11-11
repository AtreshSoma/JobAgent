#!/usr/bin/env node
/**
 * Check open postings against their employers' job systems, and retire the
 * ones that were closed.
 *
 * Why this exists
 * ---------------
 * Measured 2026-09-23: 24 of the 40 best-scored open Workday rows were already
 * closed at the source, and clicking through showed Workday's "The page you are
 * looking for doesn't exist". The dashboard now checks a few hundred postings
 * by itself every few hours; this script is for a one-off full sweep.
 *
 * Usage
 * -----
 *   node scripts/checkPostings.mjs                     # dry run: check 300, write nothing
 *   node scripts/checkPostings.mjs --apply             # record results, retire closed rows
 *   node scripts/checkPostings.mjs --apply --limit=5000 --max-age-hours=0
 *   node scripts/checkPostings.mjs --db=/path/to/applied_jobs.db
 *
 * Only rows nobody acted on are retired (discarded, reason "expired: the
 * employer closed this posting"); applied, prepared and shortlisted jobs just
 * carry the flag. Requests are polite: two in flight per API host, spaced.
 */
import { join } from 'node:path';

import { openDatabase } from '../src/logging/db.js';
import { PROJECT_ROOT } from '../src/config/loadConfig.js';
import { sweepPostings } from '../src/search/postingLiveness.js';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

export async function main() {
  const apply = arg('apply', false) === true;
  const limit = Number(arg('limit', 300)) || 300;
  const maxAgeHours = Number(arg('max-age-hours', 24));
  const dbPath = arg('db', join(PROJECT_ROOT, 'data', 'applied_jobs.db'));
  const db = openDatabase({ path: dbPath });
  const controller = new AbortController();
  process.once('SIGINT', () => { console.log('\n  stopping — results so far are kept'); controller.abort(); });
  let last = 0;
  try {
    console.log(`\n  Checking up to ${limit} open posting(s) with their ATS${apply ? '' : ' (DRY RUN — nothing written)'}…`);
    const out = await sweepPostings({
      db, limit, maxAgeHours: Number.isFinite(maxAgeHours) ? maxAgeHours : 24, apply, signal: controller.signal,
      onProgress: (p) => {
        if (p.checked - last >= 50) { last = p.checked; console.log(`  … ${p.checked} checked, ${p.closed} closed`); }
      },
    });
    console.log(`\n  checked ${out.checked} · open ${out.open} · closed ${out.closed} · unknown ${out.unknown}`);
    for (const [source, s] of Object.entries(out.bySource)) {
      console.log(`    ${source.padEnd(18)} open ${String(s.open).padStart(5)}  closed ${String(s.closed).padStart(5)}  unknown ${String(s.unknown).padStart(5)}`);
    }
    if (out.closedExamples.length) {
      console.log('\n  Closed, for example:');
      for (const e of out.closedExamples) console.log(`    - ${e.company ?? '?'} — ${e.title ?? '?'} (${e.via})`);
    }
    console.log(apply
      ? `\n  Retired ${out.retired} closed posting(s) from the board.\n`
      : `\n  DRY RUN — re-run with --apply to retire ${out.closed} closed posting(s).\n`);
    return out;
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
