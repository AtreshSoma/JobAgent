/**
 * Master resume: the zero-dependency DOCX reader, and the dashboard routes that
 * view / download / replace / roll back the one document every tailored resume
 * is built from.
 *
 * The safety properties asserted here are the reason this feature can exist at
 * all: a bad upload must be refused BEFORE anything is overwritten, and a good
 * upload must always leave the outgoing version recoverable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { buildMasterResume } from '../../src/dashboard/data.js';
import {
  extractDocxText, isDocxBuffer, paragraphsFromDocumentXml,
} from '../../src/resume/docxText.js';

/* ─────────────────────────── zip fixtures ─────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Build a real ZIP so the reader is exercised against the format, not a mock.
 * @param {Array<{name: string, data: Buffer, deflate?: boolean}>} entries
 */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const stored = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(entry.data), 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(entry.data), 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + stored.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

const paragraphXml = (lines) => lines
  .map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`)
  .join('');

/** A .docx with the given paragraphs, structured like Word writes them. */
function makeDocx(lines, { deflate = true } = {}) {
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${paragraphXml(lines)}</w:body></w:document>`;
  return zip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>', 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8'), deflate },
  ]);
}

const RESUME_LINES = [
  'ATRESH SOMAYAJULA',
  'Senior Data Engineer',
  'EXPERIENCE',
  'Built streaming pipelines in Spark and Kafka that moved twelve billion events per day.',
  'Modelled the warehouse in dbt on Snowflake and cut the nightly batch from six hours to forty minutes.',
  'SKILLS',
  'Python, SQL, Airflow, Spark, dbt, Snowflake, AWS, Terraform, Kafka, Databricks',
];

/* ───────────────────────────── the reader ───────────────────────────── */

describe('docx text reader', () => {
  it('reads paragraph text out of a deflated document', () => {
    const result = extractDocxText(makeDocx(RESUME_LINES));
    expect(result.paragraphs).toEqual(RESUME_LINES);
    expect(result.wordCount).toBeGreaterThan(40);
    expect(result.text).toContain('Snowflake');
  });

  it('reads a stored (uncompressed) document too', () => {
    const result = extractDocxText(makeDocx(RESUME_LINES, { deflate: false }));
    expect(result.paragraphs).toEqual(RESUME_LINES);
  });

  it('decodes entities and treats tabs and breaks as Word does', () => {
    expect(paragraphsFromDocumentXml(
      '<w:p><w:r><w:t>R&amp;D</w:t><w:tab/><w:t>2020&#8211;2024</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t></w:r></w:p>',
    )).toEqual(['R&D 2020–2024', 'one', 'two']);
  });

  it('ignores deleted revisions rather than reporting removed text as content', () => {
    expect(paragraphsFromDocumentXml(
      '<w:p><w:r><w:t>kept</w:t></w:r><w:del><w:r><w:delText>removed</w:delText></w:r></w:del></w:p>',
    )).toEqual(['kept']);
  });

  it('keeps table cells on separate lines', () => {
    expect(paragraphsFromDocumentXml(
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Left</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>Right</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    )).toEqual(['Left', 'Right']);
  });

  it('rejects things that are not Word documents, with a reason', () => {
    expect(() => extractDocxText(Buffer.from('%PDF-1.7 not a docx at all'))).toThrow(/not a \.docx/);
    expect(() => extractDocxText(Buffer.alloc(0))).toThrow(/empty or too small/);
    expect(() => extractDocxText(zip([{ name: 'other.xml', data: Buffer.from('<x/>') }])))
      .toThrow(/not a Word document/);
    const truncated = makeDocx(RESUME_LINES).subarray(0, 40);
    expect(() => extractDocxText(truncated)).toThrow();
  });

  it('recognizes the docx magic bytes without unzipping', () => {
    expect(isDocxBuffer(makeDocx(['x']))).toBe(true);
    expect(isDocxBuffer(Buffer.from('%PDF-1.7'))).toBe(false);
    expect(isDocxBuffer(Buffer.from([0x50, 0x4b]))).toBe(false);
  });
});

