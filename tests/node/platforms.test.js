/**
 * Platform registry + iCIMS adapter.
 *
 * These tests encode findings that were expensive to establish and easy to
 * regress — above all that iCIMS content IS server-rendered behind
 * `in_iframe=1`. That platform was previously written off as "JS-only SPA, no
 * public feed", which was wrong and cost coverage of the single largest ATS.
 */
import { describe, it, expect, vi } from 'vitest';

import {
  PLATFORMS, ENUMERABLE_PLATFORMS, platformForUrl, platformForHtml,
  detectPlatform, extractCoordinate,
} from '../../src/search/platforms.js';
import * as icims from '../../src/search/adapters/icims.js';

describe('platform registry', () => {
  it('identifies each enumerable platform from a posting URL', () => {
    const cases = [
      ['https://boards.greenhouse.io/acme/jobs/123', 'greenhouse'],
      ['https://jobs.lever.co/acme/abc-def', 'lever'],
      ['https://jobs.ashbyhq.com/acme/uuid', 'ashby'],
      ['https://jobs.smartrecruiters.com/Acme/12345', 'smartrecruiters'],
      ['https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Remote/Engineer_R-1', 'workday'],
      ['https://careers-acme.icims.com/jobs/12345/engineer/job', 'icims'],
      ['https://apply.workable.com/acme/j/ABC123/', 'workable'],
      [
        'https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210695420',
        'oracleRecruiting',
      ],
    ];
    for (const [url, expected] of cases) {
      expect(platformForUrl(url)?.id, url).toBe(expected);
    }
  });

  it('does not classify non-recruiting Oracle Cloud URLs as an ATS', () => {
    // oraclecloud.com serves all of Oracle Cloud. Matching on the hostname
    // alone would harvest arbitrary tenants as if they were career sites.
    expect(platformForUrl('https://acme.fa.us2.oraclecloud.com/fscmUI/faces/Invoices')).toBeNull();
    expect(
      platformForUrl('https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/9')?.id,
    ).toBe('oracleRecruiting');
  });

  it('detects a platform behind a vanity careers domain from page markers', () => {
    // The case hostname matching cannot solve: an employer fronting its ATS on
    // its own domain. These marker strings were confirmed on live sites.
    expect(platformForHtml('<div id="icims_content_iframe"></div>')?.id).toBe('icims');
    expect(platformForHtml('<title>iCIMS Careers Portal</title>')?.id).toBe('icims');
    expect(platformForHtml('<img src="https://rmkcdn.successfactors.com/x.png">')?.id)
      .toBe('successfactors');
    expect(platformForHtml('<p>ordinary marketing page</p>')).toBeNull();
  });

  it('prefers the hostname and falls back to body markers', () => {
    const byHost = detectPlatform({ url: 'https://careers-acme.icims.com/jobs/1/x/job' });
    expect(byHost.via).toBe('host');
    expect(byHost.coordinate).toEqual({ ats: 'icims', host: 'careers-acme.icims.com' });

    const byBody = detectPlatform({
      url: 'https://careers.acme.com/search',
      html: '<div id="icims_content_iframe">',
    });
    expect(byBody.via).toBe('body');
    expect(byBody.platform.id).toBe('icims');
  });

  it('records unsupported platforms with a verified reason instead of omitting them', () => {
    // A dead end that is written down is not re-explored. Each of these was
    // checked live; the note says what actually happened.
    for (const id of ['eightfold', 'phenom', 'successfactors']) {
      const p = PLATFORMS.find((x) => x.id === id);
      expect(p, id).toBeTruthy();
      expect(p.enumerable).toBe(false);
      expect(p.note.length).toBeGreaterThan(40);
      expect(ENUMERABLE_PLATFORMS.has(id)).toBe(false);
    }
  });

  it('never returns a coordinate for a platform it cannot enumerate', () => {
    expect(extractCoordinate('https://starbucks.eightfold.ai/careers/job/123')).toBeNull();
  });

  it('rejects malformed and non-http URLs', () => {
    for (const bad of ['not a url', 'mailto:a@b.com', 'ftp://x.com/jobs/1', '']) {
      expect(platformForUrl(bad), bad).toBeNull();
      expect(extractCoordinate(bad), bad).toBeNull();
    }
  });
});

