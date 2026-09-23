/**
 * Descriptions bought on an earlier run are reused BEFORE the detail budget is
 * spent, by every adapter that has one — and the budget then goes to postings
 * never read before, so coverage grows run over run.
 *
 * Only Workday and SmartRecruiters used to read the cache. Oracle, iCIMS and
 * Rippling re-bought the same top-ranked postings on every run, so their
 * budget never reached past them.
 */
import { describe, it, expect, vi } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import {
  createDetailCache, hydrateFromDetailCache, lookupDetail, planDetailBudget, jobFromCachedDetail,
} from '../../src/search/detailBudget.js';
import * as oracleRecruiting from '../../src/search/adapters/oracleRecruiting.js';
import * as rippling from '../../src/search/adapters/rippling.js';
import * as smartrecruiters from '../../src/search/adapters/smartrecruiters.js';

const LONG = 'A real, previously fetched description of this requisition. '.repeat(8);
const json = (payload) => ({ ok: true, status: 200, json: async () => payload });

describe('createDetailCache', () => {
  it('returns text, date AND location, and finds a row by URL per source', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'rippling:acme::senior data engineer::aaa-111', source: 'rippling', company: 'Acme Corp',
      title: 'Senior Data Engineer', location: 'Austin, TX', url: 'https://ats.rippling.com/acme/jobs/aaa-111',
      jd_text: LONG, posted_at: '2026-09-20',
    });
    db.upsertJob({ id: 'short', source: 'rippling', url: 'https://x.test/short', jd_text: 'teaser' });
    const cache = createDetailCache(db);
    const hit = cache('rippling:acme::senior data engineer::aaa-111');
    expect(hit).toMatchObject({ jdText: LONG, postedAt: '2026-09-20', location: 'Austin, TX' });
    expect(cache('short')).toBeNull();
    expect(cache.byUrl('https://ats.rippling.com/acme/jobs/aaa-111/?utm_source=x', 'rippling')?.id)
      .toBe('rippling:acme::senior data engineer::aaa-111');
    expect(cache.byUrl('https://ats.rippling.com/acme/jobs/aaa-111', 'icims')).toBeNull();
    db.close();
  });

  it('falls back to getReusableDetail on a handle without raw SQL access', () => {
    const cache = createDetailCache({ getReusableDetail: (id) => (id === 'a' ? { jdText: LONG } : null) });
    expect(lookupDetail(cache, { id: 'a' })?.jdText).toBe(LONG);
    expect(lookupDetail(cache, { id: 'b', url: 'https://x.test' })).toBeNull();
  });
});

describe('hydrateFromDetailCache', () => {
  it('fills a blank or URL-derived location but never overwrites a stated one', () => {
    const cache = new Map([
      ['a', { jdText: LONG, location: 'Hyderabad' }],
      ['b', { jdText: LONG, location: 'Hyderabad' }],
      ['c', { jdText: LONG, location: 'Bengaluru; Pune' }],
    ]);
    const jobs = [
      { id: 'a', location: '', rawMetadata: { summaryOnly: true } },
      { id: 'b', location: 'Austin, TX', rawMetadata: { summaryOnly: true } },
      { id: 'c', location: 'Bengaluru', rawMetadata: { summaryOnly: true, locationFromUrl: true } },
    ];
    expect(hydrateFromDetailCache(jobs, cache)).toBe(3);
    expect(jobs.map((j) => j.location)).toEqual(['Hyderabad', 'Austin, TX', 'Bengaluru; Pune']);
    expect(jobs.every((j) => j.rawMetadata.summaryOnly === false && j.rawMetadata.detailReused)).toBe(true);
  });

  it('planDetailBudget splits best-first and keeps the rest as unread', () => {
    const { budgeted, unread } = planDetailBudget([{ title: 'a' }, { title: 'b' }, { title: 'c' }], { budget: 2 });
    expect(budgeted.map((x) => x.title)).toEqual(['a', 'b']);
    expect(unread.map((x) => x.title)).toEqual(['c']);
  });

  it('jobFromCachedDetail reuses the stored id verbatim', () => {
    const job = jobFromCachedDetail({ id: 'icims:x', jdText: LONG, company: 'Acme' }, { source: 'icims', url: 'https://u' });
    expect(job.id).toBe('icims:x');
    expect(jobFromCachedDetail({ jdText: LONG }, { source: 'icims' })).toBeNull();
  });
});

