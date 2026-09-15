import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync('./data/applied_jobs.db');
const rows = db.prepare(
  "SELECT id, company, title, status, resume_path, cover_letter_path FROM jobs WHERE title LIKE '%Senior Manager, Data Engineering%' ORDER BY score DESC",
).all();
console.log('MATCHING JOB ROWS:', JSON.stringify(rows, null, 2));

const appr = db.prepare(
  "SELECT job_id, approval_status, packet_path FROM approval_queue WHERE job_id LIKE '%senior manager data engineering%' OR job_id LIKE '%senior_manager%'",
).all();
console.log('\nAPPROVAL ROWS:', JSON.stringify(appr, null, 2));
db.close();
