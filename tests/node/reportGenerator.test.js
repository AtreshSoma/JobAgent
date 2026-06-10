import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  summarize,
  renderCsv,
  renderHtml,
  csvField,
  escapeHtml,
  generateReport,
} from '../../src/reports/reportGenerator.js';

const sampleJobs = [
  { id: 'a', source: 'greenhouse', company: 'Acme', title: 'Sr DE', score: 90, tier: 'Priority', sponsorship: 'Confirmed', url: 'http://x', missing_keywords: ['kafka'], discoveryMatch: 'strong', application_packet_path: '/p/a.json' },
  { id: 'b', source: 'lever', company: 'Globex', title: 'DE', score: 70, tier: 'Queue', sponsorship: 'Unconfirmed', missing_keywords: '["kafka","dbt"]', discoveryMatch: 'weak' },
  { id: 'c', source: 'manual', company: 'Initech', title: 'Jr DE', tier: 'Discard', discard_reason: 'role_mismatch', sponsorship: 'Unconfirmed', discoveryMatch: 'no_match' },
];

describe('reportGenerator', () => {
  it('summarize aggregates totals, tiers, discards, sponsorship, missing kw', () => {
    const s = summarize(sampleJobs);
    expect(s.totals.found).toBe(3);
    expect(s.totals.scored).toBe(2);
    expect(s.totals.priority).toBe(1);
    expect(s.totals.queued).toBe(1);
    expect(s.totals.discarded).toBe(1);
    expect(s.discardReasons.role_mismatch).toBe(1);
    expect(s.sponsorship.Confirmed).toBe(1);
    expect(s.sponsorship.Unconfirmed).toBe(2);
    const kafka = s.missingKeywords.find((m) => m.key === 'kafka');
    expect(kafka.count).toBe(2);
    expect(s.topJobs[0].id).toBe('a'); // highest score first
  });

  it('summarize breaks down by source and discovery match', () => {
    const s = summarize(sampleJobs);
    expect(s.bySource.greenhouse).toMatchObject({ found: 1, kept: 1, discarded: 0, prepared: 1 });
    expect(s.bySource.lever).toMatchObject({ found: 1, kept: 1, discarded: 0 });
    expect(s.bySource.manual).toMatchObject({ found: 1, kept: 0, discarded: 1 });
    expect(s.byDiscovery).toMatchObject({ strong: 1, weak: 1, no_match: 1 });
    expect(s.totals.weakMatch).toBe(1);
    expect(s.totals.prepared).toBe(1);
  });

  it('renderHtml includes the by-source breakdown', () => {
    const html = renderHtml(summarize(sampleJobs));
    expect(html).toContain('By source');
    expect(html).toContain('greenhouse');
  });

  it('csvField escapes commas, quotes, newlines', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('escapeHtml escapes dangerous characters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('renderCsv has a header and a row per job', () => {
    const csv = renderCsv(sampleJobs);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('company');
    expect(lines).toHaveLength(4);
  });

  it('renderHtml escapes job content to prevent injection', () => {
    const html = renderHtml(summarize([
      { id: 'x', company: '<b>Evil</b>', title: 'DE', score: 80, tier: 'Apply', sponsorship: 'Likely' },
    ]));
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt;');
    expect(html).not.toContain('<b>Evil</b>');
  });

  it('generateReport writes json, csv, and html files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobagent-report-'));
    try {
      const { files, summary } = generateReport({ jobs: sampleJobs, outDir: dir, stamp: 'TEST' });
      expect(files.json).toContain('report-TEST.json');
      const parsed = JSON.parse(readFileSync(files.json, 'utf8'));
      expect(parsed.totals.found).toBe(3);
      expect(readFileSync(files.csv, 'utf8')).toContain('Acme');
      expect(readFileSync(files.html, 'utf8')).toContain('job-agent report');
      expect(summary.totals.found).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
