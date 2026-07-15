import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeJob,
  makeJobId,
  htmlToText,
  parseJsonLdJobs,
  extractJsonLdBlocks,
  parseCsv,
} from '../../src/search/normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (f) => readFileSync(join(__dirname, 'fixtures', f), 'utf8');

describe('normalize', () => {
  it('normalizeJob fills the canonical shape and a stable id', () => {
    const j = normalizeJob({ source: 'dice', company: ' Acme ', title: 'SDE', sourceJobId: 'X1' });
    expect(j).toMatchObject({
      source: 'dice', company: 'Acme', title: 'SDE', sourceJobId: 'X1',
      applicantCount: null, rawMetadata: {},
    });
    expect(j.id).toBe(makeJobId(j));
    // Same logical job -> same id regardless of casing/spacing.
    const j2 = normalizeJob({ source: 'dice', company: 'ACME', title: 'sde', sourceJobId: 'x1' });
    expect(j2.id).toBe(j.id);
  });

  it('htmlToText strips tags and decodes entities', () => {
    expect(htmlToText('<p>Hello&nbsp;<b>World</b></p>')).toBe('Hello World');
    expect(htmlToText('a<br>b')).toBe('a\nb');
  });

  it('parseJsonLdJobs extracts a JobPosting from a real-ish page', () => {
    const jobs = parseJsonLdJobs(fixture('jobposting.html'), { source: 'public', url: 'http://x' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: 'Senior Data Engineer',
      company: 'Acme Analytics',
      sourceJobId: 'REQ-1001',
      employmentType: 'FULL_TIME',
    });
    expect(jobs[0].location).toBe('Raleigh, NC, US');
    expect(jobs[0].jdText).toContain('Azure');
    expect(jobs[0].postedAt).toBe('2026-05-28');
  });

  it('parseJsonLdJobs safely handles identifier union shapes', () => {
    const posting = (identifier) => `<script type="application/ld+json">${JSON.stringify({
      '@type': 'JobPosting',
      title: 'Data Engineer',
      hiringOrganization: { name: 'Acme' },
      identifier,
    })}</script>`;

    expect(parseJsonLdJobs(posting({ propertyID: 'Acme', value: 'REQ-42' }))[0].sourceJobId)
      .toBe('REQ-42');
    expect(parseJsonLdJobs(posting([{ propertyID: 'empty' }, { '@id': 'REQ-43' }]))[0].sourceJobId)
      .toBe('REQ-43');
    expect(parseJsonLdJobs(posting({ propertyID: 'Acme' }))[0].sourceJobId)
      .toBe('');
  });

  it('extractJsonLdBlocks ignores malformed JSON-LD', () => {
    const html = '<script type="application/ld+json">{bad json}</script>' +
      '<script type="application/ld+json">{"@type":"JobPosting","title":"X"}</script>';
    const blocks = extractJsonLdBlocks(html);
    expect(blocks).toHaveLength(1);
  });

  it('parseCsv handles quoted fields with commas', () => {
    const rows = parseCsv(fixture('manual_jobs.csv'));
    expect(rows).toHaveLength(2);
    expect(rows[0].company).toBe('Globex');
    expect(rows[0].location).toBe('Remote, US');
  });
});
