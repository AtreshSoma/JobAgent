/**
 * Professional output path + filename convention (single source of truth).
 *
 * Every generated application artifact lives under:
 *
 *   applications/output/{Company Name}/{Job Title}_{JobID-or-PostedDate}/
 *     Atresh_Somayajula_Resume_{Job_Title}.docx
 *     Atresh_Somayajula_Resume_{Job_Title}.pdf
 *     Atresh_Somayajula_Cover_Letter_{Job_Title}.(pdf|txt)
 *     Application_Packet_{Company_Name}_{Job_Title}.json
 *
 * Folder names are human-readable (spaces preserved) so the tree is easy to
 * browse; per-file names are underscore-joined so each document carries the
 * candidate's name and role. Acronyms (SQL, ETL, BI, AI, …) are preserved when
 * a title has to be reconstructed from a legacy slug.
 *
 * Used by BOTH the live pipeline (future generation) and the migration script
 * so the two can never drift apart.
 */

import { join, relative } from 'node:path';

/** Candidate name fallback if config is unavailable. */
export const DEFAULT_CANDIDATE_NAME = 'Atresh Somayajula';

/**
 * Project-relative path with forward slashes, for tidy console output.
 * @param {string} root project root
 * @param {string} p absolute (or relative) path
 * @returns {string}
 */
export function relPath(root, p) {
  if (!p) return '';
  try { return relative(root, p).split('\\').join('/'); }
  catch { return String(p); }
}

/** Tech / business acronyms preserved in ALL CAPS when de-slugging titles. */
const ACRONYMS = new Set([
  'SQL', 'ETL', 'ELT', 'BI', 'AI', 'ML', 'AIDP', 'AWS', 'GCP', 'API', 'ERP',
  'CRM', 'HR', 'IT', 'QA', 'UI', 'UX', 'CI', 'CD', 'GPU', 'CPU', 'LLM', 'NLP',
  'PII', 'KPI', 'DBA', 'SSIS', 'SSRS', 'SSAS', 'ADF', 'EMR', 'EC2', 'S3', 'RDS',
  'BFSI', 'SAP', 'PHI', 'GIS', 'OLAP', 'OLTP', 'DWH', 'CDP', 'MDM',
]);

/** Mixed-case tokens that should keep their canonical casing. */
const MIXED_CASE = {
  pyspark: 'PySpark', saas: 'SaaS', paas: 'PaaS', iaas: 'IaaS',
  mlops: 'MLOps', devops: 'DevOps', nodejs: 'NodeJS', dataops: 'DataOps',
  powerbi: 'PowerBI', genai: 'GenAI', noetl: 'NoETL',
};

/**
 * Make a string safe to use as a single path segment WITHOUT destroying
 * readability: strip characters illegal on Windows/POSIX, collapse whitespace,
 * and trim trailing dots/spaces. Spaces are preserved.
 * @param {unknown} text
 * @returns {string}
 */
export function fsSafeSegment(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ') // illegal / control chars
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '') // no trailing dots/spaces (Windows)
    .replace(/^[.\s]+/g, '')
    .trim();
}

/** Capitalize one token, honoring the acronym + mixed-case tables. */
function caseToken(token) {
  const lower = token.toLowerCase();
  if (MIXED_CASE[lower]) return MIXED_CASE[lower];
  if (ACRONYMS.has(lower.toUpperCase())) return lower.toUpperCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Reconstruct a readable, properly-cased phrase from a legacy hyphen slug.
 * e.g. "senior-sql-etl-lead-developer" -> "Senior SQL ETL Lead Developer".
 * @param {string} slug
 * @returns {string}
 */
export function deslug(slug) {
  const parts = String(slug ?? '')
    .split(/[-\s_]+/)
    .filter(Boolean)
    .map(caseToken);
  return parts.join(' ').trim();
}

/**
 * Underscore-joined form of a phrase for use inside a per-file name. Drops
 * standalone separators (a lone "-") and collapses underscores.
 * e.g. "Lakebase Sales Specialist - Retail" -> "Lakebase_Sales_Specialist_Retail".
 * @param {string} text
 * @returns {string}
 */
export function fileToken(text) {
  return fsSafeSegment(text)
    .replace(/&/g, 'and')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'Untitled';
}

/**
 * Candidate filename prefix, e.g. "Atresh Somayajula" -> "Atresh_Somayajula".
 * @param {string} [fullName]
 * @returns {string}
 */
export function candidatePrefix(fullName = DEFAULT_CANDIDATE_NAME) {
  return fileToken(fullName) || 'Candidate';
}

/**
 * Normalize a date-or-id suffix for a job folder. A bare YYYYMMDD or an ISO
 * timestamp becomes YYYY-MM-DD; anything else is made path-safe verbatim.
 * @param {unknown} value
 * @returns {string}
 */
export function folderDateOrId(value) {
  const s = String(value ?? '').trim();
  if (!s) return 'undated';
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return fsSafeSegment(s) || 'undated';
}

/**
 * Compute the professional output folder + filenames for one job.
 *
 * @param {object} args
 * @param {string} args.root project root
 * @param {string} args.company readable company name (or legacy slug)
 * @param {string} args.title readable job title (or legacy slug)
 * @param {string} args.dateOrId YYYYMMDD / ISO date / job id used as the folder suffix
 * @param {string} [args.candidateName]
 * @param {boolean} [args.fromSlug=false] treat company/title as hyphen slugs needing de-slugging
 * @returns {{
 *   companyFolder: string, jobFolder: string, relFolder: string, folder: string,
 *   candidate: string, resumeBase: string, coverLetterBase: string,
 *   resumeDocxPath: string, resumePdfPath: string, packetPath: string,
 *   packetName: string, coverLetterPath: (ext?: string) => string,
 * }}
 */
export function buildJobPaths({
  root, company, title, dateOrId, candidateName = DEFAULT_CANDIDATE_NAME, fromSlug = false,
}) {
  const companyName = fromSlug ? deslug(company) : fsSafeSegment(company);
  const titleName = fromSlug ? deslug(title) : fsSafeSegment(title);
  const companyFolder = fsSafeSegment(companyName) || 'Unknown Company';
  const titleFolder = fsSafeSegment(titleName) || 'Untitled Role';
  const jobFolder = `${titleFolder}_${folderDateOrId(dateOrId)}`;

  const relFolder = join('applications', 'output', companyFolder, jobFolder);
  const folder = join(root, relFolder);

  const candidate = candidatePrefix(candidateName);
  const titleFile = fileToken(titleName);
  const companyFile = fileToken(companyName);

  const resumeBase = `${candidate}_Resume_${titleFile}`;
  const coverLetterBase = `${candidate}_Cover_Letter_${titleFile}`;
  const packetName = `Application_Packet_${companyFile}_${titleFile}.json`;

  return {
    companyFolder,
    jobFolder,
    relFolder,
    folder,
    candidate,
    resumeBase,
    coverLetterBase,
    packetName,
    resumeDocxPath: join(folder, `${resumeBase}.docx`),
    resumePdfPath: join(folder, `${resumeBase}.pdf`),
    packetPath: join(folder, packetName),
    coverLetterPath: (ext = 'pdf') => join(folder, `${coverLetterBase}.${String(ext).replace(/^\./, '')}`),
  };
}
