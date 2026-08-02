/**
 * Ashby + SmartRecruiters discovery adapters — offline tests with stubbed
 * fetch. Both adapters read OFFICIAL public APIs only.
 */
import { describe, it, expect } from 'vitest';

import * as ashby from '../../src/search/adapters/ashby.js';
import * as smartrecruiters from '../../src/search/adapters/smartrecruiters.js';
import { adapterKind, sourceKind } from '../../src/search/sources.js';
import { ADAPTERS } from '../../src/search/index.js';

const ASHBY_PAYLOAD = {
  jobs: [
    {
      id: 'a1', title: 'Senior Data Engineer', organizationName: 'Ramp',
      location: 'New York', secondaryLocations: [{ location: 'Remote (US)' }],
      isRemote: true, isListed: true,
      jobUrl: 'https://jobs.ashbyhq.com/ramp/a1',
      descriptionPlain: 'Build pipelines with Python and SQL.',
      publishedAt: '2026-06-03T10:00:00Z', employmentType: 'FullTime',
      department: 'Data', compensation: { compensationTierSummary: '$170K – $200K' },
    },
    { id: 'a2', title: 'Hidden role', isListed: false },
  ],
};

const SR_PAYLOAD = {
  content: [
    {
      id: '744000', name: 'Data Platform Engineer', refNumber: 'REF77',
      releasedDate: '2026-06-03T08:00:00Z',
      company: { identifier: 'ServiceNow1', name: 'ServiceNow' },
      location: { city: 'Santa Clara', region: 'CA', country: 'us', remote: false },
      typeOfEmployment: { label: 'Full-time' },
      experienceLevel: { label: 'Senior' },
      function: { label: 'Data & Analytics' },
    },
  ],
};

const okFetch = (payload) => async () => ({ ok: true, json: async () => payload });
const failFetch = async () => ({ ok: false, status: 404 });

describe('ashby adapter', () => {
  it('maps listed postings to normalized jobs and skips unlisted ones', async () => {
    const { jobs, errors } = await ashby.run(
      { boards: ['ramp'] }, { fetchImpl: okFetch(ASHBY_PAYLOAD), maxRetries: 0 },
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1); // a2 is unlisted
    const j = jobs[0];
    expect(j.source).toBe('ashby');
    expect(j.company).toBe('Ramp');
    expect(j.title).toBe('Senior Data Engineer');
    expect(j.location).toContain('Remote');
    expect(j.url).toBe('https://jobs.ashbyhq.com/ramp/a1');
    expect(j.jdText).toContain('Python');
    expect(j.postedAt).toBe('2026-06-03T10:00:00Z');
    expect(j.rawMetadata.compensation).toBe('$170K – $200K');
  });

  it('captures per-board errors without crashing the run', async () => {
    const { jobs, errors } = await ashby.run(
      { boards: ['dead'] }, { fetchImpl: failFetch, maxRetries: 0 },
    );
    expect(jobs).toEqual([]);
    expect(errors[0].board).toBe('dead');
    expect(errors[0].error).toContain('404');
  });

  it('returns nothing for an empty/missing board list', async () => {
    expect(await ashby.run({}, { fetchImpl: okFetch(ASHBY_PAYLOAD) }))
      .toEqual({ jobs: [], errors: [] });
  });
});

