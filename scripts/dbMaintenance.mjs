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
 *
 * Retention
 * ---------
 * `jd_text` is stored inline in the jobs table, and discarded rows keep their
 * full description forever. Measured on the live store: 288 MB of the 443 MB
 * file is jd_text, and 14,871 discarded, never-touched rows older than 30 days
 * account for 71 MB of it. Those descriptions cannot change any decision — the
 * row is already excluded, and re-discovery re-fetches what it needs.
 *
 *   node scripts/dbMaintenance.mjs --prune-descriptions           # DRY RUN, 60d
 *   node scripts/dbMaintenance.mjs --prune-descriptions=30        # DRY RUN, 30d
 *   node scripts/dbMaintenance.mjs --prune-descriptions=30 --apply
 *
 * Nothing is pruned without --apply. A row is only eligible when it is
 * `discarded`, was never applied to, and carries no user decision — so anything
 * you shortlisted, rejected by hand, prepared or submitted keeps its JD.
 */

import { createRequire } from 'node:module';
import { statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Same createRequire pattern as src/logging/db.js: a static `import ... from
// 'node:sqlite'` is resolved eagerly by bundlers and test runners, which do not
// know the builtin and fail the whole module.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

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

/* ── Description retention ──────────────────────────────────────────────── */
const pruneArg = process.argv.find((a) => a.startsWith('--prune-descriptions'));
if (pruneArg) {
  const days = Math.max(1, Number(pruneArg.split('=')[1]) || 60);
  const apply = process.argv.includes('--apply');

  // Deliberately narrow. `discarded` alone is not enough: a row the user later
  // shortlisted or rejected by hand is evidence about their preferences, and a
  // prepared or submitted row must keep the text its packet was built from.
  const WHERE = `
    WHERE status = 'discarded'
      AND COALESCE(applied, 0) = 0
      AND (user_decision IS NULL OR user_decision = '')
      AND application_packet_path IS NULL
      AND jd_text IS NOT NULL
      AND LENGTH(jd_text) > 0
      AND created_at < datetime('now', ?)`;
  const offset = `-${days} days`;

  const { n, bytes } = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(jd_text)), 0) AS bytes FROM jobs ${WHERE}`,
  ).get(offset);

  console.log(`\nretention: ${n} discarded, untouched row(s) older than ${days}d `
    + `hold ${(bytes / 1024 / 1024).toFixed(1)} MB of jd_text`);

  if (!n) {
    console.log('  nothing to prune');
  } else if (!apply) {
    console.log('  DRY RUN — re-run with --apply to clear them (add --vacuum to reclaim the space)');
  } else {
    const t0 = Date.now();
    // summary_only marks the row as "we no longer hold the description", which
    // is exactly what the discovery path already means by it — so re-discovery
    // and `npm run enrich` treat a pruned row the same as a never-fetched one.
    const r = db.prepare(`UPDATE jobs SET jd_text = NULL, summary_only = 1 ${WHERE}`).run(offset);
    console.log(`  cleared ${r.changes} description(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('  run again with --vacuum to actually shrink the file');
  }
}

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
