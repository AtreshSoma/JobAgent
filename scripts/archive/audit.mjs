import { openDatabase } from '../src/logging/db.js';

const db = openDatabase({});
const showAllJobs = process.argv.includes('--all');

console.log('=== JOB INTEGRITY SUMMARY ===');
const summary = db.db.prepare(`
  SELECT COUNT(*) AS total,
    SUM(CASE WHEN trim(coalesce(company, '')) = '' THEN 1 ELSE 0 END) AS missingCompany,
    SUM(CASE WHEN trim(coalesce(title, '')) = '' THEN 1 ELSE 0 END) AS missingTitle,
    SUM(CASE WHEN trim(coalesce(url, '')) = '' THEN 1 ELSE 0 END) AS missingUrl,
    SUM(CASE WHEN score IS NOT NULL AND (score < 0 OR score > 100) THEN 1 ELSE 0 END) AS invalidScore,
    SUM(CASE WHEN applied = 1 AND status <> 'submitted' THEN 1 ELSE 0 END) AS appliedWrongStatus,
    SUM(CASE WHEN applied = 1 AND applied_at IS NULL THEN 1 ELSE 0 END) AS appliedWithoutDate,
    SUM(CASE WHEN status = 'submitted' AND coalesce(applied, 0) <> 1 THEN 1 ELSE 0 END) AS submittedNotApplied
  FROM jobs
`).get();
const integrity = Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, Number(value || 0)]));
const byStatus = Object.fromEntries(db.db.prepare(
  "SELECT coalesce(status, 'unknown') AS status, COUNT(*) AS count FROM jobs GROUP BY status ORDER BY count DESC",
).all().map((row) => [row.status, Number(row.count)]));
console.log(JSON.stringify({ integrity, byStatus }, null, 2));

if (showAllJobs) {
  const jobs = db.listJobsSummary();
  console.log('\n=== ALL JOBS (company | tier | status | applied | applied_at | resume used) ===');
  for (const j of jobs) {
    const resume = j.resume_path ? j.resume_path.split(/[\\/]/).pop() : '(none)';
    console.log(`- ${j.company || '(company missing)'} | ${j.tier} | ${j.status} | applied=${j.applied || 0} | ${j.applied_at || '-'} | ${resume}`);
  }
} else {
  console.log('\nJob-level rows are hidden by default. Re-run with --all only when you explicitly need all records.');
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
