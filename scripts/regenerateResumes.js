/**
 * Regenerate tailored resumes with the per-job focus line.
 *
 * Walks every Application_Packet_*.json under applications/output, reads the
 * keywords the pipeline already computed for that job (matchedKeywords +
 * missingKeywords), and re-runs the deterministic resume tailor for the
 * resume that packet points at — this time WITH the "Most relevant to this
 * role" focus line enabled.
 *
 * It does NOT rewrite bullets, invent skills, or call any LLM. The focus line
 * lists only keywords the job asked for AND your master resume already
 * contains. The master (resumes/base/MASTER_RESUME.docx) is opened read-only.
 *
 * Usage:
 *   node scripts/regenerateResumes.js            # dry-run (default)
 *   node scripts/regenerateResumes.js --apply    # actually rewrite the .docx/.pdf
 *
 * A JSON report is written to reports/resume_focus_regen_report_YYYY-MM-DD.json.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync,
} from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config/loadConfig.js';
import { tailorResumeForJob } from '../src/resume/tailorRunner.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Recursively collect files under `dir` whose name matches `predicate`. */
function walkFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '_Needs_Review') continue;
      walkFiles(full, predicate, out);
    } else if (predicate(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Normalize a path for stable map keys. */
const norm = (p) => resolve(p).toLowerCase();

/** Same whitespace/case normalization the Python keyword audit uses. */
export function normalizeForAudit(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Split keywords into those present in the master resume text vs missing,
 * mirroring src/resume/keywordAudit.py (case-insensitive substring, de-duped).
 */
export function auditPresent(masterText, keywords) {
  const haystack = normalizeForAudit(masterText);
  const present = [];
  const seen = new Set();
  for (const kw of keywords ?? []) {
    const key = normalizeForAudit(kw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (haystack.includes(key)) present.push(kw);
  }
  return present;
}

/** Merge matched + missing keywords (matched first), de-duped, preserving order. */
export function packetKeywords(packet) {
  const matched = Array.isArray(packet.matchedKeywords) ? packet.matchedKeywords : [];
  const missing = Array.isArray(packet.missingKeywords) ? packet.missingKeywords : [];
  const seen = new Set();
  const out = [];
  for (const kw of [...matched, ...missing]) {
    const key = normalizeForAudit(kw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(kw);
  }
  return out;
}

/**
 * Index packets by the resume .docx they point at. When several packets target
 * the same resume, keep the one with the most matched keywords.
 *
 * @returns {Map<string, {resumePath, company, title, keywords, matchedCount, packetPath}>}
 */
export function indexPacketsByResume(root) {
  const outputRoot = join(root, 'applications', 'output');
  const packetFiles = walkFiles(outputRoot, (n) => /^Application_Packet_.*\.json$/.test(n));
  const byResume = new Map();

  for (const packetPath of packetFiles) {
    let packet;
    try {
      packet = JSON.parse(readFileSync(packetPath, 'utf8'));
    } catch {
      continue;
    }
    const resumePath = packet.resumePath;
    if (typeof resumePath !== 'string' || !/\.docx$/i.test(resumePath)) continue;
    if (!existsSync(resumePath)) continue;

    const keywords = packetKeywords(packet);
    const matchedCount = Array.isArray(packet.matchedKeywords) ? packet.matchedKeywords.length : 0;
    const key = norm(resumePath);
    const prev = byResume.get(key);
    if (!prev || matchedCount > prev.matchedCount) {
      byResume.set(key, {
        resumePath,
        company: packet.job?.company ?? '',
        title: packet.job?.title ?? '',
        keywords,
        matchedCount,
        packetPath,
      });
    }
  }
  return byResume;
}

/** Read all text from the master .docx via the Python keyword-audit helper. */
export function readMasterText(root, env = process.env) {
  const master = join(root, 'resumes', 'base', 'MASTER_RESUME.docx');
  const py = env.PYTHON || env.PYTHON_EXECUTABLE || 'python';
  const code =
    'import sys; sys.path.insert(0, sys.argv[2]); ' +
    'from keywordAudit import read_docx_text; ' +
    'sys.stdout.write(read_docx_text(sys.argv[1]))';
  return execFileSync(py, ['-c', code, master, join(root, 'src', 'resume')], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

/**
 * Build the regeneration plan: every resume .docx, annotated with the focus
 * keywords it would gain (or why it is skipped).
 */
export function planRegeneration({ root, masterText, byResume }) {
  const outputRoot = join(root, 'applications', 'output');
  const resumeFiles = walkFiles(outputRoot, (n) => /Resume.*\.docx$/i.test(n));
  const planned = [];
  const skipped = [];

  for (const resumePath of resumeFiles) {
    const info = byResume.get(norm(resumePath));
    if (!info) {
      skipped.push({ resumePath, reason: 'no packet references this resume (cannot derive keywords)' });
      continue;
    }
    const present = auditPresent(masterText, info.keywords);
    planned.push({
      resumePath,
      company: info.company,
      title: info.title,
      hasPdf: existsSync(resumePath.replace(/\.docx$/i, '.pdf')),
      focusKeywords: present,
      packetPath: info.packetPath,
    });
  }
  return { planned, skipped };
}

/** Write the dated regeneration report. */
function writeReport(root, report) {
  const dir = join(root, 'reports');
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dir, `resume_focus_regen_report_${date}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8');
  return path;
}

/**
 * Run the regeneration.
 * @param {object} args
 * @param {string} [args.root]
 * @param {boolean} [args.apply=false]
 * @param {object} [args.config] preloaded config bundle (tests)
 * @param {string} [args.masterText] preloaded master text (tests)
 * @param {Function} [args.tailorFn] override tailorResumeForJob (tests)
 */
export async function regenerate({
  root = ROOT, apply = false, config, masterText, tailorFn = tailorResumeForJob,
} = {}) {
  config = config ?? loadConfig({ root });
  masterText = masterText ?? readMasterText(root);
  const byResume = indexPacketsByResume(root);
  const { planned, skipped } = planRegeneration({ root, masterText, byResume });

  const results = [];
  const failures = [];
  let totalKeywords = 0;
  let emptyFocus = 0;

  for (const item of planned) {
    totalKeywords += item.focusKeywords.length;
    if (item.focusKeywords.length === 0) emptyFocus += 1;

    if (!apply) {
      results.push({ ...item, status: 'planned' });
      continue;
    }

    try {
      const tailored = await tailorFn({
        job: { company: item.company, title: item.title, jdText: '' },
        score: {
          matchedKeywords: byResume.get(norm(item.resumePath))?.keywords ?? item.focusKeywords,
          missingKeywords: [],
        },
        config,
        options: {
          addSummaryLine: false,
          exportPdf: item.hasPdf && config?.runtime?.resumeExportPdf !== false,
          outputDir: dirname(item.resumePath),
          outputFilename: basename(item.resumePath),
        },
      });
      const failed = tailored?.validation && tailored.validation.ok === false;
      if (!tailored?.tailored || failed) {
        failures.push({ resumePath: item.resumePath, warning: tailored?.warning ?? 'failed validation' });
      }
      results.push({
        resumePath: item.resumePath,
        company: item.company,
        title: item.title,
        focusKeywords: item.focusKeywords,
        pdf: tailored?.pdf_path ?? null,
        status: failed ? 'failed' : 'regenerated',
      });
    } catch (err) {
      failures.push({ resumePath: item.resumePath, warning: err.message });
      results.push({ resumePath: item.resumePath, status: 'error', error: err.message });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    counts: {
      resumesPlanned: planned.length,
      resumesSkipped: skipped.length,
      resumesWithFocusLine: planned.length - emptyFocus,
      resumesEmptyFocus: emptyFocus,
      avgKeywordsPerResume: planned.length ? Number((totalKeywords / planned.length).toFixed(2)) : 0,
      failures: failures.length,
    },
    skipped,
    failures,
    results,
  };
  const reportPath = writeReport(root, report);
  return { ...report, reportPath };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const result = await regenerate({ apply });
  const c = result.counts;
  const tag = apply ? 'Regenerated' : '[dry-run] Would regenerate';
  console.log(`${tag} ${c.resumesPlanned} resume(s) with the focus line.`);
  console.log(`  ${c.resumesWithFocusLine} get a non-empty focus line | ${c.resumesEmptyFocus} have no matching keyword.`);
  console.log(`  avg ${c.avgKeywordsPerResume} focus keyword(s) per resume.`);
  if (c.resumesSkipped) console.log(`  ${c.resumesSkipped} resume(s) skipped (no packet → no keywords).`);
  if (c.failures) console.log(`  ${c.failures} failure(s) — see report.`);
  for (const item of result.results.slice(0, 8)) {
    const kws = (item.focusKeywords ?? []).join(', ') || '(none)';
    console.log(`  ${item.status}: ${item.company} — ${item.title}: ${kws}`);
  }
  if (result.results.length > 8) console.log(`  …and ${result.results.length - 8} more (see report).`);
  console.log(`Report: ${result.reportPath}`);
  if (!apply) console.log('Re-run with --apply to rewrite the resumes.');
}

if (process.argv[1] && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
