/**
 * Coverage expansion: the Rippling per-company board adapter, plus The Muse
 * cross-company provider inside atsSearch.
 *
 * Offline tests with stubbed fetch. Every payload shape below is copied from a
 * real response captured against the live endpoint when these were written, so a
 * vendor field rename shows up as a failing mapping test rather than as jobs
 * silently arriving with blank companies and no dates.
 */
import { describe, it, expect, vi } from 'vitest';

import * as rippling from '../../src/search/adapters/rippling.js';
import { mapJob, descriptionText } from '../../src/search/adapters/rippling.js';
import {
  makeUsLocationGate, museLocations, PROVIDER_IDS,
} from '../../src/search/adapters/atsSearch.js';
import * as atsSearch from '../../src/search/adapters/atsSearch.js';
import { adapterKind, sourceKind, isDiscoveryAdapter } from '../../src/search/sources.js';
import { ADAPTERS } from '../../src/search/index.js';

const TITLES = ['Senior Data Engineer', 'Analytics Engineer', 'Data Engineer'];

/* Real shapes: api.rippling.com/platform/api/ats/v1/board/{slug}/jobs[/{uuid}] */
const RIP_LIST = [
  {
    uuid: 'aaa-111',
    name: 'Senior Data Engineer',
    department: { id: 'Engineering', label: 'Engineering' },
    workLocation: { label: 'Remote (Texas, US)', id: 'Remote (Texas, US)' },
    url: 'https://ats.rippling.com/acme/jobs/aaa-111',
  },
  {
    uuid: 'bbb-222',
    name: 'Account Executive',
    department: { id: 'Sales', label: 'Sales' },
    workLocation: { label: 'New York, NY', id: 'New York, NY' },
    url: 'https://ats.rippling.com/acme/jobs/bbb-222',
  },
];

const RIP_DETAIL = {
  uuid: 'aaa-111',
  name: 'Senior Data Engineer',
  companyName: 'Acme Corp',
  description: {
    company: '<p>Acme builds things.</p>',
    role: '<h2>About the role</h2><p>Own our Spark pipelines.</p>',
  },
  workLocations: ['Austin, TX', 'Remote (Texas, US)'],
  department: { id: 'Engineering', label: 'Engineering' },
  employmentType: { label: 'SALARIED_FT', id: 'Salaried, full-time' },
  createdOn: '2026-07-30T10:40:35.194000-07:00',
  unlistedFromSearch: false,
  url: 'https://ats.rippling.com/acme/jobs/aaa-111',
};

/** A fetch stub that dispatches on URL substring. */
function stubFetch(routes) {
  return vi.fn(async (url) => {
    const href = String(url);
    for (const [needle, payload] of routes) {
      if (href.includes(needle)) {
        return { ok: true, status: 200, json: async () => payload };
      }
    }
    return { ok: false, status: 404, statusText: 'Not Found', headers: new Map(), json: async () => ({}) };
  });
}

describe('rippling: registration', () => {
  it('is wired in as a real discovery adapter', () => {
    expect(ADAPTERS.rippling).toBeDefined();
    expect(typeof ADAPTERS.rippling.run).toBe('function');
    expect(adapterKind('rippling')).toBe('discovery');
    expect(isDiscoveryAdapter('rippling')).toBe(true);
    expect(sourceKind('rippling')).toBe('discovery');
  });
});

