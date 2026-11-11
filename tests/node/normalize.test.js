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

  it('htmlToText decodes numeric and typographic entities without double-decoding', () => {
    expect(htmlToText('We can&#8217;t sponsor &mdash; don&rsquo;t &#x2014; ok'))
      .toBe('We can’t sponsor — don’t — ok');
    // An encoded ampersand never combines into a second entity.
    expect(htmlToText('A&amp;rsquo;B &#38;lt;')).toBe('A&rsquo;B &lt;');
    // Unknown names and invalid code points stay as written.
    expect(htmlToText('&bogus; &#0;')).toBe('&bogus; &#0;');
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
