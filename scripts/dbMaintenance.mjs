/**
 * SQLite maintenance for data/applied_jobs.db.
 *
 * The dashboard checkpoints the WAL on every open, but a long-running reader
 * can still let it grow, and deleted rows leave free pages in the main file.
 * Run this occasionally (with the dashboard/watch STOPPED) to compact:
 *
 *   node scripts/dbMaintenance.mjs           # checkpoint + stats (safe, fast)
 *   node scripts/dbMaintenance.mjs --vacuum  # + full VACUUM (rewrites the file;
 *                                            #   can take a while on a large DB)
 */

import { DatabaseSync } from 'node:sqlite';
import { statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = join(root, 'data', 'applied_jobs.db');

if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath} — nothing to do`);
  process.exit(1);
}

const mb = (p) => {
  try { return (statSync(p).size / 1024 / 1024).toFixed(1) + ' MB'; }
  catch { return '—'; }
};

console.log(`db:  ${dbPath} (${mb(dbPath)})`);
console.log(`wal: ${mb(dbPath + '-wal')}`);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000;');

console.log('checkpointing WAL…');
db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
console.log(`wal after checkpoint: ${mb(dbPath + '-wal')}`);

if (process.argv.includes('--vacuum')) {
  console.log('vacuuming (this rewrites the whole file — do not interrupt)…');
  const t0 = Date.now();
  db.exec('VACUUM;');
  console.log(`vacuum done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const jobs = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
const events = db.prepare('SELECT COUNT(*) AS n FROM application_events').get().n;
console.log(`rows: ${jobs} jobs, ${events} events`);
db.close();
console.log(`db after: ${mb(dbPath)}`);
