#!/usr/bin/env node
/**
 * Move tailored resumes that were written into a mis-encoded directory back
 * beside the rest of their application packet.
 *
 * WHY THIS EXISTS
 * ---------------
 * Node and Python exchanged JSON over a pipe that was UTF-8 on one end and the
 * Windows ANSI code page on the other (fixed in src/resume/pythonEnv.js). Every
 * non-ASCII byte in a path was corrupted in transit, so for an employer like
 * "84.51°" or "Sovos Latinoamérica" the tailor CREATED a directory named
 * "84.51Â°" and wrote the resume there, while the packet JSON and cover letter
 * — written by Node, which had the name right — landed in "84.51°".
 *
 * One job, two directories, neither complete. Nothing was lost, but the packet
 * folder the dashboard opens does not contain the resume, and the pair will
 * stay split until the files are moved.
 *
 * HOW A ROW IS IDENTIFIED
 * -----------------------
 * Not by guessing which strings "look like" mojibake — an en dash in a job
 * title survives a cp1252 round trip and would be flagged by that test, which
 * is how a first pass at this reported six false positives. Instead each row is
 * confirmed against a fact the database already holds:
 *
 *     dirname(resume_docx_path) != output_folder_path
 *     AND cp1252->utf8(dirname(resume_docx_path)) == output_folder_path
 *
 * The second line only holds if the directory really is the mis-decoded form of
 * the folder this job's packet is in. That is proof, not a heuristic, and it
 * tells us exactly where the file belongs.
 *
 * Usage
 * -----
 *   node scripts/repairMojibakePaths.mjs            # dry run: report only
 *   node scripts/repairMojibakePaths.mjs --apply    # move files + update rows
 */

import { existsSync, mkdirSync, renameSync, statSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { loadConfig } from '../src/config/loadConfig.js';
import { openDatabase } from '../src/logging/db.js';

const APPLY = process.argv.includes('--apply');

/** Columns holding a file this repair can move. */
const FILE_COLUMNS = ['resume_docx_path', 'resume_pdf_path', 'resume_path'];

/**
 * Re-decode a string that was written as UTF-8 and read back as cp1252.
 * Returns null when the string is not a valid mis-decode — which is the common
 * case, and the reason this is a check rather than a transformation.
 */
function undoMojibake(text) {
  if (!text || !/[-ÿ]/.test(text)) return null;
  const bytes = Buffer.from(text, 'latin1');
  const decoded = new TextDecoder('utf-8', { fatal: true });
  try {
    const fixed = decoded.decode(bytes);
    return fixed === text ? null : fixed;
  } catch {
    return null; // not valid UTF-8 underneath: a genuine Latin-1 character
  }
}

const config = await loadConfig();
const db = openDatabase({ path: join(config.root, 'data', 'applied_jobs.db') });

const rows = db.db.prepare(`
  SELECT id, output_folder_path, ${FILE_COLUMNS.join(', ')}
  FROM jobs
  WHERE output_folder_path IS NOT NULL AND trim(output_folder_path) <> ''
`).all();

const planned = [];
for (const row of rows) {
  const home = row.output_folder_path;
  for (const column of FILE_COLUMNS) {
    const current = row[column];
    if (!current) continue;
    const folder = dirname(current);
    if (folder === home) continue;                 // already in the right place
    if (undoMojibake(folder) !== home) continue;   // not this bug — leave alone
    planned.push({ id: row.id, column, from: current, to: join(home, basename(current)) });
  }
}

if (planned.length === 0) {
  console.log('No mis-encoded resume paths found — nothing to repair.');
  db.close();
  process.exit(0);
}

console.log(`${planned.length} file(s) sit outside their packet folder because of the encoding bug:\n`);
const touchedDirs = new Set();
let moved = 0; let relinked = 0; let skipped = 0;

for (const item of planned) {
  const onDisk = existsSync(item.from);
  const already = existsSync(item.to);
  const label = `${item.id.slice(0, 46)}  [${item.column}]`;

  if (!onDisk && !already) {
    console.log(`  SKIP    ${label}\n          neither the stored path nor the target exists on disk`);
    skipped += 1;
    continue;
  }
  // The file is already where it belongs and the row simply points at the old
  // location: re-point the row, touch nothing on disk.
  if (already && !onDisk) {
    console.log(`  RELINK  ${label}\n          file already in the packet folder; row still points at the old path`);
    if (APPLY) db.upsertJob({ id: item.id, [item.column]: item.to });
    relinked += 1;
    continue;
  }
  if (already && onDisk) {
    const a = statSync(item.from); const b = statSync(item.to);
    if (a.size !== b.size) {
      console.log(`  SKIP    ${label}\n          BOTH exist and differ in size (${a.size} vs ${b.size}) — resolve by hand, nothing removed`);
      skipped += 1;
      continue;
    }
    console.log(`  RELINK  ${label}\n          identical copy already in the packet folder`);
    if (APPLY) db.upsertJob({ id: item.id, [item.column]: item.to });
    relinked += 1;
    touchedDirs.add(dirname(item.from));
    continue;
  }

  console.log(`  MOVE    ${label}\n          ${dirname(item.from)}\n       -> ${dirname(item.to)}`);
  if (APPLY) {
    mkdirSync(dirname(item.to), { recursive: true });
    renameSync(item.from, item.to);
    db.upsertJob({ id: item.id, [item.column]: item.to });
  }
  moved += 1;
  touchedDirs.add(dirname(item.from));
}

// Only ever remove a directory we emptied, and only if it is genuinely empty.
const pruned = [];
if (APPLY) {
  for (const dir of [...touchedDirs].sort((a, b) => b.length - a.length)) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) { rmdirSync(dir); pruned.push(dir); }
      const parent = dirname(dir);
      if (existsSync(parent) && readdirSync(parent).length === 0) { rmdirSync(parent); pruned.push(parent); }
    } catch { /* leave anything we cannot cleanly remove */ }
  }
}

console.log(`\n${moved} moved · ${relinked} re-linked · ${skipped} skipped`
  + (pruned.length ? ` · ${pruned.length} empty director(ies) removed` : ''));
if (!APPLY) console.log('\nDRY RUN — nothing was changed. Re-run with --apply to perform it.');
db.close();
