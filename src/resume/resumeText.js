/**
 * One entry point for "what does this resume say?", whatever the file type.
 *
 * Both readers return the same shape — paragraphs in reading order — so the
 * resume parser (src/profile/fromResume.js) never needs to know which kind of
 * file it was given. Only a .docx can become a master resume: tailoring edits
 * the Word document itself. A PDF is read for its details and nothing more.
 */

import { extractDocxText, isDocxBuffer } from './docxText.js';
import { extractPdfText, isPdfBuffer } from './pdfText.js';

/** @typedef {'docx' | 'pdf'} ResumeFormat */

/**
 * @param {Buffer} buffer
 * @returns {ResumeFormat | null} what the bytes are, by their magic numbers (never the file name)
 */
export function resumeFormat(buffer) {
  if (isDocxBuffer(buffer)) return 'docx';
  if (isPdfBuffer(buffer)) return 'pdf';
  return null;
}

/**
 * Read a .docx or PDF resume.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ format: ResumeFormat, paragraphs: string[], links: string[] }>}
 */
export async function readResumeText(buffer) {
  const format = resumeFormat(buffer);
  if (format === 'docx') return { format, paragraphs: extractDocxText(buffer).paragraphs, links: [] };
  if (format === 'pdf') {
    const { paragraphs, links } = await extractPdfText(buffer);
    return { format, paragraphs, links };
  }
  throw Object.assign(new Error('that is not a Word (.docx) or PDF file'), { statusCode: 400 });
}

/**
 * The email address a resume links to ("mailto:…"). A PDF often shows an
 * icon or the word "Email" and keeps the address only in the link.
 * @param {string[]} links
 */
export function emailFromLinks(links = []) {
  for (const link of links) {
    const m = /^mailto:([^?\s]+)/i.exec(String(link));
    if (m) {
      const address = decodeURIComponent(m[1]).trim();
      if (/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(address)) return address;
    }
  }
  return '';
}
