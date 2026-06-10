/**
 * Job tracker export.
 *
 * Reads every job the system has touched (from the local SQLite store) plus its
 * approval/submit state, and writes a single, neatly organized spreadsheet you
 * can open directly in Excel / Google Sheets:
 *
 *   data/job_tracker.csv
 *
 * Columns: Company, Job Role, Posted On, Applied On, Job URL, Submit Status,
 *          Notes/Comments, and useful extras (Source, Location, Score, Tier,
 *          Sponsorship, ATS, Resume Used, Cover Letter, Job ID).
 *
 * CSV opens natively in Excel with one neat table. Run any time:
 *   npm run tracker
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../src/logging/db.js';
import { writeJobTracker } from '../src/reports/jobTracker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const db = openDatabase();
  try {
    const { path, total, prepared, submitted } = writeJobTracker(db, ROOT);
    console.log(`Job tracker written: ${path}`);
    console.log(`  ${total} jobs total | ${prepared} prepared/awaiting | ${submitted} submitted`);
    console.log('  Open it in Excel: the columns are Company, Job Role, Posted On, Applied On, Job URL, Submit Status, Notes/Comments, ...');
  } finally {
    db.close();
  }
}

main();
