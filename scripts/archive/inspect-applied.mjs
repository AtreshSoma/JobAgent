import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const path = './data/applied_jobs.db';
if (!existsSync(path)) {
  console.log('No applied_jobs.db yet — nothing has been run against the real DB.');
  process.exit(0);
}
const db = new DatabaseSync(path);
const applied = db.prepare(
  "SELECT id, company, title, status, applied, applied_at FROM jobs WHERE applied = 1 OR status = 'submitted' ORDER BY applied_at DESC",
).all();
console.log('APPLIED / SUBMITTED JOBS:', JSON.stringify(applied, null, 2));

const appr = db.prepare('SELECT job_id, approval_status, approved_at FROM approval_queue ORDER BY created_at DESC').all();
console.log('\nAPPROVAL QUEUE:', JSON.stringify(appr, null, 2));

const ev = db.prepare(
  "SELECT job_id, event_type, message, created_at FROM application_events WHERE event_type IN ('application_submitted','duplicate_skipped') ORDER BY created_at DESC LIMIT 20",
).all();
console.log('\nSUBMIT / DEDUP EVENTS:', JSON.stringify(ev, null, 2));

const counts = db.prepare('SELECT status, COUNT(*) AS c FROM jobs GROUP BY status').all();
console.log('\nJOB STATUS COUNTS:', JSON.stringify(counts, null, 2));
db.close();