describe('smartrecruiters adapter', () => {
  it('maps postings, builds the public posting URL, synthesizes jdText', async () => {
    const { jobs, errors } = await smartrecruiters.run(
      { boards: ['ServiceNow'] }, { fetchImpl: okFetch(SR_PAYLOAD), maxRetries: 0 },
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(1);
    const j = jobs[0];
    expect(j.source).toBe('smartrecruiters');
    expect(j.company).toBe('ServiceNow');
    expect(j.title).toBe('Data Platform Engineer');
    expect(j.location).toBe('Santa Clara, CA, US');
    expect(j.url).toBe('https://jobs.smartrecruiters.com/ServiceNow1/744000');
    expect(j.jdText).toContain('Senior');
    expect(j.jdText).toContain('Data & Analytics');
    expect(j.postedAt).toBe('2026-06-03T08:00:00Z');
  });

  it('captures per-company errors without crashing the run', async () => {
    const { errors } = await smartrecruiters.run(
      { boards: ['nope'] }, { fetchImpl: failFetch, maxRetries: 0 },
    );
    expect(errors[0].company).toBe('nope');
  });

  // Regression: the adapter used to issue exactly ONE request per company and
  // keep whatever the first 100 postings were. ServiceNow publishes 442 and
  // Experian 495, so two thirds of both boards were silently invisible — and
  // because the window rotates as postings change, the database filled with
  // different first-100 slices and looked like healthy coverage.
  describe('pagination (regression: first-100 truncation)', () => {
    /** A board of `total` postings served in pages of 100 via ?offset=. */
    const pagedBoard = (total) => async (url) => {
      const { searchParams } = new URL(url);
      const offset = Number(searchParams.get('offset') ?? 0);
      const limit = Number(searchParams.get('limit') ?? 100);
      const content = [];
      for (let i = offset; i < Math.min(offset + limit, total); i += 1) {
        content.push({ id: `p${i}`, name: `Role ${i}`, company: { identifier: 'Big', name: 'Big Co' } });
      }
      return { ok: true, json: async () => ({ totalFound: total, content }) };
    };

    it('pages until every posting on a large board is read', async () => {
      const { jobs, errors } = await smartrecruiters.run(
        { boards: ['Big'] }, { fetchImpl: pagedBoard(442), maxRetries: 0 },
      );
      expect(errors).toEqual([]);
      expect(jobs).toHaveLength(442);
    });

    it('sends an increasing offset rather than refetching page one', async () => {
      const offsets = [];
      const fetchImpl = async (url) => {
        offsets.push(Number(new URL(url).searchParams.get('offset')));
        return pagedBoard(250)(url);
      };
      await smartrecruiters.run({ boards: ['Big'] }, { fetchImpl, maxRetries: 0 });
      expect(offsets).toEqual([0, 100, 200]);
    });

    it('stops at maxPostingsPerCompany instead of looping forever', async () => {
      const { jobs } = await smartrecruiters.run(
        { boards: ['Big'], maxPostingsPerCompany: 150 },
        { fetchImpl: pagedBoard(10_000), maxRetries: 0 },
      );
      expect(jobs).toHaveLength(150);
    });

    it('stops on a short page even when totalFound over-reports', async () => {
      const fetchImpl = async () => ({
        ok: true,
        json: async () => ({ totalFound: 9999, content: [{ id: '1', name: 'Only one' }] }),
      });
      const { jobs } = await smartrecruiters.run({ boards: ['Odd'] }, { fetchImpl, maxRetries: 0 });
      expect(jobs).toHaveLength(1);
    });

    it('keeps the pages it already read when a later page fails', async () => {
      let call = 0;
      const fetchImpl = async (url) => {
        call += 1;
        if (call > 2) return { ok: false, status: 500, headers: { get: () => null } };
        return pagedBoard(500)(url);
      };
      const { jobs, errors } = await smartrecruiters.run(
        { boards: ['Big'] }, { fetchImpl, maxRetries: 0 },
      );
      expect(jobs).toHaveLength(200);
      expect(errors).toHaveLength(1);
    });

    it('stops promptly when the run is cancelled', async () => {
      const fetchImpl = async (url) => pagedBoard(500)(url);
      const { jobs, cancelled } = await smartrecruiters.run(
        { boards: ['Big'] }, { fetchImpl, maxRetries: 0, shouldCancel: () => true },
      );
      expect(cancelled).toBe(true);
      expect(jobs).toEqual([]);
    });
  });
});

describe('registration', () => {
  it('both adapters are registered as real discovery sources', () => {
    expect(ADAPTERS.ashby).toBeDefined();
    expect(ADAPTERS.smartrecruiters).toBeDefined();
    expect(adapterKind('ashby')).toBe('discovery');
    expect(adapterKind('smartrecruiters')).toBe('discovery');
    expect(sourceKind('ashby')).toBe('discovery');
    expect(sourceKind('smartrecruiters')).toBe('discovery');
  });
});
