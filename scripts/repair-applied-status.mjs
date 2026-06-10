import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('./data/applied_jobs.db');
// Repair: any job that is applied=1 but whose status was clobbered away from
// 'submitted' by a later re-fill is corrected back to 'submitted'.
const before = db.prepare(
  "SELECT id, status FROM jobs WHERE applied = 1 AND status != 'submitted'",
).all();
console.log('Repairing rows:', JSON.stringify(before, null, 2));
db.prepare("UPDATE jobs SET status = 'submitted' WHERE applied = 1 AND status != 'submitted'").run();
const after = db.prepare("SELECT id, status, applied, applied_at FROM jobs WHERE applied = 1").all();
console.log('\nApplied rows now:', JSON.stringify(after, null, 2));
db.close();
