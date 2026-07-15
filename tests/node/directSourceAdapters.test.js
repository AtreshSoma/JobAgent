/**
 * Contract tests for the DIRECT LinkedIn / Indeed / Dice connectors.
 *
 * These connectors are deliberately limited: they read ONLY public posting
 * pages supplied as URLs (parsing schema.org JobPosting JSON-LD) and never log
 * in, automate a search feed, or evade protection. The contract pinned here:
 *   1. a public URL with JSON-LD maps to a normalized job for that source;
 *   2. query-based discovery is refused HONESTLY (an explanatory error entry,
 *      never a silent empty success);
 *   3. one bad URL never poisons the others (per-URL error isolation).
 *
 * Query-style discovery for these boards runs through the Apify provider
 * adapter instead (see searchAdapters.test.js).
 */
import { describe, it, expect } from 'vitest';

import * as linkedin from '../../src/search/adapters/linkedin.js';
import * as indeed from '../../src/search/adapters/indeed.js';
import * as dice from '../../src/search/adapters/dice.js';

const ADAPTERS = [
  [linkedin, 'linkedin', 'https://www.linkedin.com/jobs/view/4012'],
  [indeed, 'indeed', 'https://www.indeed.com/viewjob?jk=ab12'],
  [dice, 'dice', 'https://www.dice.com/job-detail/f00d'],
];

/** A minimal public posting page with schema.org JobPosting JSON-LD. */
function postingHtml({ title = 'Senior Data Engineer', company = 'Acme' } = {}) {
  const ld = {
    '@context': 'https://schema.org', '@type': 'JobPosting',
    title,
    hiringOrganization: { '@type': 'Organization', name: company },
    jobLocation: { address: { addressLocality: 'Raleigh', addressRegion: 'NC' } },
    datePosted: '2026-07-11',
    description: 'Azure Databricks, PySpark, Delta Lake. H-1B sponsorship available.',
    employmentType: 'FULL_TIME',
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body>Apply</body></html>`;
}

const okFetch = (html) => async () => ({ ok: true, status: 200, text: async () => html });

describe.each(ADAPTERS)('%#: direct %s connector', (adapter, sourceId, sampleUrl) => {
  it(`parses a public ${sourceId} posting URL into a normalized ${sourceId} job`, async () => {
    const { jobs, errors } = await adapter.run(
      { urls: [sampleUrl] },
      { fetchImpl: okFetch(postingHtml()), maxRetries: 1 },
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe(sourceId);
    expect(jobs[0].title).toBe('Senior Data Engineer');
    expect(jobs[0].company).toBe('Acme');
    expect(jobs[0].postedAt).toContain('2026-07-11');
    expect(adapter.adapterId).toBe(sourceId);
  });

  it('refuses query-based discovery honestly instead of silently returning nothing', async () => {
    const { jobs, errors } = await adapter.run(
      { queries: ['senior data engineer'] },
      { fetchImpl: okFetch(postingHtml()), maxRetries: 1 },
    );
    expect(jobs).toEqual([]);
    expect(errors).toHaveLength(1);
    // The refusal must explain WHY and WHAT to do — and never suggest evasion.
    expect(errors[0].note).toMatch(/urls/i);
    expect(errors[0].note).not.toMatch(/bypass|stealth/i);
  });

  it('isolates a failing URL: healthy URLs still produce jobs', async () => {
    const badUrl = sampleUrl + '-broken';
    const fetchImpl = async (url) => (url === badUrl
      ? { ok: false, status: 403, text: async () => '' }
      : { ok: true, status: 200, text: async () => postingHtml() });
    const { jobs, errors } = await adapter.run(
      { urls: [badUrl, sampleUrl] },
      { fetchImpl, maxRetries: 1 },
    );
    expect(jobs).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].url).toBe(badUrl);
    expect(errors[0].error).toMatch(/403/);
  });
});
