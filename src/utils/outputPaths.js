/**
 * Professional output path + filename convention (single source of truth).
 *
 * Every generated application artifact lives under:
 *
 *   applications/output/{Company Name}/{Job Title}_{Date}_{JobID hash}/
 *     {Candidate_Name}_Resume_{Job_Title}.docx
 *     {Candidate_Name}_Resume_{Job_Title}.pdf
 *     {Candidate_Name}_Cover_Letter_{Job_Title}.(pdf|txt)
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

import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

/** Candidate name fallback if config is unavailable. */
/**
 * Fallback used only when a caller supplies no candidate name.
 *
 * This was the repository owner's real name, so any code path that forgot to
 * pass `candidateName` silently named a SECOND user's resume and cover letter
 * after the author — in files sent to employers. A neutral default is the only
 * safe one; the real name always arrives from `candidate.identity.fullName`.
 */
export const DEFAULT_CANDIDATE_NAME = 'Candidate';

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
 * Candidate filename prefix, e.g. "Priya Raghunathan" -> "Priya_Raghunathan".
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
/**
 * Short, stable, filename-safe discriminator for one job id.
 *
 * WHY A FOLDER NEEDS ONE. The folder was `{Company}/{Title}_{Date}`, which is
 * not unique: two different requisitions at the same company with the same
 * title, prepared on the same day, resolved to the SAME folder — so the second
 * one's tailored resume, cover letter and packet overwrote the first one's.
 * Reproduced. The first job's approval then pointed at a packet describing the
 * second job, which breaks the approval boundary outright: the human reviewed
 * one posting and the documents on disk were for another.
 *
 * A hash rather than the raw id because ids are source-specific and can be
 * long, URL-ish or contain characters no filesystem wants. Eight hex characters
 * is 4 billion values against a handful of same-company-same-title-same-day
 * collisions, and it is deterministic, so re-preparing a job reuses its folder
 * instead of littering a new one.
 *
 * @param {unknown} jobId
 * @returns {string} 8 hex characters, or '' when there is no id
 */
export function jobDiscriminator(jobId) {
  const id = String(jobId ?? '').trim();
  if (!id) return '';
  return createHash('sha1').update(id).digest('hex').slice(0, 8);
}

export function folderDateOrId(value) {
  const s = String(value ?? '').trim();
  if (!s) return 'undated';
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return fsSafeSegment(s) || 'undated';
}

/** Longest each name segment may be (see buildJobPaths for the arithmetic). */
export const SEGMENT_CAP = Object.freeze({
  companyFolder: 40, titleFolder: 55, titleFile: 45, companyFile: 24,
});

/**
 * Shorten a name to at most `max` characters, preferring a word boundary so a
 * title ends on a whole word ("Senior Data Engineer, Platform") rather than
 * mid-word, and never leaving a trailing dot, space or separator — Windows
 * silently strips trailing dots/spaces, which would desync the path we record.
 * @param {string} name
 * @param {number} max
 * @returns {string}
 */
export function clipName(name, max) {
  const s = String(name ?? '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('_'));
  const head = lastBreak >= max * 0.6 ? cut.slice(0, lastBreak) : cut;
  return head.replace(/[\s._,;:&()-]+$/g, '');
}

/** Preserve the identity lost by truncation without increasing the folder cap. */
function folderName(name, max) {
  if (name.length <= max) return name;
  const suffix = createHash('sha256').update(name).digest('hex').slice(0, 10);
  return `${clipName(name, max - suffix.length - 1)}_${suffix}`;
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
  root, company, title, dateOrId, jobId = '', candidateName = DEFAULT_CANDIDATE_NAME, fromSlug = false,
}) {
  const companyName = fromSlug ? deslug(company) : fsSafeSegment(company);
  const titleName = fromSlug ? deslug(title) : fsSafeSegment(title);
  const companyFolder = folderName(fsSafeSegment(companyName), SEGMENT_CAP.companyFolder) || 'Unknown Company';
  const titleFolder = folderName(fsSafeSegment(titleName), SEGMENT_CAP.titleFolder) || 'Untitled Role';
  // The job discriminator is what makes this path identify ONE requisition.
  // Omitted (migration script, legacy callers) the name is unchanged, so
  // existing folders keep resolving; supplied, two same-titled roles at the
  // same employer on the same day can no longer overwrite each other.
  const discriminator = jobDiscriminator(jobId);
  const jobFolder = discriminator
    ? `${titleFolder}_${folderDateOrId(dateOrId)}_${discriminator}`
    : `${titleFolder}_${folderDateOrId(dateOrId)}`;

  const relFolder = join('applications', 'output', companyFolder, jobFolder);
  const folder = join(root, relFolder);

  const candidate = candidatePrefix(candidateName);
  const titleFile = clipName(fileToken(titleName), SEGMENT_CAP.titleFile) || 'Untitled';
  const companyFile = clipName(fileToken(companyName), SEGMENT_CAP.companyFile) || 'Untitled';

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
