/**
 * File upload planner.
 *
 * Validates that the resume (and optional cover letter) files exist and builds a
 * deterministic upload plan. It does not perform any network upload or form
 * submission — it only prepares and verifies the artifacts an upload step would
 * use, surfacing missing files as blockers.
 */

import { existsSync, statSync } from 'node:fs';
import { extname, basename } from 'node:path';

/** Resume-grade documents must be a real document format. */
const RESUME_EXTENSIONS = new Set(['.pdf', '.docx', '.doc']);
/** Cover letters may also be plain text (often pasted into a field). */
const COVER_LETTER_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.txt']);

/**
 * @param {object} files
 * @param {string} files.resumePath required tailored resume path
 * @param {string} [files.coverLetterPath] optional cover letter file path
 * @returns {{
 *   uploads: Array<{type: string, path: string, name: string, sizeBytes: number}>,
 *   blockers: string[],
 *   ready: boolean
 * }}
 */
export function buildUploadPlan({ resumePath, coverLetterPath } = {}) {
  const uploads = [];
  const blockers = [];

  validate('resume', resumePath, true, RESUME_EXTENSIONS, uploads, blockers);
  if (coverLetterPath) {
    validate('coverLetter', coverLetterPath, false, COVER_LETTER_EXTENSIONS, uploads, blockers);
  }

  return { uploads, blockers, ready: blockers.length === 0 && uploads.length > 0 };
}

function validate(type, path, required, allowed, uploads, blockers) {
  if (!path) {
    if (required) blockers.push(`${type}: no file path provided`);
    return;
  }
  if (!existsSync(path)) {
    blockers.push(`${type}: file not found at ${path}`);
    return;
  }
  const ext = extname(path).toLowerCase();
  if (!allowed.has(ext)) {
    blockers.push(`${type}: unsupported file type ${ext}`);
    return;
  }
  let stats;
  try {
    stats = statSync(path);
  } catch (err) {
    blockers.push(`${type}: could not inspect file (${err.message})`);
    return;
  }
  if (!stats.isFile()) {
    blockers.push(`${type}: path is not a file`);
    return;
  }
  const { size } = stats;
  if (size === 0) {
    blockers.push(`${type}: file is empty`);
    return;
  }
  uploads.push({ type, path, name: basename(path), sizeBytes: size });
}

export { RESUME_EXTENSIONS, COVER_LETTER_EXTENSIONS };
