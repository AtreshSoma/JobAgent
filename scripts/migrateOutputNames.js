/**
 * Migrate ALL legacy generated outputs into the professional folder layout.
 *
 * Legacy artifacts were scattered and messy:
 *   - resumes/output/{company}_{title}_{date}.docx | .pdf            (resumes)
 *   - resumes/output/{company}_{title}_{date}.txt                    (cover letters)
 *   - data/packets/{uuid}.json                                       (packets)
 *   - applications/output/{uuid}.json                                (earlier partial move)
 *
 * They are reorganized into:
 *   applications/output/{Company Name}/{Job Title}_{Date}/
 *     Atresh_Somayajula_Resume_{Job_Title}.docx
 *     Atresh_Somayajula_Resume_{Job_Title}.pdf
 *     Atresh_Somayajula_Cover_Letter_{Job_Title}.txt
 *     Application_Packet_{Company}_{Job_Title}.json
 *
 * Rules:
 *   - DRY-RUN by default; pass `--apply` to move files + update the database.
 *   - DOCX/PDF/TXT that share a stem are paired into the same job folder.
 *   - Packet JSON is co-located with its resume (matched via the packet's
 *     recorded resume path) and its internal paths are rewritten to the new
 *     location so nothing dangles.
 *   - Files that cannot be parsed confidently go to applications/output/_Needs_Review/.
 *   - Destinations are NEVER overwritten — a clash appends _v2, _v3, …
 *   - resumes/output/ is left containing only .gitkeep.
 *   - Every move is logged and a JSON report is written to
 *     reports/output_migration_report_YYYY-MM-DD.json.
 *
 * Usage:
 *   node scripts/migrateOutputNames.js            # preview (writes a plan report)
 *   node scripts/migrateOutputNames.js --apply    # perform the migration
 */

import { join, dirname, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, rmdirSync, statSync, unlinkSync,
} from 'node:fs';

import { openDatabase } from '../src/logging/db.js';
import { buildJobPaths, DEFAULT_CANDIDATE_NAME } from '../src/utils/outputPaths.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Resume / cover-letter extensions we know how to migrate. */
const RESUME_EXTS = new Set(['.docx', '.pdf']);
const COVER_EXTS = new Set(['.txt']);

/** Normalize an absolute path for case-insensitive comparison. */
function norm(p) {
  return resolve(p).toLowerCase();
}

/** Read the candidate display name (for file prefixes) without full validation. */
function readCandidateName(root) {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
    return raw?.identity?.fullName || DEFAULT_CANDIDATE_NAME;
  } catch {
    return DEFAULT_CANDIDATE_NAME;
  }
}

/** Parse a legacy resume/cover stem: "{companySlug}_{titleSlug}_{YYYYMMDD}". */
function parseLegacyStem(stem) {
  const m = String(stem).match(/^(.+?)_(.+)_(\d{8})$/);
  if (!m) return null;
  const [, companySlug, titleSlug, date] = m;
  if (!companySlug || !titleSlug) return null;
  return { companySlug, titleSlug, date };
}

/** Today's date as YYYY-MM-DD for the report filename. */
function reportDate(now) {
  const d = now ?? new Date();
  return d.toISOString().slice(0, 10);
}