/* ──────────────────────────── the API ──────────────────────────── */

describe('master resume API', () => {
  let root;
  let db;
  let dash;
  const masterPath = () => join(root, 'resumes', 'base', 'MASTER_RESUME.docx');
  const historyDir = () => join(root, 'resumes', 'base', 'history');
  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const upload = (buffer, filename = 'MASTER_RESUME.docx') => post('/api/master-resume', {
    filename, contentBase64: buffer.toString('base64'),
  });

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'jobagent-master-'));
    db = openDatabase({ path: ':memory:' });
    dash = await startDashboard({ config: { root }, db, logger: null, port: 0 });
  });
  afterEach(async () => {
    await dash.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a missing master resume as a normal, explained state', async () => {
    const { status, body } = await get('/api/master-resume');
    expect(status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.exists).toBe(false);
    expect(body.relativePath).toMatch(/MASTER_RESUME\.docx$/);
    expect(body.backups).toEqual([]);
  });

  it('installs a first master resume with no backup to keep', async () => {
    const { status, body } = await upload(makeDocx(RESUME_LINES));
    expect(status).toBe(200);
    expect(body.replaced).toBe(true);
    expect(body.backup).toBe(null);
    expect(existsSync(masterPath())).toBe(true);
    expect(body.master.exists).toBe(true);
    expect(body.master.wordCount).toBeGreaterThan(40);
    // The user can read the document the tailor will read, not just its name.
    expect(body.master.paragraphs).toContain('ATRESH SOMAYAJULA');
  });

  it('keeps the outgoing version on every replacement, and can restore it', async () => {
    await upload(makeDocx(RESUME_LINES));
    const second = makeDocx([...RESUME_LINES, 'Led the migration to Iceberg across four teams.']);
    const replaced = await upload(second);
    expect(replaced.body.backup).toMatch(/^MASTER_RESUME\..+\.docx$/);
    expect(readFileSync(masterPath()).equals(second)).toBe(true);
    expect(readdirSync(historyDir())).toHaveLength(1);

    const listed = await get('/api/master-resume');
    expect(listed.body.backups).toHaveLength(1);
    expect(listed.body.paragraphs).toContain('Led the migration to Iceberg across four teams.');

    const restored = await post('/api/master-resume/restore', { name: listed.body.backups[0].name });
    expect(restored.status).toBe(200);
    expect(restored.body.restored).toBe(listed.body.backups[0].name);
    // Restoring is itself undoable: the version it replaced was kept too.
    expect(restored.body.master.paragraphs).not.toContain('Led the migration to Iceberg across four teams.');
    expect(readdirSync(historyDir())).toHaveLength(2);
  });

  it('refuses a file that is not really a .docx without touching the current one', async () => {
    await upload(makeDocx(RESUME_LINES));
    const before = readFileSync(masterPath());

    const renamedPdf = await upload(Buffer.from('%PDF-1.7 this is a pdf pretending to be a resume'));
    expect(renamedPdf.status).toBe(415);
    expect(renamedPdf.body.error).toMatch(/not a \.docx/);

    const wrongExtension = await upload(makeDocx(RESUME_LINES), 'resume.pdf');
    expect(wrongExtension.status).toBe(400);

    const empty = await upload(makeDocx(['Resume']));
    expect(empty.status).toBe(422);
    expect(empty.body.error).toMatch(/words of text/);

    const corrupt = await upload(Buffer.concat([makeDocx(RESUME_LINES).subarray(0, 60), Buffer.alloc(400)]));
    expect(corrupt.status).toBe(422);

    // Nothing above was allowed to disturb the installed resume, and no
    // spurious backup was taken for a rejected upload.
    expect(readFileSync(masterPath()).equals(before)).toBe(true);
    expect(readdirSync(historyDir())).toHaveLength(0);
  });

  it('rejects mangled transfers instead of installing a corrupt resume', async () => {
    const { status, body } = await post('/api/master-resume', {
      filename: 'MASTER_RESUME.docx', contentBase64: 'not base64 !!!',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/not transferred correctly/);
    expect(existsSync(masterPath())).toBe(false);
  });

  it('never restores a path outside the kept-version directory', async () => {
    await upload(makeDocx(RESUME_LINES));
    for (const name of ['../../MASTER_RESUME.docx', '..\\MASTER_RESUME.docx', 'evil.docx', '']) {
      const res = await post('/api/master-resume/restore', { name });
      expect(res.status, `accepted "${name}"`).toBe(400);
    }
  });

  it('downloads the master resume as an attachment, never inline', async () => {
    expect((await fetch(dash.url + '/api/master-resume/file')).status).toBe(404);
    await upload(makeDocx(RESUME_LINES));
    const res = await fetch(dash.url + '/api/master-resume/file');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/wordprocessingml\.document/);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await res.arrayBuffer()).length).toBeGreaterThan(100);
  });

  it('rejects an upload that exceeds the size limit', async () => {
    // Padding the archive's trailing bytes keeps it a valid ZIP while making
    // the payload big enough to trip the limit.
    const big = Buffer.concat([makeDocx(RESUME_LINES), Buffer.alloc(9 * 1024 * 1024)]);
    const { status } = await upload(big);
    expect([413, 415]).toContain(status);
    expect(existsSync(masterPath())).toBe(false);
  });

  it('flags a present-but-unreadable master instead of pretending it is fine', async () => {
    mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
    writeFileSync(masterPath(), 'this was saved as .doc and renamed');
    const { body } = await get('/api/master-resume');
    expect(body.exists).toBe(true);
    expect(body.textError).toMatch(/not a \.docx/);
    expect(body.wordCount).toBe(null);
  });

  it('explains itself when no workspace root is configured', async () => {
    const other = await startDashboard({ config: {}, db, logger: null, port: 0 });
    try {
      const res = await fetch(other.url + '/api/master-resume').then((r) => r.json());
      expect(res.available).toBe(false);
      expect(res.reason).toMatch(/no workspace root/);
      const upload503 = await fetch(other.url + '/api/master-resume', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: 'a.docx', contentBase64: makeDocx(RESUME_LINES).toString('base64') }),
      });
      expect(upload503.status).toBe(503);
    } finally {
      await other.close();
    }
  });
});