describe('oracleRecruiting reuses stored descriptions before budgeting', () => {
  const page = (rows) => json({ items: [{ TotalJobsCount: rows.length, requisitionList: rows }] });
  const row = (id) => ({ Id: id, Title: 'Senior Data Engineer', PrimaryLocation: 'New York, NY', PostedDate: '2026-09-20' });

  it('spends the budget only on requisitions never read', async () => {
    const detailUrls = [];
    const fetchImpl = vi.fn(async (url) => {
      const href = String(url);
      if (href.includes('recruitingCEJobRequisitionDetails')) {
        detailUrls.push(href);
        return json({ items: [{ ExternalDescriptionStr: `<p>${LONG}</p>` }] });
      }
      return page([row('1'), row('2'), row('3')]);
    });
    const tenant = { host: 'acme.fa.us2.oraclecloud.com', siteNumber: 'CX_1', company: 'Acme' };
    const first = await oracleRecruiting.run(
      { tenants: [tenant], options: { keywords: [''], maxDetailFetches: 1 } },
      { fetchImpl, maxRetries: 0 },
    );
    const readId = first.jobs.find((j) => j.rawMetadata.summaryOnly === false).id;
    // Second run: the job read last time is in the cache.
    detailUrls.length = 0;
    const second = await oracleRecruiting.run(
      { tenants: [tenant], options: { keywords: [''], maxDetailFetches: 1 } },
      { fetchImpl, maxRetries: 0, detailCache: (id) => (id === readId ? { jdText: LONG } : null) },
    );
    expect(second.reused).toBe(1);
    expect(detailUrls).toHaveLength(1);
    expect(detailUrls[0]).not.toContain(`Id=%22${first.jobs.find((j) => j.id === readId).sourceJobId}%22`);
    expect(second.jobs.filter((j) => j.rawMetadata.summaryOnly === false)).toHaveLength(2);
  });
});

describe('rippling rebuilds a previously read posting from the store by URL', () => {
  it('costs no detail request for a cached posting', async () => {
    const list = [{ uuid: 'aaa-111', name: 'Senior Data Engineer', url: 'https://ats.rippling.com/acme/jobs/aaa-111' }];
    const fetchImpl = vi.fn(async () => json(list));
    const cache = () => null;
    cache.byUrl = (url, source) => (source === 'rippling' && url.includes('aaa-111')
      ? { id: 'rippling:acme corp::senior data engineer::aaa-111', jdText: LONG, company: 'Acme Corp', location: 'Austin, TX', postedAt: '2026-09-20' }
      : null);
    const { jobs, reused } = await rippling.run({ boards: ['acme'] }, {
      fetchImpl, maxRetries: 0, detailCache: cache, candidate: { targetTitles: ['Data Engineer'] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the list only
    expect(reused).toBe(1);
    expect(jobs[0]).toMatchObject({ id: 'rippling:acme corp::senior data engineer::aaa-111', company: 'Acme Corp', location: 'Austin, TX' });
  });
});

describe('smartrecruiters hydrates even when a later page fails', () => {
  it('keeps the cached description on the catch path', async () => {
    const posting = { id: '744', name: 'Senior Data Engineer', company: { identifier: 'acme', name: 'Acme' }, location: { city: 'Austin', country: 'us' } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ content: Array.from({ length: 100 }, (_, i) => ({ ...posting, id: String(744 + i) })), totalFound: 300 }))
      .mockResolvedValue({ ok: false, status: 500, headers: new Map(), json: async () => ({}) });
    const { jobs, reused } = await smartrecruiters.run({ boards: ['acme'] }, {
      fetchImpl, maxRetries: 0, detailCache: (id) => (id.endsWith('::744') ? { jdText: LONG } : null),
    });
    expect(reused).toBe(1);
    expect(jobs.find((j) => j.id.endsWith('::744')).jdText).toBe(LONG);
  });
});
