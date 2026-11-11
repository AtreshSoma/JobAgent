import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { csvCell } from '../../src/reports/csv.js';
import { csvField, pruneReports } from '../../src/reports/reportGenerator.js';
import { exportRowsToCsv } from '../../src/dashboard/data.js';
import { extractDocxText } from '../../src/resume/docxText.js';

describe('csv — one encoder, formula injection neutralized', () => {
  it('prefixes cells that a spreadsheet would execute', () => {
    for (const bad of ['=HYPERLINK("x")', '+1', '-2+3', '@SUM(A1)', '\tx', '\rx']) {
      expect(csvCell(bad).replace(/^"/, '')).toMatch(/^'/);
    }
    expect(csvCell('=a,b')).toBe('"\'=a,b"');
    expect(csvCell(-5)).toBe('-5'); // numbers are data
    expect(csvCell(null)).toBe('');
    expect(csvCell(['a', 'b'])).toBe('a; b');
    expect(csvField).toBe(csvCell);
  });

  it('the dashboard export uses it', () => {
    const csv = exportRowsToCsv([{ company: '=cmd|calc', title: 'Engineer' }]);
    expect(csv).toContain("'=cmd|calc");
  });
});

/** A minimal ZIP holding one deflated word/document.xml entry. */
function zipWith(xmlBytes) {
  const name = Buffer.from('word/document.xml');
  const data = deflateRawSync(xmlBytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(xmlBytes.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(xmlBytes.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
  const dirOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12); eocd.writeUInt32LE(dirOffset, 16);
  return Buffer.concat([local, name, data, central, name, eocd]);
}

describe('docxText — decompression is bounded', () => {
  it('reads a normal document', () => {
    const doc = zipWith(Buffer.from('<w:document><w:p><w:t>Hello resume</w:t></w:p></w:document>'));
    expect(extractDocxText(doc).text).toBe('Hello resume');
  });

  it('refuses a zip bomb with a 422 "resume too large when decompressed"', () => {
    const bomb = zipWith(Buffer.alloc(65 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(1024 * 1024);
    try { extractDocxText(bomb); throw new Error('no'); } catch (err) {
      expect(err.message).toBe('resume too large when decompressed');
      expect(err.statusCode).toBe(422);
    }
  });
});

describe('reports — rotation keeps the last 14 local days', () => {
  it('deletes only old report-YYYYMMDD files and never the one just written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobagent-reports-'));
    for (const n of ['report-20260801.csv', 'report-20260908.json', 'report-20260909.html', 'report-20260922.csv',
      'report-20260101.json', 'audit-2026.html']) writeFileSync(join(dir, n), 'x');
    const removed = pruneReports(dir, { now: new Date('2026-09-22T12:00:00Z'), timeZone: 'UTC', keep: '20260101' });
    expect(removed.sort()).toEqual(['report-20260801.csv', 'report-20260908.json']);
    expect(readdirSync(dir).sort()).toEqual(['audit-2026.html', 'report-20260101.json', 'report-20260909.html', 'report-20260922.csv']);
    rmSync(dir, { recursive: true, force: true });
  });
});