describe('rippling: mapping', () => {
  it('keeps the employer name and the direct ATS application URL', () => {
    const job = mapJob(RIP_DETAIL, { slug: 'acme', row: RIP_LIST[0] });
    // companyName, never the URL slug — the slug is a poor label AND a poor
    // dedup key.
    expect(job.company).toBe('Acme Corp');
    expect(job.title).toBe('Senior Data Engineer');
    expect(job.url).toBe('https://ats.rippling.com/acme/jobs/aaa-111');
    expect(job.source).toBe('rippling');
    expect(job.sourceJobId).toBe('aaa-111');
    expect(job.postedAt).toBe('2026-07-30T10:40:35.194000-07:00');
    expect(job.location).toBe('Austin, TX; Remote (Texas, US)');
    expect(job.employmentType).toBe('Salaried, full-time');
    expect(job.rawMetadata.department).toBe('Engineering');
  });

  it('falls back to the list row location when the detail omits workLocations', () => {
    const job = mapJob({ ...RIP_DETAIL, workLocations: undefined }, { slug: 'acme', row: RIP_LIST[0] });
    expect(job.location).toBe('Remote (Texas, US)');
  });

  it('puts the ROLE text before the company boilerplate', () => {
    // The scorer reads the head of the description; leading company boilerplate
    // would push the actual requirements out of the part that decides fit.
    const text = descriptionText(RIP_DETAIL.description);
    expect(text.indexOf('Own our Spark pipelines')).toBeLessThan(text.indexOf('Acme builds things'));
  });

  it('survives a description that is a bare string or missing', () => {
    expect(descriptionText('<p>hi</p>')).toBe('hi');
    expect(descriptionText(null)).toBe('');
  });
});

