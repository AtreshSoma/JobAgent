/**
 * The cover letter as a PDF (audit A10).
 *
 * The letter was written as .txt plus a best-effort .docx. A form whose letter
 * slot takes only PDF got "not available in any of those formats" and the run
 * stopped. The PDF now sits beside the letter under the same stem, where the
 * upload step already looks for other formats.
 *
 * THE RISK this guards: when the letter is edited or restored, a PDF of the OLD
 * text must never be left beside it, or it would be uploaded instead of what
 * the person wrote. Every rewrite of the letter deletes the PDF first and
 * renders a new one only from a DOCX known to hold the new text.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { refreshLetterPdf } from '../../src/apply/letterPdf.js';
import { fileForInput } from '../../src/automation/uploadRunner.js';
import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';

const LETTER = 'Dear Hiring Team,\n\nI am applying for the Data Engineer role at Northwind. I rebuilt the close pipeline at Contoso.\n\nThank you for your consideration.\n\nSincerely,\nJordan Lee';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jobagent-letterpdf-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const files = () => ({ txt: join(dir, 'Cover_Letter.txt'), docx: join(dir, 'Cover_Letter.docx'), pdf: join(dir, 'Cover_Letter.pdf') });

describe('refreshLetterPdf', () => {
  it('renders the PDF from the letter DOCX, beside it, under the same stem', async () => {
    const f = files();
    writeFileSync(f.txt, LETTER); writeFileSync(f.docx, 'DOCX');
    const seen = [];
    const result = await refreshLetterPdf(f.txt, {
      convert: async (docx) => { seen.push(docx); writeFileSync(f.pdf, 'PDF'); return { exported: true, pdfPath: f.pdf }; },
    });
    expect(seen).toEqual([f.docx]);
    expect(result).toMatchObject({ pdfPath: f.pdf });
  });

  it('deletes a PDF of older text first, so a failed render leaves none', async () => {
    const f = files();
    writeFileSync(f.txt, LETTER); writeFileSync(f.docx, 'DOCX'); writeFileSync(f.pdf, 'OLD TEXT');
    const result = await refreshLetterPdf(f.txt, { convert: async () => ({ exported: false, reason: 'no converter' }) });
    expect(existsSync(f.pdf)).toBe(false);
    expect(result).toMatchObject({ pdfPath: null, reason: 'no converter' });
  });

  it('with regenerate off (the DOCX was not refreshed) it only removes the stale PDF', async () => {
    const f = files();
    writeFileSync(f.txt, LETTER); writeFileSync(f.docx, 'STALE DOCX'); writeFileSync(f.pdf, 'OLD');
    let converted = false;
    const result = await refreshLetterPdf(f.txt, { regenerate: false, convert: async () => { converted = true; return { exported: true }; } });
    expect(converted).toBe(false);
    expect(existsSync(f.pdf)).toBe(false);
    expect(result.pdfPath).toBeNull();
  });

  it('a converter that throws is a reason, never an error', async () => {
    const f = files();
    writeFileSync(f.txt, LETTER); writeFileSync(f.docx, 'DOCX');
    const result = await refreshLetterPdf(f.txt, { convert: async () => { throw new Error('boom'); } });
    expect(result).toMatchObject({ pdfPath: null, reason: 'boom' });
  });

  it('a letter with no DOCX has nothing to render', async () => {
    const f = files();
    writeFileSync(f.txt, LETTER);
    expect((await refreshLetterPdf(f.txt, { convert: async () => { throw new Error('unreachable'); } })).pdfPath).toBeNull();
  });
});

describe('a PDF-only letter slot', () => {
  it('is given the PDF sibling instead of being blocked', () => {
    const f = files();
    writeFileSync(f.txt, LETTER); writeFileSync(f.docx, 'D'); writeFileSync(f.pdf, 'P');
    expect(fileForInput(f.txt, '.pdf')).toMatchObject({ path: f.pdf, substituted: true });
    expect(fileForInput(f.txt, '.doc,.docx')).toMatchObject({ path: f.docx });
  });

  it('is blocked, with the reason, when no PDF exists', () => {
    const f = files();
    writeFileSync(f.txt, LETTER);
    expect(fileForInput(f.txt, '.pdf')).toMatchObject({ path: null, allowed: ['.pdf'] });
  });
});

describe('editing the letter in the dashboard', () => {
  let root; let db; let dash; let folder; let calls;
  const post = (text) => fetch(`${dash.url}/api/jobs/job-1/cover-letter`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  async function boot({ docxWorks }) {
    root = mkdtempSync(join(tmpdir(), 'jobagent-letterpdf-route-'));
    folder = join(root, 'applications', 'output', 'Northwind', 'Data Engineer');
    mkdirSync(folder, { recursive: true });
    mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
    writeFileSync(join(folder, 'Cover_Letter.txt'), `${LETTER}\n`);
    writeFileSync(join(folder, 'Cover_Letter.docx'), 'OLD DOCX');
    writeFileSync(join(folder, 'Cover_Letter.pdf'), 'OLD PDF');
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'job-1', title: 'Data Engineer', company: 'Northwind', status: 'prepared', score: 82,
      cover_letter_path: join(folder, 'Cover_Letter.txt'), output_folder_path: folder });
    calls = [];
    dash = await startDashboard({
      config: { root, candidate: { identity: { fullName: 'Jordan Lee' } } }, db, logger: null, port: 0,
      deps: {
        writeLetterDocxFn: docxWorks
          ? async ({ text, path }) => { writeFileSync(path, `DOCX OF ${text.slice(0, 20)}`); return path; }
          : async () => { throw new Error('python is not installed'); },
        letterPdfFn: async (letterPath, options) => { calls.push({ letterPath, regenerate: options.regenerate }); return refreshLetterPdf(letterPath, { ...options, convert: async () => ({ exported: false, reason: 'test' }) }); },
      },
    });
  }
  afterEach(async () => { await dash?.close(); db?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

  it('a refreshed DOCX is rendered again, and the old PDF is gone first', async () => {
    await boot({ docxWorks: true });
    const edited = LETTER.replace('rebuilt the close pipeline', 'rebuilt the month-end close pipeline');
    expect((await post(edited)).status).toBe(200);
    expect(calls).toEqual([{ letterPath: join(folder, 'Cover_Letter.txt'), regenerate: true }]);
    expect(existsSync(join(folder, 'Cover_Letter.pdf'))).toBe(false); // old text never survives
    expect(readFileSync(join(folder, 'Cover_Letter.docx'), 'utf8')).toMatch(/^DOCX OF /);
  });

  it('when the DOCX could not be refreshed the PDF is removed, not rebuilt from stale text', async () => {
    await boot({ docxWorks: false });
    expect((await post(LETTER.replace('Contoso', 'Contoso Ltd'))).status).toBe(200);
    expect(calls).toEqual([{ letterPath: join(folder, 'Cover_Letter.txt'), regenerate: false }]);
    expect(existsSync(join(folder, 'Cover_Letter.pdf'))).toBe(false);
  });
});