/** Read a packet JSON, tolerating malformed files. */
function readPacket(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Choose a destination path that does not collide. Appends _v2, _v3, … before
 * the extension. `claimed` tracks paths reserved within this run.
 */
function uniqueDest(destPath, claimed) {
  const ext = extname(destPath);
  const base = ext ? destPath.slice(0, -ext.length) : destPath;
  let candidate = destPath;
  let n = 2;
  while (claimed.has(norm(candidate)) || existsSync(candidate)) {
    candidate = `${base}_v${n}${ext}`;
    n += 1;
  }
  claimed.add(norm(candidate));
  return candidate;
}

/**
 * Run (or preview) the full migration.
 *
 * @param {object} args
 * @param {string} [args.root=ROOT]
 * @param {boolean} [args.apply=false] actually move files + update DB
 * @param {string} [args.candidateName]
 * @param {import('../src/logging/db.js').Database|null} [args.db] DB handle (null skips updates)
 * @param {Date} [args.now]
 * @param {boolean} [args.writeReport=true]
 * @returns {object} migration report
 */
export function migrate({
  root = ROOT, apply = false, candidateName, db = undefined, now, writeReport = true,
} = {}) {
  const candidate = candidateName ?? readCandidateName(root);
  const resumesDir = join(root, 'resumes', 'output');
  const packetsDir = join(root, 'data', 'packets');
  const appsOutputDir = join(root, 'applications', 'output');
  const needsReviewDir = join(appsOutputDir, '_Needs_Review');

  const report = {
    generatedAt: (now ?? new Date()).toISOString(),
    apply,
    moves: [],
    needsReview: [],
    dbUpdates: [],
    errors: [],
    counts: { resumes: 0, coverLetters: 0, packets: 0, needsReview: 0, dbUpdates: 0 },
  };

  const claimed = new Set();
  // stem -> { docx, pdf, txt, folder } so packets can be co-located.
  const groupNewPaths = new Map();
  // normalized old absolute path -> new absolute path (for packet JSON rewrite).
  const moveMap = new Map();

  const doMove = (from, to) => {
    if (apply) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    moveMap.set(norm(from), to);
  };

  const recordMove = (from, to, type) => {
    report.moves.push({ type, from: from.replace(root, '.'), to: to.replace(root, '.') });
  };

  const sendToReview = (from, reason) => {
    const dest = uniqueDest(join(needsReviewDir, basename(from)), claimed);
    doMove(from, dest);
    report.needsReview.push({ file: from.replace(root, '.'), reason, movedTo: dest.replace(root, '.') });
    report.counts.needsReview += 1;
  };

  // ---- 1. Index packets (by the resume file they reference) ---------------
  const packetFiles = [];
  for (const dir of [packetsDir, appsOutputDir]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const full = join(dir, name);
      if (!statSync(full).isFile()) continue; // skip subfolders in applications/output
      packetFiles.push(full);
    }
  }

  /** stem(resumeBasename) -> { company, title, dateOrId } from a packet. */
  const enrichByStem = new Map();
  const packets = [];
  for (const file of packetFiles) {
    const data = readPacket(file);
    if (!data) {
      packets.push({ file, data: null });
      continue;
    }
    const company = data.job?.company ?? null;
    const title = data.job?.title ?? null;
    const resumeBase = data.resumePath ? basename(String(data.resumePath)) : null;
    const stem = resumeBase ? resumeBase.replace(/\.[^.]+$/, '') : null;
    const parsed = stem ? parseLegacyStem(stem) : null;
    const dateOrId = parsed?.date
      ?? (data.createdAt ? String(data.createdAt).slice(0, 10) : 'undated');
    if (company && title && stem && !enrichByStem.has(stem)) {
      enrichByStem.set(stem, { company, title, dateOrId });
    }
    packets.push({ file, data, company, title, stem, dateOrId });
  }

  // ---- 2. Migrate resume + cover-letter files -----------------------------
  const resumeFiles = existsSync(resumesDir)
    ? readdirSync(resumesDir).filter((f) => {
      if (f === '.gitkeep') return false;
      const ext = extname(f).toLowerCase();
      return RESUME_EXTS.has(ext) || COVER_EXTS.has(ext);
    })
    : [];

  // Group files by stem so docx/pdf/txt of the same job land together.
  const groups = new Map();
  for (const f of resumeFiles) {
    const stem = f.replace(/\.[^.]+$/, '');
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(f);
  }

  for (const [stem, files] of groups) {
    const enrich = enrichByStem.get(stem);
    const parsed = parseLegacyStem(stem);
    if (!enrich && !parsed) {
      // Cannot determine company/title/date — needs a human.
      for (const f of files) sendToReview(join(resumesDir, f), 'unparseable resume filename');
      continue;
    }

    const paths = enrich
      ? buildJobPaths({ root, company: enrich.company, title: enrich.title, dateOrId: enrich.dateOrId, candidateName: candidate })
      : buildJobPaths({ root, company: parsed.companySlug, title: parsed.titleSlug, dateOrId: parsed.date, candidateName: candidate, fromSlug: true });

    const groupPaths = { folder: paths.folder };
    for (const f of files) {
      const from = join(resumesDir, f);
      const ext = extname(f).toLowerCase();
      let dest;
      let type;
      if (ext === '.docx') { dest = uniqueDest(paths.resumeDocxPath, claimed); type = 'resume-docx'; report.counts.resumes += 1; groupPaths.docx = dest; }
      else if (ext === '.pdf') { dest = uniqueDest(paths.resumePdfPath, claimed); type = 'resume-pdf'; report.counts.resumes += 1; groupPaths.pdf = dest; }
      else { dest = uniqueDest(paths.coverLetterPath('txt'), claimed); type = 'cover-letter'; report.counts.coverLetters += 1; groupPaths.txt = dest; }
      doMove(from, dest);
      recordMove(from, dest, type);
    }
    groupNewPaths.set(stem, groupPaths);
  }

  // ---- 3. Migrate packet JSON files ---------------------------------------
  for (const p of packets) {
    if (!p.data || !p.company || !p.title) {
      sendToReview(p.file, p.data ? 'packet missing company/title' : 'unreadable packet JSON');
      continue;
    }
    const paths = buildJobPaths({
      root, company: p.company, title: p.title, dateOrId: p.dateOrId, candidateName: candidate,
    });
    const dest = uniqueDest(paths.packetPath, claimed);

    // Rewrite internal paths so the packet keeps pointing at real files.
    const group = p.stem ? groupNewPaths.get(p.stem) : null;
    const rewritten = rewritePacketPaths(p.data, moveMap, group);

    if (apply) {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, `${JSON.stringify(rewritten, null, 2)}\n`, 'utf8');
      unlinkSync(p.file);
    }
    moveMap.set(norm(p.file), dest);
    recordMove(p.file, dest, 'packet');
    report.counts.packets += 1;

    // ---- 4. Update the database row for this job ----
    const jobId = p.data.job?.id;
    if (jobId) {
      const update = {
        id: jobId,
        application_packet_path: dest,
        output_folder_path: paths.folder,
      };
      if (group?.docx) { update.resume_path = group.docx; update.resume_docx_path = group.docx; }
      if (group?.pdf) update.resume_pdf_path = group.pdf;
      if (group?.txt) update.cover_letter_path = group.txt;
      report.dbUpdates.push({ jobId, ...stripRoot(update, root) });
      report.counts.dbUpdates += 1;
      if (apply && db) {
        const existing = db.getJob(jobId);
        if (existing) db.upsertJob(update);
      }
    }
  }

  // ---- 5. Tidy up source folders ------------------------------------------
  if (apply) {
    // Ensure resumes/output keeps only .gitkeep.
    if (existsSync(resumesDir)) {
      for (const f of readdirSync(resumesDir)) {
        if (f !== '.gitkeep') {
          // Any straggler we did not handle goes to review rather than lingering.
          sendToReview(join(resumesDir, f), 'unmigrated leftover');
        }
      }
      if (!existsSync(join(resumesDir, '.gitkeep'))) {
        writeFileSync(join(resumesDir, '.gitkeep'), '', 'utf8');
      }
    }
    // Remove data/packets if now empty.
    if (existsSync(packetsDir) && readdirSync(packetsDir).length === 0) {
      rmdirSync(packetsDir);
    }
  }

  // ---- 6. Write the migration report --------------------------------------
  if (writeReport) {
    const reportsDir = join(root, 'reports');
    const reportPath = join(reportsDir, `output_migration_report_${reportDate(now)}.json`);
    mkdirSync(reportsDir, { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    report.reportPath = reportPath;
  }

  return report;
}

/** Replace `root` prefix in update path values for a compact report. */
function stripRoot(obj, root) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'id') continue;
    out[k] = typeof v === 'string' ? v.replace(root, '.') : v;
  }
  return out;
}