/* ─────────────────────── the data layer directly ─────────────────────── */

describe('buildMasterResume', () => {
  it('counts tailored resumes that predate the current master as stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'jobagent-stale-'));
    const db = openDatabase({ path: ':memory:' });
    try {
      mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
      writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(RESUME_LINES));
      db.upsertJob({
        id: 'old', company: 'A', title: 'T', url: 'http://a',
        resume_docx_path: '/out/old.docx', prepared_at: '2020-01-01T00:00:00Z',
        application_packet_path: '/out/old.json',
      });
      db.upsertJob({
        id: 'fresh', company: 'B', title: 'T', url: 'http://b',
        resume_docx_path: '/out/new.docx', prepared_at: '2999-01-01T00:00:00Z',
        application_packet_path: '/out/new.json',
      });
      const master = buildMasterResume(db, { root });
      expect(master.exists).toBe(true);
      expect(master.stalePackets).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('truncates a long preview rather than shipping a whole document', () => {
    const root = mkdtempSync(join(tmpdir(), 'jobagent-long-'));
    const db = openDatabase({ path: ':memory:' });
    try {
      mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
      const lines = Array.from({ length: 30 }, (_, i) => `Bullet number ${i} about pipelines`);
      writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), makeDocx(lines));
      const master = buildMasterResume(db, { root, previewParagraphs: 10 });
      expect(master.paragraphs).toHaveLength(10);
      expect(master.truncated).toBe(true);
      expect(master.wordCount).toBeGreaterThan(100);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