describe('icims adapter', () => {
  const listing = (rows, pages = 1) => `
    <html><body>
      <span>Page 1 of ${pages}</span>
      ${rows.map((r) => `<a href="/jobs/${r.id}/${r.slug}/job">${r.title}</a>`).join('\n')}
      <a href="/jobs/${rows[0]?.id ?? 1}/x/job?mode=login">Login to apply</a>
    </body></html>`;

  const detail = (title) => `<html><head>
    <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'JobPosting', title,
    datePosted: '2026-08-01', description: '<p>Build things</p>',
    hiringOrganization: { name: 'Peraton' },
    jobLocation: { address: { addressLocality: 'Reston', addressRegion: 'VA', addressCountry: 'US' } },
  })}</script></head><body></body></html>`;

  it('reads job rows and titles from the rendered listing', () => {
    const rows = icims.extractJobRows(
      listing([{ id: '169483', slug: 'senior-systems-engineer', title: 'Senior Systems Engineer' }]),
      'careers-peraton.icims.com',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: '169483', title: 'Senior Systems Engineer' });
    // The stored link is the clean canonical form, with frame/tracking params
    // stripped — the `hashed=` apply token cannot be synthesized anyway.
    expect(rows[0].url).toBe('https://careers-peraton.icims.com/jobs/169483/senior-systems-engineer/job');
  });

  it('refuses the robots-disallowed login variant the listing also emits', () => {
    // A job row links to both the plain and the `login` URL. robots.txt
    // disallows the latter, so it must never be requested.
    const rows = icims.extractJobRows(
      listing([{ id: '1', slug: 'engineer', title: 'Engineer' }]),
      'careers-acme.icims.com',
    );
    expect(rows.every((r) => !r.url.includes('login'))).toBe(true);
    expect(icims.isDisallowedPath('https://x.icims.com/jobs/1/a/job?mode=login')).toBe(false);
    expect(icims.isDisallowedPath('https://x.icims.com/jobs/1/login/job')).toBe(true);
    expect(icims.isDisallowedPath('https://x.icims.com/connect/interest')).toBe(true);
  });

  it('adds in_iframe=1, without which iCIMS serves an empty shell', () => {
    expect(icims.detailUrl('https://x.icims.com/jobs/1/a/job'))
      .toBe('https://x.icims.com/jobs/1/a/job?in_iframe=1');
    expect(icims.listUrl('x.icims.com', 2)).toContain('in_iframe=1');
    expect(icims.listUrl('x.icims.com', 2)).toContain('pr=2');
  });

  it('reads the portal page count from its own label rather than probing', () => {
    expect(icims.totalPages('<span>Page 1 of 30</span>')).toBe(30);
    expect(icims.totalPages('<span>no label here</span>')).toBe(1);
  });

  it('drops the UNAVAILABLE location placeholder without inventing one', () => {
    expect(icims.cleanLocation('UNAVAILABLE, UNAVAILABLE, US')).toBe('');
    expect(icims.cleanLocation('Reston, VA, US')).toBe('Reston, VA, US');
    expect(icims.cleanLocation('Reston, UNAVAILABLE, US')).toBe('Reston, US');
  });

  it('maps a posting end to end, preferring schema.org JSON-LD', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const body = String(url).includes('/jobs/search')
        ? listing([{ id: '169483', slug: 'senior-systems-engineer', title: 'Senior Systems Engineer' }])
        : detail('Senior Systems Engineer');
      return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
    });
    const { jobs, errors } = await icims.run(
      { boards: [{ host: 'careers-peraton.icims.com', company: 'Peraton' }] },
      { fetchImpl, candidate: { targetTitles: ['Systems Engineer'] } },
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Senior Systems Engineer');
    expect(jobs[0].company).toBe('Peraton');
    expect(jobs[0].rawMetadata.viaJsonLd).toBe(true);
    expect(jobs[0].url).toBe('https://careers-peraton.icims.com/jobs/169483/senior-systems-engineer/job');
  });

  it('accepts a bare host string as well as an object', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, status: 200, text: async () => listing([]), json: async () => ({}),
    }));
    const { errors } = await icims.run({ boards: ['careers-acme.icims.com'] }, { fetchImpl });
    expect(errors).toEqual([]);
    expect(fetchImpl).toHaveBeenCalled();
  });
});
