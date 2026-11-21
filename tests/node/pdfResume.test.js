/**
 * PDF resumes (2026-11-16): "Fill in from their resume" read only .docx, and a
 * PDF was refused outright. A PDF has no paragraphs, only text placed at
 * coordinates, so src/resume/pdfText.js rebuilds them before the same resume
 * parser reads them. These tests pin each layout rule on hand-built pdf.js
 * items, then run real PDF bytes through the reader and the dashboard route.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { extractPdfText, isPdfBuffer, paragraphsFromItems } from '../../src/resume/pdfText.js';
import { emailFromLinks, readResumeText, resumeFormat } from '../../src/resume/resumeText.js';
import { locationFrom, profileFromResume, workHistoryIn } from '../../src/profile/fromResume.js';
import { splitSections } from '../../src/resume/resumeProfile.js';
import { decodeResumeUpload } from '../../src/dashboard/httpHelpers.js';
import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { saveProfile } from '../../src/profile/store.js';
import { normalizeProfile } from '../../src/profile/model.js';
import { workspacePaths } from '../../src/profile/workspace.js';
import { makeDocx } from './fixtures/docx.js';
import { flowLines, makePdf } from './fixtures/pdf.js';

/** A pdf.js text item: `width` is the run's advance, as pdf.js reports it. */
const item = (str, x, y, { size = 10, width = str.length * size * 0.5 } = {}) => ({ str, transform: [size, 0, 0, size, x, y], width, height: size });

describe('paragraphsFromItems — rebuilding paragraphs from a PDF layout', () => {
  it('joins a bullet that wrapped onto the next line, and starts a new one at the next bullet', () => {
    const out = paragraphsFromItems([
      item('•', 50, 700), item('Reduced claim processing time by 40% by redesigning the intake workflow', 62, 700, { width: 480 }),
      item('across three regional offices.', 62, 688),
      item('•', 50, 676), item('Trained 12 new analysts on the claims platform.', 62, 676),
    ], { firstPage: false });
    expect(out).toEqual([
      'Reduced claim processing time by 40% by redesigning the intake workflow across three regional offices.',
      'Trained 12 new analysts on the claims platform.',
    ]);
  });

  it('keeps a right-aligned date on its title\'s line even when pdf.js reports the gap as one wide space', () => {
    const out = paragraphsFromItems([
      item('Senior Regulatory Specialist', 43, 600),
      item(' ', 186, 600, { width: 384 }), // pdf.js: the whole stretch as a single "space"
      item('Mar 2021 – Present', 474, 600),
      item('Northwind Medical, Chicago, IL', 43, 587),
    ], { firstPage: false });
    expect(out).toEqual(['Senior Regulatory Specialist Mar 2021 – Present', 'Northwind Medical, Chicago, IL']);
  });

  it('reads a two-column page column by column instead of row by row', () => {
    const rows = [
      ['SKILLS', 'PROFESSIONAL EXPERIENCE'],
      ['SAP S/4HANA', 'Senior Supply Chain Analyst 2021 – Present'],
      ['Demand forecasting', 'Fabrikam Logistics, Atlanta, GA'],
      ['Power BI', 'Reduced safety stock by 18% across 2,400 SKUs with a new forecast model.'],
      ['SQL', 'Supply Chain Analyst 2019 – 2021'],
      ['Lean Six Sigma', 'Tailspin Retail, Savannah, GA'],
      ['EDUCATION', 'Automated vendor scorecards in Power BI for 150 suppliers.'],
    ];
    const items = rows.flatMap(([left, right], i) => [item(left, 36, 700 - i * 13), item(right, 240, 700 - i * 13)]);
    const out = paragraphsFromItems(items, { firstPage: false });
    expect(out.slice(0, 7)).toEqual(['SKILLS', 'SAP S/4HANA', 'Demand forecasting', 'Power BI', 'SQL', 'Lean Six Sigma', 'EDUCATION']);
    expect(out[7]).toBe('PROFESSIONAL EXPERIENCE');
  });

  it('does not mistake a single column with right-aligned dates for two columns', () => {
    const items = [];
    for (let i = 0; i < 6; i += 1) {
      items.push(item(`Analyst role number ${i} | Employer ${i}`, 50, 700 - i * 40), item(`20${10 + i} – 20${11 + i}`, 500, 700 - i * 40));
      items.push(item(`Delivered a reporting project for the finance team that cut close time by ${i + 2} days.`, 50, 687 - i * 40, { width: 470 }));
    }
    const out = paragraphsFromItems(items, { firstPage: false });
    expect(out[0]).toBe('Analyst role number 0 | Employer 0 2010 – 2011');
    expect(out[1]).toMatch(/^Delivered a reporting project/);
  });

  it('puts a large name first when the contact block beside it starts higher on the page', () => {
    const out = paragraphsFromItems([
      item('dana.whitfield@example.com', 450, 752, { size: 9 }),
      item('Dana Whitfield', 40, 742, { size: 26 }),
      item('(617) 555-0147', 480, 741, { size: 9 }),
      item('Work Experience', 40, 700, { size: 11 }),
      item('Registered Nurse | Example Hospital 2019 – Present', 40, 686),
    ], { top: 792, height: 792 });
    expect(out[0]).toBe('Dana Whitfield');
    expect(out).toContain('dana.whitfield@example.com');
  });

  it('keeps labelled skill rows, headings and contact lines as separate lines', () => {
    const out = paragraphsFromItems([
      item('Alex Morgan', 50, 740),
      item('alex@example.com | linkedin.com/in/alex', 50, 728),
      item('SKILLS', 50, 700),
      item('Analytics & BI: Power BI, DAX, Semantic Models, Paginated Reports, Kimball', 50, 686, { width: 500 }),
      item('Integration & Scripting: Logic Apps, Python, REST APIs', 50, 674),
    ], { firstPage: false });
    expect(out).toEqual([
      'Alex Morgan', 'alex@example.com | linkedin.com/in/alex', 'SKILLS',
      'Analytics & BI: Power BI, DAX, Semantic Models, Paginated Reports, Kimball',
      'Integration & Scripting: Logic Apps, Python, REST APIs',
    ]);
  });

  it('cleans ligatures, icon-font glyphs and rotated margin text', () => {
    const out = paragraphsFromItems([
      item(' Ceriﬁed ﬁnancial planner', 50, 700),
      { str: 'DRAFT', transform: [0, 10, -10, 0, 20, 400], width: 30 },
    ], { firstPage: false });
    expect(out).toEqual(['Ceriﬁed ﬁnancial planner'.normalize('NFKC')]);
  });
});

