/**
 * One-off backfill: strip literal HTML markup from jobs.jd_text.
 *
 * Greenhouse's board API returns HTML-ESCAPED content; before the adapter fix
 * (unescapeHtmlPayload) every Greenhouse job stored its description with raw
 * "<p>", "<li>", … tags in the text. This cleans the stored rows in place using
 * the same htmlToText used at ingest, so packets/board/keyword views read clean
 * text without waiting for those jobs to be re-discovered.
 *
 * Safe to re-run (idempotent): rows without markup are left untouched.
 *
 *   node scripts/cleanJobDescriptions.mjs           # dry-run (report only)
 *   node scripts/cleanJobDescriptions.mjs --apply   # write changes
 */
import { openDatabase } from '../src/logging/db.js';
import { htmlToText } from '../src/search/normalize.js';

const apply = process.argv.includes('--apply');
const db = openDatabase({});

const rows = db.db.prepare(
  "SELECT id, jd_text FROM jobs WHERE jd_text LIKE '%<p>%' OR jd_text LIKE '%</li>%' OR jd_text LIKE '%<div%' OR jd_text LIKE '%<br%'",
).all();

console.log(`${rows.length} job(s) carry literal HTML markup in jd_text`);
let changed = 0;
if (apply) {
  const upd = db.db.prepare('UPDATE jobs SET jd_text = ?, updated_at = updated_at WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      const clean = htmlToText(r.jd_text ?? '');
      if (clean !== r.jd_text) { upd.run(clean, r.id); changed += 1; }
    }
  });
  console.log(`cleaned ${changed} row(s)`);
} else {
  const sample = rows[0];
  if (sample) {
    console.log('\nsample before:', String(sample.jd_text).slice(0, 160).replace(/\n/g, ' '));
    console.log('sample after :', htmlToText(sample.jd_text).slice(0, 160).replace(/\n/g, ' '));
  }
  console.log('\ndry-run only — re-run with --apply to write.');
}
db.close();
