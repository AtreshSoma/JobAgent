#!/usr/bin/env node
/**
 * One-off, idempotent relabel: "stale: unknown posting date" -> "unknown posting date".
 *
 * The freshness gate used to prefix EVERY drop reason with "stale:", which
 * claimed a posting was expired when in fact its date was simply unreadable.
 * Those are different problems with different follow-up, and the wrong label
 * hid thousands of never-reviewed jobs behind an "it's old" explanation.
 *
 * The pipeline no longer writes the bad label. This fixes rows already stored.
 * Only the reason TEXT changes — no status, score, or decision is touched.
 *
 *   node scripts/relabelUndatedJobs.mjs           # report only
 *   node scripts/relabelUndatedJobs.mjs --apply   # write the fix
 */
import { openDatabase } from '../src/logging/db.js';

const apply = process.argv.includes('--apply');
const db = openDatabase({});

const BAD = 'stale: unknown posting date';
const GOOD = 'unknown posting date';

const { c: affected } = db.db
  .prepare('SELECT COUNT(*) AS c FROM jobs WHERE discard_reason = ?')
  .get(BAD) ?? { c: 0 };

console.log(`rows labelled "${BAD}": ${affected}`);

if (affected === 0) {
  console.log('Nothing to relabel — database is already correct.');
  db.close();
  process.exit(0);
}

if (!apply) {
  const sample = db.db
    .prepare('SELECT company, title FROM jobs WHERE discard_reason = ? LIMIT 5')
    .all(BAD);
  console.log('\nSample of what would be relabelled:');
  for (const row of sample) console.log(`  ${row.company} — ${row.title}`);
  console.log(`\nRe-run with --apply to relabel these ${affected} row(s) as "${GOOD}".`);
  db.close();
  process.exit(0);
}

const result = db.transaction(() => db.db
  .prepare('UPDATE jobs SET discard_reason = ?, updated_at = ? WHERE discard_reason = ?')
  .run(GOOD, new Date().toISOString(), BAD));

console.log(`\nRelabelled ${result.changes} row(s) to "${GOOD}".`);
console.log('These jobs are now findable via the dashboard\'s "Undated" filter.');
db.close();