describe('extractPdfText — real PDF bytes', () => {
  const RESUME = makePdf([flowLines([
    'Priya Raman',
    'Chicago, IL | (312) 555-0199 | linkedin.com/in/priyaraman',
    { text: 'EXPERIENCE', gap: 8 },
    'Senior Regulatory Specialist | Northwind Medical   Mar 2021 - Present',
    'Led 510(k) submissions for six Class II devices, achieving clearance within an average of 94',
    'days and coordinating responses to FDA reviewers.',
    'Regulatory Affairs Associate | Contoso Devices   Jun 2018 - Feb 2021',
    'Prepared technical documentation for the EU MDR transition across 40 product families.',
    { text: 'EDUCATION', gap: 8 },
    'Bachelor of Science in Biomedical Engineering | University of Illinois | 2018',
  ])], { link: 'mailto:priya.raman@example.org' });

  it('recognises a PDF by its bytes, not its name', () => {
    expect(isPdfBuffer(RESUME)).toBe(true);
    expect(resumeFormat(RESUME)).toBe('pdf');
    expect(resumeFormat(makeDocx(['A docx']))).toBe('docx');
    expect(resumeFormat(Buffer.from('plain text, not a resume'))).toBe(null);
  });

  it('reads paragraphs, the email link, and everything the profile form needs', async () => {
    const { paragraphs, links, pages } = await extractPdfText(RESUME);
    expect(pages).toBe(1);
    expect(paragraphs).toContain('Led 510(k) submissions for six Class II devices, achieving clearance within an average of 94 days and coordinating responses to FDA reviewers.');
    expect(emailFromLinks(links)).toBe('priya.raman@example.org');

    const draft = profileFromResume(paragraphs, {});
    expect(draft.identity.fullName).toBe('Priya Raman');
    expect(draft.contact.phone).toBe('(312) 555-0199');
    expect(draft.searchIntent.targetRoles).toEqual(expect.arrayContaining(['Senior Regulatory Specialist', 'Regulatory Affairs Associate']));
    expect(draft.background.workHistory.map((r) => [r.title, r.employer, r.startDate, r.current])).toEqual([
      ['Senior Regulatory Specialist', 'Northwind Medical', 'Mar 2021', true],
      ['Regulatory Affairs Associate', 'Contoso Devices', 'Jun 2018', false],
    ]);
  });

  it('refuses a PDF with no text layer (a scan) with a message that says so', async () => {
    await expect(extractPdfText(makePdf([[]]))).rejects.toMatchObject({ code: 'PDF_NO_TEXT', statusCode: 422 });
  });

  it('refuses a damaged PDF as unreadable rather than crashing', async () => {
    await expect(extractPdfText(Buffer.from('%PDF-1.4\nthis is not really a pdf'))).rejects.toMatchObject({ statusCode: 422 });
  });

  it('reads a .docx through the same entry point', async () => {
    const r = await readResumeText(makeDocx(['Alex Morgan', 'alex@example.com']));
    expect(r).toMatchObject({ format: 'docx', paragraphs: ['Alex Morgan', 'alex@example.com'] });
  });

  it('accepts a PDF upload only where the caller allows it', () => {
    const contentBase64 = RESUME.toString('base64');
    expect(() => decodeResumeUpload({ contentBase64 })).toThrow(/not a Word \(\.docx\) file/);
    expect(decodeResumeUpload({ contentBase64 }, { allowPdf: true }).equals(RESUME)).toBe(true);
    expect(() => decodeResumeUpload({ contentBase64: Buffer.from('hello').toString('base64') }, { allowPdf: true }))
      .toThrow(/not a Word \(\.docx\) or PDF file/);
  });
});

