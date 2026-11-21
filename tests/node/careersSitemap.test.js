/**
 * Audit D3/D4 (docs/audits/2026-11-20-discovery-coverage.md): the careers
 * sitemap strategy read the first 50 URLs in file order, dropped every undated
 * page, and gave pages without JSON-LD colliding ids. All fixtures here are
 * fictional companies.
 */
import { describe, it, expect } from 'vitest';

import * as careers from '../../src/search/adapters/careersPage.js';
import { createSitemapSeen } from '../../src/search/sitemapSeen.js';
import { profileVocabularyFor } from '../../src/scoring/profileFit.js';
import { normalizeJob } from '../../src/search/normalize.js';
import { loadTestConfig } from './helpers/testConfig.js';

const base = loadTestConfig({ loadEnv: false, env: {} });
const vocab = profileVocabularyFor(base.candidate);
const geography = { ...(base.exclusions?.geography ?? {}), usOnly: true };

const sitemap = (entries) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
  entries.map(([loc, lastmod]) => `<url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`).join('')
}</urlset>`;
const jsonLdPage = ({ title, location = 'Redmond, WA, United States', datePosted = '2026-06-08', id = '' }) => `<html><head>
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'JobPosting', title, datePosted,
  ...(id ? { identifier: { value: id } } : {}),
  hiringOrganization: { name: 'Contoso' },
  jobLocation: { address: { addressLocality: location } },
  description: `${title}: build Azure Databricks and Microsoft Fabric pipelines with PySpark and SQL.`,
})}</script></head><body>${title}</body></html>`;
const res = (body, status = 200) => ({ ok: status < 400, status, text: async () => body, json: async () => JSON.parse(body) });

describe('slugText', () => {
  it('reads title and place words from a posting URL', () => {
    expect(careers.slugText('https://jobs.contoso.example/careers/job/1970393557072567-senior-data-engineer-united-states-washington-redmond?domain=contoso.example'))
      .toBe('senior data engineer united states washington redmond');
    expect(careers.slugText('https://jobs.fruit.example/en-us/details/200632290-0240/sr-data-engineer-insights'))
      .toBe('sr data engineer insights');
    expect(careers.slugText('https://careers.example.com/job/Seattle%2C-WA-Data-Engineer/1456099733/'))
      .toBe('seattle wa data engineer');
  });

  it('returns nothing for id-only paths', () => {
    expect(careers.slugText('https://careers.example.com/jobs/123456')).toBe('');
  });
});

describe('extractSitemapEntries', () => {
  it('keeps lastmod with each loc and decodes entities', () => {
    const xml = sitemap([['https://x.example/job/1?a=1&amp;b=2', '2026-06-01'], ['https://x.example/job/2', null]]);
    expect(careers.extractSitemapEntries(xml)).toEqual([
      { loc: 'https://x.example/job/1?a=1&b=2', lastmod: '2026-06-01' },
      { loc: 'https://x.example/job/2', lastmod: null },
    ]);
  });
});

describe('planSitemapUrls', () => {
  const entries = [
    { loc: 'https://c.example/careers/job/1-retail-store-associate-united-states-texas-austin', lastmod: '2026-06-09' },
    { loc: 'https://c.example/careers/job/2-senior-data-engineer-india-karnataka-bangalore', lastmod: '2026-06-09' },
    { loc: 'https://c.example/careers/job/3-data-engineer-united-states-new-york', lastmod: '2026-06-01' },
    { loc: 'https://c.example/careers/job/4-senior-data-engineer-united-states-washington-redmond', lastmod: '2026-06-09' },
    { loc: 'https://c.example/careers/job/5-lead-data-engineer-united-states-remote', lastmod: '2026-06-05' },
    { loc: 'https://c.example/careers/job/6-principal-data-engineer-united-states-remote', lastmod: '2026-06-04' },
  ];

  it('drops off-profile and foreign slugs before any fetch, newest first', () => {
    const plan = careers.planSitemapUrls(entries, { vocab, geography, minTitleFit: 2, maxFetches: 10 });
    // Equal title fit here, so newest lastmod decides.
    expect(plan.fetch.map((u) => u.match(/job\/(\d)/)[1])).toEqual(['4', '5', '6', '3']);
    expect(plan.counts).toMatchObject({ total: 6, offTarget: 1, abroad: 1 });
  });

  it('re-reads an active row that has no stored description', () => {
    const known = (url) => (url.includes('/4-') ? { status: 'needs_description' } : null);
    const plan = careers.planSitemapUrls(entries, { vocab, geography, minTitleFit: 2, maxFetches: 10, known, cached: () => null });
    expect(plan.fetch.some((u) => u.includes('/4-'))).toBe(true);
    expect(plan.counts.alreadyJudged).toBe(0);
  });

  it('skips judged pages, reuses stored descriptions, and budgets the rest', () => {
    const known = (url) => (url.includes('/4-') ? { status: 'discarded' } : url.includes('/5-') ? { status: 'scored' } : null);
    const cached = (url) => (url.includes('/5-') ? { id: 'careers:x', jdText: 'stored' } : null);
    const plan = careers.planSitemapUrls(entries, { vocab, geography, minTitleFit: 2, maxFetches: 1, known, cached });
    expect(plan.reuse.map((r) => r.cached.id)).toEqual(['careers:x']);
    expect(plan.fetch).toHaveLength(1);
    expect(plan.counts).toMatchObject({ alreadyJudged: 1, overBudget: 1 });
  });
});

describe('ensureCareersIdentity (id collision regression)', () => {
  it('gives same-titled pages without JSON-LD distinct ids from their URLs', () => {
    const page = (url) => careers.ensureCareersIdentity(
      normalizeJob({ source: 'careers', title: 'Job Details | Northwind Limited', url, jdText: 'x' }),
      { url, companyName: 'Northwind' },
    );
    const a = page('https://careers.northwind.example/job/Austin-Data-Engineer/1456129833/');
    const b = page('https://careers.northwind.example/job/Boston-Data-Engineer/1456129999/');
    expect(a.id).not.toBe(b.id);
    expect(a.company).toBe('Northwind');
    expect(a.title).toBe('Austin Data Engineer');
  });

  it('strips page-title suffixes', () => {
    expect(careers.cleanPageTitle('ABL - Service Manager Job Details | Fabrikam', 'Fabrikam')).toBe('ABL - Service Manager');
  });
});

describe('appleJobFromDetail', () => {
  it('normalizes the public jobDetails payload', () => {
    const job = careers.appleJobFromDetail({
      postingTitle: 'Sr Data Engineer', jobNumber: '200000001-0001', postDateInGMT: '2026-06-02T10:00:00.000+00:00',
      locations: [{ name: 'Austin Metro Area', stateProvince: 'Texas', countryName: 'United States' }],
      jobSummary: 'Build pipelines.', minimumQualifications: 'SQL', employmentType: 'Standard', homeOffice: false,
    }, { url: 'https://jobs.fruit.example/en-us/details/200000001-0001/sr-data-engineer', company: 'Fruit' });
    expect(job).toMatchObject({
      title: 'Sr Data Engineer', company: 'Fruit', location: 'Austin Metro Area, Texas, United States',
      postedAt: '2026-06-02T10:00:00.000+00:00', employmentType: 'Full-time', sourceJobId: '200000001-0001',
    });
    expect(job.jdText).toMatch(/Minimum qualifications/);
  });
});

describe('careers sitemap end to end', () => {
  const sm = 'https://jobs.contoso.example/careers/sitemap.xml';
  const urls = {
    fit: 'https://jobs.contoso.example/careers/job/111-senior-data-engineer-united-states-washington-redmond',
    off: 'https://jobs.contoso.example/careers/job/222-retail-store-associate-united-states-texas-austin',
    undated: 'https://jobs.contoso.example/careers/job/333-lead-data-engineer-united-states-remote',
  };
  const pages = {
    [urls.fit]: jsonLdPage({ title: 'Senior Data Engineer', id: '111' }),
    [urls.off]: jsonLdPage({ title: 'Retail Store Associate', id: '222' }),
  };
  const ctx = (listed, seen, extra = {}) => ({
    maxRetries: 0, candidate: base.candidate, geography, sitemapSeen: seen,
    now: () => Date.parse('2026-06-10T12:00:00Z'),
    fetchImpl: async (url) => {
      if (url === sm) return res(sitemap(listed.map((u) => [u, '2026-06-09'])));
      if (pages[url]) return res(pages[url]);
      if (url === urls.undated) return res('<html><head><title>Lead Data Engineer | Contoso Careers</title></head><body><main>'
        + `${'Lead Data Engineer building lakehouse pipelines with PySpark and SQL. '.repeat(10)}</main></body></html>`);
      return res('not found', 404);
    },
    ...extra,
  });

  it('fetches only the fitting page and dates an undated page only once it is new to the sitemap', async () => {
    const seen = createSitemapSeen({ root: null });
    const first = await careers.run({ companies: [{ name: 'Contoso', sitemap: sm }] }, ctx([urls.fit, urls.off], seen));
    expect(first.jobs.map((j) => j.title)).toEqual(['Senior Data Engineer']);

    const second = await careers.run({ companies: [{ name: 'Contoso', sitemap: sm }] }, ctx([urls.fit, urls.off, urls.undated], seen));
    const lead = second.jobs.find((j) => j.title === 'Lead Data Engineer');
    expect(lead.postedAt).toBe('2026-06-10T12:00:00.000Z');
    expect(lead.rawMetadata.postedAtSource).toBe('first_seen');
  });

  it('leaves undated pages undated on a first crawl', async () => {
    const seen = createSitemapSeen({ root: null });
    const out = await careers.run({ companies: [{ name: 'Contoso', sitemap: sm }] }, ctx([urls.undated], seen));
    expect(out.jobs[0].postedAt).toBeNull();
  });
});

describe('planSitemapUrls ranking', () => {
  it('ranks a stated title above a technology mention, whatever the dates', () => {
    const plan = careers.planSitemapUrls([
      { loc: 'https://c.example/careers/job/1-azure-solution-area-specialist-united-states-texas-dallas', lastmod: '2026-06-09' },
      { loc: 'https://c.example/careers/job/2-senior-data-engineer-united-states-washington-redmond', lastmod: '2026-06-01' },
    ], { vocab, geography, minTitleFit: 2, maxFetches: 1 });
    expect(plan.fetch).toEqual(['https://c.example/careers/job/2-senior-data-engineer-united-states-washington-redmond']);
  });
});
