import { openDatabase } from '../src/logging/db.js';

const db = openDatabase({});
const jobs = db.listJobs({});

console.log('=== JOBS (company | tier | status | applied | applied_at | resume used) ===');
for (const j of jobs) {
  const resume = j.resume_path ? j.resume_path.split(/[\\/]/).pop() : '(none)';
  console.log(`- ${j.company} | ${j.tier} | ${j.status} | applied=${j.applied || 0} | ${j.applied_at || '-'} | ${resume}`);
}

console.log('\n=== run_log (most recent 6) ===');
console.log('mode | found | scored | prepared | assisted | submitted');
const runs = db.db.prepare(
  'SELECT mode, jobs_found, jobs_scored, jobs_prepared, jobs_assisted, jobs_submitted FROM run_log ORDER BY started_at DESC LIMIT 6',
).all();
for (const r of runs) {
  console.log(`- ${r.mode} | ${r.jobs_found} | ${r.jobs_scored} | ${r.jobs_prepared} | ${r.jobs_assisted ?? 0} | ${r.jobs_submitted ?? 0}`);
}

console.log('\n=== application_events (most recent 12) ===');
const events = db.db.prepare(
  'SELECT created_at, event_type, job_id FROM application_events ORDER BY created_at DESC LIMIT 12',
).all();
for (const e of events) {
  console.log(`- ${e.created_at} | ${e.event_type} | ${e.job_id ?? '-'}`);
}

db.close();