describe('workHistoryIn — a role written on one line', () => {
  it('reads "Title | Employer   dates" followed straight by bullets, for .docx and PDF alike', () => {
    const roles = workHistoryIn(splitSections([
      'WORK EXPERIENCE',
      'Registered Nurse, Cardiac ICU | Example General Hospital 2019 – Present',
      'Provided direct care for 3–4 critically ill cardiac patients per shift after surgery.',
      'Staff Nurse | Example Community Hospital | Boston, MA 2016 – 2019',
      'Managed care for 5–6 patients per shift on a 32-bed medical-surgical unit.',
    ]));
    expect(roles.map((r) => [r.title, r.employer, r.location, r.startDate, r.endDate, r.current])).toEqual([
      ['Registered Nurse', 'Example General Hospital', '', '2019', '', true],
      ['Staff Nurse', 'Example Community Hospital', 'Boston, MA', '2016', '2019', false],
    ]);
    expect(roles[0].highlights).toEqual(['Provided direct care for 3–4 critically ill cardiac patients per shift after surgery.']);
  });
});

describe('locationFrom — City and State for the form', () => {
  const at = (...header) => locationFrom(splitSections([...header, 'EXPERIENCE', 'Analyst | Acme, Denver, CO 2019 - 2021']));
  it('reads "City, ST" from the header\'s contact line', () => {
    expect(at('Jane Doe', 'Columbus, OH | 555-0142-200 | jane@example.com')).toEqual({ city: 'Columbus', state: 'OH' });
    expect(at('Jane Doe', 'jane@example.com • San Francisco, CA 94105')).toEqual({ city: 'San Francisco', state: 'CA' });
  });
  it('never takes a job\'s place, a non-state code or a title for where they live', () => {
    expect(at('Jane Doe', 'jane@example.com')).toEqual({ city: '', state: '' });
    expect(at('Jane Doe', 'Machine Learning Engineer, AI')).toEqual({ city: '', state: '' });
  });
});

/* ── the dashboard route ─────────────────────────────────────────────── */