/**
 * Return a deep copy of a packet with any old file path rewritten to its new
 * location. `moveMap` maps normalized old absolute paths to new ones; `group`
 * provides the resume/cover destinations for sibling fields (e.g. resumePdfPath)
 * that may not have been keyed individually.
 */
export function rewritePacketPaths(packet, moveMap, group) {
  const remap = (value) => {
    if (typeof value !== 'string') return value;
    const hit = moveMap.get(norm(value));
    return hit ?? value;
  };

  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      // A rewritten `path` should drag its sibling `name` along with it.
      const mappedPath = typeof node.path === 'string' ? remap(node.path) : undefined;
      const pathChanged = mappedPath !== undefined && mappedPath !== node.path;
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === 'name' && pathChanged) {
          out.name = basename(mappedPath);
        } else if (typeof v === 'string') {
          out[k] = remap(v);
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return node;
  };

  const clone = walk(packet);
  // Direct, well-known fields (in case the value was not in moveMap but the
  // sibling group is known — e.g. the resume PDF the packet never listed).
  if (group?.docx && clone.resumePath) clone.resumePath = moveMap.get(norm(packet.resumePath)) ?? clone.resumePath;
  if (group?.pdf && 'resumePdfPath' in clone) clone.resumePdfPath = group.pdf;
  if (group?.txt && clone.coverLetterPath) clone.coverLetterPath = moveMap.get(norm(packet.coverLetterPath)) ?? group.txt;
  return clone;
}

function main() {
  const apply = process.argv.includes('--apply');
  const db = openDatabase();
  try {
    const report = migrate({ apply, db });
    console.log(`${apply ? 'Migrated' : '[dry-run] Planned'} ` +
      `${report.counts.resumes} resume file(s), ${report.counts.coverLetters} cover letter(s), ` +
      `${report.counts.packets} packet(s).`);
    if (report.counts.needsReview) {
      console.log(`  ${report.counts.needsReview} file(s) routed to _Needs_Review.`);
    }
    console.log(`  ${report.counts.dbUpdates} database row(s) ${apply ? 'updated' : 'to update'}.`);
    for (const m of report.moves.slice(0, 12)) console.log(`  ${apply ? 'moved' : 'would move'} (${m.type}): ${m.from} -> ${m.to}`);
    if (report.moves.length > 12) console.log(`  …and ${report.moves.length - 12} more (see report).`);
    if (report.reportPath) console.log(`Report: ${report.reportPath.replace(ROOT, '.')}`);
    if (!apply) console.log('Re-run with --apply to perform the migration.');
  } finally {
    db.close();
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) {
  main();
}
