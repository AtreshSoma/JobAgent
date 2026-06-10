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
