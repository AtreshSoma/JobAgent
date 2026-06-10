import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

import { migrate } from '../../scripts/migrateOutputNames.js';
import { openDatabase } from '../../src/logging/db.js';

let root;
let db;

const JOB_ID = 'greenhouse:databricks::lakebase::123';

function write(rel, content) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'migrate-test-'));
  mkdirSync(join(root, 'resumes', 'output'), { recursive: true });
  mkdirSync(join(root, 'data', 'packets'), { recursive: true });
  mkdirSync(join(root, 'applications', 'output'), { recursive: true });
  writeFileSync(join(root, 'resumes', 'output', '.gitkeep'), '');
  db = openDatabase({ path: ':memory:' });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function seedDatabricks() {
  const docx = write('resumes/output/databricks_lakebase-sales-specialist-retail_20260606.docx', 'DOCX');
  write('resumes/output/databricks_lakebase-sales-specialist-retail_20260606.pdf', 'PDF');
  const txt = write('resumes/output/databricks_lakebase-sales-specialist-retail_20260606.txt', 'COVER');
  const packet = {
    id: 'uuid-databricks',
    createdAt: '2026-06-06T03:59:22.271Z',
    job: { id: JOB_ID, company: 'Databricks', title: 'Lakebase Sales Specialist - Retail' },
    resumePath: docx,
    coverLetterPath: txt,
    uploads: { uploads: [{ type: 'resume', path: docx, name: basename(docx) }] },
    fillPlan: { uploads: [{ type: 'resume', path: docx, selector: 'input[type="file"]' }] },
  };
  write('data/packets/uuid-databricks.json', JSON.stringify(packet, null, 2));
  db.upsertJob({ id: JOB_ID, company: 'Databricks', title: 'Lakebase Sales Specialist - Retail', status: 'prepared' });
}