describe('rippling: run()', () => {
  const ctx = () => ({ candidate: { targetTitles: TITLES }, maxRetries: 0 });

  it('title-gates the LIST before spending a detail request per job', async () => {
    const fetchImpl = stubFetch([['/jobs/aaa-111', RIP_DETAIL], ['/jobs', RIP_LIST]]);
    const { jobs, errors } = await rippling.run(
      { boards: ['acme'] },
      { ...ctx(), fetchImpl },
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe('Senior Data Engineer');
    // 1 list + 1 detail. The Account Executive row must NOT have been fetched:
    // that economy is the whole reason this adapter is affordable on a 730-job
    // board.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes('bbb-222'))).toBe(false);
  });

  it('drops a posting the board does not publish in its own search', async () => {
    const fetchImpl = stubFetch([
      ['/jobs/aaa-111', { ...RIP_DETAIL, unlistedFromSearch: true }],
      ['/jobs', RIP_LIST],
    ]);
    const { jobs } = await rippling.run({ boards: ['acme'] }, { ...ctx(), fetchImpl });
    expect(jobs).toEqual([]);
  });

  it('refuses a zombie requisition older than maxAgeDays', async () => {
    const fetchImpl = stubFetch([
      ['/jobs/aaa-111', { ...RIP_DETAIL, createdOn: '2019-01-01T00:00:00Z' }],
      ['/jobs', RIP_LIST],
    ]);
    const { jobs } = await rippling.run(
      { boards: ['acme'], options: { maxAgeDays: 180 } },
      { ...ctx(), fetchImpl },
    );
    expect(jobs).toEqual([]);
  });

  it('reports what the detail budget left unread instead of looking complete', async () => {
    const fetchImpl = stubFetch([['/jobs/aaa-111', RIP_DETAIL], ['/jobs', RIP_LIST]]);
    const { jobs, errors } = await rippling.run(
      { boards: ['acme'], options: { maxDetailFetches: 0 } },
      { ...ctx(), fetchImpl },
    );
    expect(jobs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].degraded).toBe(true);
    expect(errors[0].count).toBe(1);
    expect(errors[0].error).toMatch(/went unread/);
  });

  it('a failing board is one error, never a thrown run', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false, status: 503, statusText: 'Service Unavailable', headers: new Map(),
    }));
    const { jobs, errors } = await rippling.run({ boards: ['acme'] }, { ...ctx(), fetchImpl });
    expect(jobs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].board).toBe('acme');
    expect(errors[0].status).toBe(503);
  });

  it('no boards configured is not an error', async () => {
    const { jobs, errors } = await rippling.run({}, ctx());
    expect(jobs).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe('atsSearch: the themuse provider', () => {
  it('registers themuse and NOT the rejected himalayas provider', () => {
    expect(PROVIDER_IDS).toContain('themuse');
    // himalayas.app honors only `offset` — see the REJECTED PROVIDERS note in
    // atsSearch.js. Asserted so it cannot be re-added without re-measuring.
    expect(PROVIDER_IDS).not.toContain('himalayas');
    expect(sourceKind('themuse')).toBe('discovery');
  });

  describe('makeUsLocationGate', () => {
    const gate = makeUsLocationGate();

    it('keeps locations that resolve to the US, including bare cities', () => {
      // The Muse returns CITY strings, not country names — an earlier version of
      // this gate matched country names only and silently dropped every US row.
      for (const loc of ['United States', 'USA', 'Austin, TX', 'Waco, TX',
        'Remote (Texas, US)', 'Austin, TX; London']) {
        expect(gate(loc), loc).toBe(true);
      }
    });

    it('keeps geography-free labels — borderless means open to the US', () => {
      for (const loc of ['Remote', 'Worldwide', 'Anywhere', 'Telecommute', 'Various']) {
        expect(gate(loc), loc).toBe(true);
      }
    });

    it('keeps a missing location rather than judging it', () => {
      for (const loc of ['', null, undefined, '   ']) expect(gate(loc)).toBe(true);
    });

    it('drops a location that positively resolves elsewhere', () => {
      for (const loc of ['Venezuela', 'India', 'London, UK', 'United Kingdom', 'Toronto, ON']) {
        expect(gate(loc), loc).toBe(false);
      }
    });

    it('can be disabled outright', () => {
      expect(makeUsLocationGate(false)('Venezuela')).toBe(true);
    });
  });

  it('museLocations flattens the locations array', () => {
    expect(museLocations({ locations: [{ name: 'Waco, TX' }, { name: 'Remote' }] }))
      .toBe('Waco, TX; Remote');
    expect(museLocations({})).toBe('');
  });

  const MUSE_ROW = {
    id: 987,
    name: 'Analytics Engineer',
    type: 'external',
    publication_date: new Date(Date.now() - 86_400_000).toISOString(),
    contents: '<div><p>dbt and Snowflake.</p></div>',
    company: { id: 1, short_name: 'spacex', name: 'SpaceX' },
    locations: [{ name: 'Austin, TX' }],
    levels: [{ name: 'Mid Level' }],
    refs: { landing_page: 'https://www.themuse.com/jobs/spacex/analytics-engineer' },
  };

  it('maps a Muse row and runs its pages ONCE, not once per title', async () => {
    const fetchImpl = stubFetch([['themuse.com/api/public/jobs', { results: [MUSE_ROW] }]]);
    const { jobs, errors } = await atsSearch.run(
      {
        options: {
          providers: ['themuse'],
          queries: TITLES,                       // three titles...
          museCategories: ['Data and Analytics'], // ...one category, one page
          museMaxPages: 1,
        },
      },
      { fetchImpl, maxRetries: 0, candidate: { targetTitles: TITLES } },
    );
    expect(errors).toEqual([]);
    // The endpoint takes no search term, so running it per title would fetch the
    // same page three times and yield three copies of every row.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].source).toBe('themuse');
    expect(jobs[0].company).toBe('SpaceX');
    expect(jobs[0].location).toBe('Austin, TX');
    expect(jobs[0].jdText).toBe('dbt and Snowflake.');
    expect(jobs[0].rawMetadata.aggregator).toBe(true);
  });

  it('de-duplicates a Muse req that appears under several categories', async () => {
    const fetchImpl = stubFetch([['themuse.com/api/public/jobs', { results: [MUSE_ROW] }]]);
    const { jobs } = await atsSearch.run(
      {
        options: {
          providers: ['themuse'],
          queries: ['Analytics Engineer'],
          museCategories: ['Data and Analytics', 'Data Science', 'IT'],
          museMaxPages: 1,
        },
      },
      { fetchImpl, maxRetries: 0, candidate: { targetTitles: TITLES } },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(jobs).toHaveLength(1);
  });

  it('an unknown provider is one error, and never crashes the run', async () => {
    const { jobs, errors } = await atsSearch.run(
      { options: { providers: ['nope'], queries: ['Data Engineer'] } },
      { fetchImpl: vi.fn(), maxRetries: 0, candidate: { targetTitles: TITLES } },
    );
    expect(jobs).toEqual([]);
    expect(errors[0].error).toMatch(/Unknown atsSearch provider/);
  });
});