const REPO = process.cwd();

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-pdf-resume-'));
  for (const dir of ['config/schemas', 'config/profiles', 'data', 'resumes/base']) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['scoring.json', 'exclusions.json', 'jobboards.json', 'humanizer_patterns.json', 'cover_letter.example.json', 'ats_resume.json', 'role_families.json']) {
    copyFileSync(join(REPO, 'config', file), join(root, 'config', file));
  }
  copyFileSync(join(REPO, 'config', 'cover_letter.example.json'), join(root, 'config', 'cover_letter.json'));
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.example.json'));
  copyFileSync(join(REPO, 'config', 'screening_answers.example.json'), join(root, 'config', 'screening_answers.json'));
  for (const schema of ['candidate', 'scoring', 'exclusions', 'jobboards', 'cover_letter', 'ats_resume']) {
    copyFileSync(join(REPO, 'config', 'schemas', `${schema}.schema.json`), join(root, 'config', 'schemas', `${schema}.schema.json`));
  }
  writeFileSync(join(root, '.env'), '');
  return root;
}

describe('Add profile from a PDF resume', () => {
  let root; let db; let dash;
  const call = async (method, path, body) => {
    const r = await fetch(`${dash.url}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  const PDF = makePdf([flowLines([
    'Morgan T Ellison',
    'morgan.ellison@example.com | 555-010-2233 | Raleigh, NC',
    { text: 'PROFESSIONAL EXPERIENCE', gap: 8 },
    'Senior Regulatory CMC Specialist April 2024 - Present',
    'Northwind Pharma | Raleigh, NC',
    'Authored post-approval supplements and change assessments for marketed drug products.',
  ])]);

  beforeEach(async () => {
    root = makeRoot();
    const dana = normalizeProfile({
      id: 'dana-okafor', identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.com' },
      searchIntent: { targetRoles: ['Senior Data Engineer'] },
    });
    saveProfile(root, dana);
    writeFileSync(join(root, 'config', 'profiles', '_active.json'), JSON.stringify({ id: dana.id }));
    writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(['Dana Okafor', 'Senior Data Engineer']));
    db = openDatabase({ path: ':memory:' });
    dash = await startDashboard({ config: loadConfig({ root }), db, logger: { info() {}, warn() {}, error() {}, debug() {} }, port: 0 });
  });
  afterEach(async () => { await dash?.close(); db?.close(); rmSync(root, { recursive: true, force: true }); });

  it('fills the form from a PDF and says it was a PDF', async () => {
    const read = await call('POST', '/api/search-profiles/read-resume', { contentBase64: PDF.toString('base64') });
    expect(read.status).toBe(200);
    expect(read.body.format).toBe('pdf');
    expect(read.body.fields).toMatchObject({ fullName: 'Morgan T Ellison', email: 'morgan.ellison@example.com', phone: '555-010-2233', city: 'Raleigh', state: 'NC' });
    expect(read.body.fields.targetRoles).toContain('Senior Regulatory CMC Specialist');
    expect(read.body.found.jobs).toBe(1);
  });

  it('saves their background from the PDF but keeps no master resume, since only a .docx can be tailored', async () => {
    const original = readFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'));
    const added = await call('POST', '/api/search-profiles', {
      fields: { fullName: 'Morgan Ellison', email: 'morgan.ellison@example.com', targetRoles: ['Regulatory Specialist'] },
      resume: { contentBase64: PDF.toString('base64') }, activate: false,
    });
    expect(added.status).toBe(200);
    expect(added.body.resumeSaved).toBe(false);
    expect(existsSync(workspacePaths(root, added.body.workspace).resume)).toBe(false);
    expect(readFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx')).equals(original)).toBe(true);
    const saved = JSON.parse(readFileSync(join(root, 'config', 'profiles', `${added.body.id}.json`), 'utf8'));
    expect(saved.background.workHistory[0]).toMatchObject({ title: 'Senior Regulatory CMC Specialist', employer: 'Northwind Pharma' });
  });

  it('answers a scanned PDF with a message the form can show', async () => {
    const r = await call('POST', '/api/search-profiles/read-resume', { contentBase64: makePdf([[]]).toString('base64') });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/no selectable text/);
  });

  it('still refuses anything that is neither .docx nor PDF', async () => {
    const r = await call('POST', '/api/search-profiles/read-resume', { contentBase64: Buffer.from('just text').toString('base64') });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not a Word \(\.docx\) or PDF file/);
  });
});