describe('migrateOutputNames', () => {
  it('migrates docx/pdf/txt into one professional job folder and rewrites the packet', () => {
    seedDatabricks();
    const report = migrate({ root, apply: true, candidateName: 'Atresh Somayajula', db, writeReport: false });

    const folder = join(root, 'applications', 'output', 'Databricks', 'Lakebase Sales Specialist - Retail_2026-06-06');
    expect(existsSync(join(folder, 'Atresh_Somayajula_Resume_Lakebase_Sales_Specialist_Retail.docx'))).toBe(true);
    expect(existsSync(join(folder, 'Atresh_Somayajula_Resume_Lakebase_Sales_Specialist_Retail.pdf'))).toBe(true);
    expect(existsSync(join(folder, 'Atresh_Somayajula_Cover_Letter_Lakebase_Sales_Specialist_Retail.txt'))).toBe(true);
    expect(existsSync(join(folder, 'Application_Packet_Databricks_Lakebase_Sales_Specialist_Retail.json'))).toBe(true);

    // Packet internal paths rewritten to the new location.
    const packet = JSON.parse(readFileSync(join(folder, 'Application_Packet_Databricks_Lakebase_Sales_Specialist_Retail.json'), 'utf8'));
    expect(packet.resumePath).toBe(join(folder, 'Atresh_Somayajula_Resume_Lakebase_Sales_Specialist_Retail.docx'));
    expect(packet.uploads.uploads[0].path).toBe(packet.resumePath);
    expect(packet.uploads.uploads[0].name).toBe('Atresh_Somayajula_Resume_Lakebase_Sales_Specialist_Retail.docx');
    expect(packet.coverLetterPath).toBe(join(folder, 'Atresh_Somayajula_Cover_Letter_Lakebase_Sales_Specialist_Retail.txt'));

    expect(report.counts.resumes).toBe(2);
    expect(report.counts.coverLetters).toBe(1);
    expect(report.counts.packets).toBe(1);
  });

  it('updates the database paths for the migrated job', () => {
    seedDatabricks();
    migrate({ root, apply: true, candidateName: 'Atresh Somayajula', db, writeReport: false });

    const job = db.getJob(JOB_ID);
    const folder = join(root, 'applications', 'output', 'Databricks', 'Lakebase Sales Specialist - Retail_2026-06-06');
    expect(job.output_folder_path).toBe(folder);
    expect(job.application_packet_path).toBe(join(folder, 'Application_Packet_Databricks_Lakebase_Sales_Specialist_Retail.json'));
    expect(job.resume_docx_path).toBe(join(folder, 'Atresh_Somayajula_Resume_Lakebase_Sales_Specialist_Retail.docx'));
    expect(job.resume_pdf_path).toBe(join(folder, 'Atresh_Somayajula_Resume_Lakebase_Sales_Specialist_Retail.pdf'));
    expect(job.cover_letter_path).toBe(join(folder, 'Atresh_Somayajula_Cover_Letter_Lakebase_Sales_Specialist_Retail.txt'));
  });

  it('de-slugs resume files that have no matching packet (acronyms preserved)', () => {
    write('resumes/output/assa-abloy-group_bi-analyst-developer_20260607.docx', 'DOCX');
    const report = migrate({ root, apply: true, candidateName: 'Atresh Somayajula', db, writeReport: false });

    const folder = join(root, 'applications', 'output', 'Assa Abloy Group', 'BI Analyst Developer_2026-06-07');
    expect(existsSync(join(folder, 'Atresh_Somayajula_Resume_BI_Analyst_Developer.docx'))).toBe(true);
    expect(report.counts.resumes).toBe(1);
  });

  it('routes unparseable resume files and bad packets to _Needs_Review', () => {
    write('resumes/output/not-a-valid-name.docx', 'DOCX');
    write('data/packets/broken.json', '{ this is not json ');
    write('data/packets/nocompany.json', JSON.stringify({ id: 'x', job: { id: 'j2' } }));

    const report = migrate({ root, apply: true, candidateName: 'Atresh Somayajula', db, writeReport: false });
    const reviewDir = join(root, 'applications', 'output', '_Needs_Review');
    expect(existsSync(join(reviewDir, 'not-a-valid-name.docx'))).toBe(true);
    expect(existsSync(join(reviewDir, 'broken.json'))).toBe(true);
    expect(existsSync(join(reviewDir, 'nocompany.json'))).toBe(true);
    expect(report.counts.needsReview).toBe(3);
  });

  it('never overwrites a destination — appends _v2 on collision', () => {
    seedDatabricks();
    // A second packet for the same company/title/date collides on the packet name.
    const second = {
      id: 'uuid-databricks-2',
      createdAt: '2026-06-06T10:00:00.000Z',
      job: { id: 'greenhouse:databricks::lakebase::999', company: 'Databricks', title: 'Lakebase Sales Specialist - Retail' },
      resumePath: null,
    };
    write('data/packets/uuid-databricks-2.json', JSON.stringify(second));

    migrate({ root, apply: true, candidateName: 'Atresh Somayajula', db, writeReport: false });
    const folder = join(root, 'applications', 'output', 'Databricks', 'Lakebase Sales Specialist - Retail_2026-06-06');
    expect(existsSync(join(folder, 'Application_Packet_Databricks_Lakebase_Sales_Specialist_Retail.json'))).toBe(true);
    expect(existsSync(join(folder, 'Application_Packet_Databricks_Lakebase_Sales_Specialist_Retail_v2.json'))).toBe(true);
  });

  it('leaves resumes/output containing only .gitkeep and removes empty data/packets', () => {
    seedDatabricks();
    write('resumes/output/not-a-valid-name.docx', 'DOCX'); // leftover routed to review

    migrate({ root, apply: true, candidateName: 'Atresh Somayajula', db, writeReport: false });

    expect(readdirSync(join(root, 'resumes', 'output'))).toEqual(['.gitkeep']);
    expect(existsSync(join(root, 'data', 'packets'))).toBe(false);
  });

  it('dry-run changes nothing on disk', () => {
    seedDatabricks();
    const before = readdirSync(join(root, 'resumes', 'output')).sort();
    const report = migrate({ root, apply: false, candidateName: 'Atresh Somayajula', db, writeReport: false });

    expect(readdirSync(join(root, 'resumes', 'output')).sort()).toEqual(before);
    expect(existsSync(join(root, 'data', 'packets', 'uuid-databricks.json'))).toBe(true);
    // The plan is still reported.
    expect(report.counts.packets).toBe(1);
    expect(report.moves.length).toBeGreaterThan(0);
  });

  it('writes a dated migration report to reports/', () => {
    seedDatabricks();
    const report = migrate({ root, apply: true, candidateName: 'Atresh Somayajula', db, now: new Date('2026-06-07T00:00:00Z') });
    const expected = join(root, 'reports', 'output_migration_report_2026-06-07.json');
    expect(report.reportPath).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });
});
