/**
 * Generate and validate a small, representative set of tailored resumes
 * against real job descriptions already stored in the local Job Agent DB.
 *
 * This is a read-only audit of job/application state: output resumes and one
 * privacy-minimized JSON report are written under reports/resume-audit/. No
 * approval, status, score, or submitted flag is changed.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config/loadConfig.js';
import { DEFAULT_DB_PATH, openDatabase } from '../src/logging/db.js';
import { tailorResumeForJob } from '../src/resume/tailorRunner.js';
import { writeFileAtomic } from '../src/utils/fsSafe.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function jsonList(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function safeName(value) {
  return String(value ?? 'job').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 70) || 'job';
}

/** Prefer strong, complete, real postings and avoid three copies of one title. */
export function selectAuditJobs(rows, limit = 3) {
  const candidates = rows
    .filter((job) => String(job.jd_text ?? '').length >= 1_000)
    .filter((job) => job.company && job.title && Number.isFinite(job.score))
    .sort((a, b) => (b.score - a.score)
      || String(b.posted_at ?? '').localeCompare(String(a.posted_at ?? ''))
      || String(a.id).localeCompare(String(b.id)));
  const selected = [];
  const titleFamilies = new Set();
  for (const job of candidates) {
    const family = String(job.title).toLowerCase()
      .replace(/\b(senior|sr\.?|lead|principal|staff|ii|iii)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ').trim();
    if (titleFamilies.has(family) && candidates.length - selected.length > limit) continue;
    titleFamilies.add(family);
    selected.push(job);
    if (selected.length === limit) break;
  }
  return selected;
}

export async function auditTailoredResumes({
  root = ROOT, dbPath = DEFAULT_DB_PATH, limit = 3, config = null,
  tailorFn = tailorResumeForJob,
} = {}) {
  config = config ?? loadConfig({ root });
  const db = openDatabase({ path: dbPath });
  const reportDir = join(root, 'reports', 'resume-audit');
  mkdirSync(reportDir, { recursive: true });
  try {
    const jobs = selectAuditJobs(db.listJobs({}), Math.max(3, Math.min(Number(limit) || 3, 10)));
    if (jobs.length < 3) throw new Error(`need at least 3 complete job descriptions; found ${jobs.length}`);

    const results = [];
    for (const job of jobs) {
      const tailored = await tailorFn({
        job: {
          id: job.id, company: job.company, title: job.title,
          jdText: job.jd_text, location: job.location, url: job.url,
        },
        score: {
          total: job.score,
          matchedKeywords: jsonList(job.matched_keywords),
          missingKeywords: jsonList(job.missing_keywords),
        },
        config,
        options: {
          exportPdf: false,
          addSummaryLine: config.runtime?.resumeFocusLine === true,
          outputDir: join(reportDir, safeName(`${job.company}-${job.title}`)),
          outputFilename: 'Tailored_Resume_Audit.docx',
        },
      });
      const validation = tailored.validation ?? {};
      const ats = tailored.atsReport ?? {};
      const invariants = tailored.invariants ?? {};
      const passed = Boolean(
        tailored.tailored
        && validation.ok
        && ats.ok !== false
        && ats.ats_safety?.ok
        && invariants.employment_facts_unchanged
        && invariants.employment_chronology_unchanged
        && invariants.duplicate_protection_passed
        && invariants.tables_removed_for_ats,
      );
      results.push({
        jobId: job.id,
        company: job.company,
        title: job.title,
        jobScore: job.score,
        jdCharacters: String(job.jd_text).length,
        passed,
        tailored: tailored.tailored,
        outputPath: tailored.output_path,
        contentValidation: {
          ok: validation.ok ?? false,
          wordCount: validation.word_count ?? null,
          issues: validation.issues ?? [],
          warnings: validation.warnings ?? [],
        },
        ats: {
          matchScore: ats.match_score ?? null,
          band: ats.band ?? null,
          structureSafe: ats.ats_safety?.ok ?? false,
          tableCount: ats.ats_safety?.findings?.tables ?? null,
          highSeverityIssues: (ats.ats_safety?.issues ?? []).filter((issue) => issue.severity === 'high'),
        },
        truthfulness: {
          employmentFactsUnchanged: invariants.employment_facts_unchanged ?? false,
          chronologyUnchanged: invariants.employment_chronology_unchanged ?? false,
          duplicateProtectionPassed: invariants.duplicate_protection_passed ?? false,
          tablesRemovedForAts: invariants.tables_removed_for_ats ?? false,
        },
        updates: (tailored.changes ?? []).map((change) => change.type),
        honestGaps: (tailored.gaps ?? []).map((gap) => ({
          keyword: gap.keyword, qualification: gap.qualification,
        })),
      });
    }

    const report = {
      generatedAt: new Date().toISOString(),
      scope: 'Fresh audit copies generated from the unchanged master resume and real stored job descriptions; no job state was mutated.',
      total: results.length,
      passed: results.filter((item) => item.passed).length,
      failed: results.filter((item) => !item.passed).length,
      results,
    };
    const reportPath = join(reportDir, 'tailored_resume_audit.json');
    writeFileAtomic(reportPath, JSON.stringify(report, null, 2), 'utf8');
    return { ...report, reportPath };
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const report = await auditTailoredResumes({ limit: limitArg?.split('=')[1] ?? 3 });
  console.table(report.results.map((item) => ({
    company: item.company,
    role: item.title,
    pass: item.passed,
    ats: item.ats.matchScore,
    band: item.ats.band,
    words: item.contentValidation.wordCount,
    tables: item.ats.tableCount,
    updates: item.updates.length,
    gaps: item.honestGaps.length,
  })));
  console.log(`Audit: ${report.passed}/${report.total} passed`);
  console.log(`Report: ${report.reportPath}`);
  if (report.failed) process.exitCode = 1;
}
