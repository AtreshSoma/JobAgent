/**
 * The cover letter as a PDF, beside its .txt and .docx under the same stem
 * (audit A10).
 *
 * A form's letter slot may take only PDF. The upload step already looks for
 * same-stem siblings in other formats (fileUpload.documentFormats), so all that
 * was missing was the PDF. This writes it, and keeps it honest: every time the
 * letter is rewritten (prepared, edited, restored) a PDF of the previous text
 * is deleted FIRST, and a new one is rendered only from a DOCX that is known
 * to hold the new text. A failed or skipped render leaves no PDF, never an old
 * one, which would be uploaded to an employer in place of what the person wrote.
 */
import { existsSync, rmSync } from 'node:fs';

import { ensureResumePdf } from '../resume/pdfPreview.js';

const stemOf = (letterPath) => String(letterPath).replace(/\.(?:txt|docx|pdf)$/i, '');

/**
 * @param {string} letterPath the letter's .txt (or .docx) path
 * @param {object} [options]
 * @param {boolean} [options.regenerate=true] false when the DOCX was NOT just refreshed: only remove the PDF
 * @param {string} [options.root] workspace root (finds the Python)
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {Function} [options.convert] (docxPath, {root, env}) => {exported, pdfPath, reason}; default: the resume PDF converter
 * @returns {Promise<{pdfPath: string|null, reason: string|null}>}
 */
export async function refreshLetterPdf(letterPath, { regenerate = true, root, env, convert = null } = {}) {
  if (!letterPath) return { pdfPath: null, reason: 'no letter' };
  const stem = stemOf(letterPath);
  const docx = `${stem}.docx`;
  const pdf = `${stem}.pdf`;
  try { rmSync(pdf, { force: true }); } catch { /* it is gone or was never there */ }
  if (!regenerate) return { pdfPath: null, reason: 'the Word copy was not refreshed' };
  // JOB_AGENT_LETTER_PDF=off keeps the default converter (a real LibreOffice,
  // Word or Chromium run) from starting, as tests and constrained machines
  // need; a converter passed in is always used.
  if (!convert && String((env ?? process.env).JOB_AGENT_LETTER_PDF ?? '').toLowerCase() === 'off') {
    return { pdfPath: null, reason: 'letter PDFs are switched off (JOB_AGENT_LETTER_PDF=off)' };
  }
  if (!existsSync(docx)) return { pdfPath: null, reason: 'there is no Word copy to render' };
  try {
    const result = await (convert ?? ensureResumePdf)(docx, { root, env });
    if (result?.exported && (result.pdfPath || existsSync(pdf))) return { pdfPath: result.pdfPath ?? pdf, reason: null };
    try { rmSync(pdf, { force: true }); } catch { /* nothing partial to keep */ }
    return { pdfPath: null, reason: result?.reason ?? 'the PDF could not be made' };
  } catch (err) {
    try { rmSync(pdf, { force: true }); } catch { /* nothing partial to keep */ }
    return { pdfPath: null, reason: err.message };
  }
}
