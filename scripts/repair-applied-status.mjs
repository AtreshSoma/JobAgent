/**
 * Repair: any job that is applied=1 but whose status was clobbered away from
 * 'submitted' by a later re-fill is corrected back to 'submitted'.
 *
 * Safe by default, matching the other maintenance scripts:
 *   node scripts/repair-applied-status.mjs           # dry-run (report only)
 *   node scripts/repair-applied-status.mjs --apply   # write the repair
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const APPLY = process.argv.includes('--apply');

const db = new DatabaseSync('./data/applied_jobs.db');
const before = db.prepare(
  "SELECT id, status FROM jobs WHERE applied = 1 AND status != 'submitted'",
).all();
console.log(`${APPLY ? 'Repairing' : '[dry-run] Would repair'} ${before.length} row(s):`, JSON.stringify(before, null, 2));

if (APPLY) {
  db.prepare("UPDATE jobs SET status = 'submitted' WHERE applied = 1 AND status != 'submitted'").run();
  const after = db.prepare("SELECT id, status, applied, applied_at FROM jobs WHERE applied = 1").all();
  console.log('\nApplied rows now:', JSON.stringify(after, null, 2));
} else if (before.length) {
  console.log('\nRe-run with --apply to write the repair.');
}
db.close();
