/**
 * atsSearch — cross-company, query-first discovery. Offline tests with stubbed
 * fetch; payload shapes are copied from real responses captured when the
 * adapter was written.
 */
import { describe, it, expect, vi } from 'vitest';

import * as atsSearch from '../../src/search/adapters/atsSearch.js';
import {
  makeTitleGate, makeCountryGate, makeAgeGate, phraseQuote, mapWorkableJob,
  mapSmartRecruitersHit, smartRecruitersJdText, PROVIDER_IDS,
} from '../../src/search/adapters/atsSearch.js';
import { adapterKind, sourceKind } from '../../src/search/sources.js';
import { ADAPTERS } from '../../src/search/index.js';

const TITLES = ['Senior Data Engineer', 'Analytics Engineer', 'Power BI Developer'];

const WORKABLE_ROW = {
  id: 'w1',
  title: 'Senior Data Engineer',
  state: 'published',
  description: '<p>Build and own batch pipelines.</p>',
  requirementsSection: '<ul><li>Spark</li><li>Azure Data Factory</li></ul>',
  employmentType: 'Full-time',
  created: '2026-07-30T10:00:00.000Z',
  updated: '2026-07-30T10:00:00.000Z',
  workplace: 'remote',
  locations: ['Austin, Texas, United States'],
  location: { city: 'Austin', subregion: 'Texas', countryName: 'United States' },
  company: { title: 'Acme Data', url: 'https://jobs.workable.com/company/x/jobs-at-acme' },
  url: 'https://jobs.workable.com/view/abc/senior-data-engineer-at-acme',
};

const SR_HIT = {
  id: '744000140958639',
  name: 'Data Engineer',
  company: { identifier: 'VTekisConsultingLLP', name: 'VTekis Consulting LLP' },
  releasedDate: '2026-07-31T16:27:51.449Z',
  location: { city: 'Pittsburgh', region: 'PA', country: 'us', remote: false },
  typeOfEmployment: { label: 'Contract' },
  applyUrl: 'https://jobs.smartrecruiters.com/VTekisConsultingLLP/744000140958639-data-engineer',
  actions: { details: 'https://api.smartrecruiters.com/v1/companies/VTekisConsultingLLP/postings/12992091690' },
};

describe('registration', () => {
  it('is wired in as a real discovery adapter', () => {
    expect(ADAPTERS.atsSearch).toBeDefined();
    expect(typeof ADAPTERS.atsSearch.run).toBe('function');
    expect(adapterKind('atsSearch')).toBe('discovery');
    expect(sourceKind('atsSearch')).toBe('discovery');
  });

  // Each provider here was verified against the live endpoint before being
  // added, including its robots.txt posture — see the per-provider notes in
  // atsSearch.js. The list is asserted exactly so a new one cannot be added
  // without a deliberate decision (and a note saying what was checked).
  it('exposes exactly the verified providers', () => {
    expect(PROVIDER_IDS).toEqual(['workable', 'smartrecruiters', 'themuse']);
  });
});

describe('phraseQuote', () => {
  it('quotes multi-word queries so the vendor matches the phrase, not the words', () => {
    // This is the difference between 691 and 44,506 results on SmartRecruiters.
    expect(phraseQuote('Senior Data Engineer')).toBe('"Senior Data Engineer"');
  });

  it('leaves single words and already-quoted input alone', () => {
    expect(phraseQuote('BI')).toBe('BI');
    expect(phraseQuote('"Data Engineer"')).toBe('"Data Engineer"');
    expect(phraseQuote('  ')).toBe('');
  });
});

describe('makeTitleGate', () => {
  const gate = makeTitleGate({ titles: TITLES });

  it('keeps configured target titles and generic data-role tokens', () => {
    expect(gate('Senior Data Engineer')).toBe(true);
    expect(gate('Staff Data Engineer')).toBe(true);
    expect(gate('Analytics Engineer II')).toBe(true);
    expect(gate('Power BI Developer')).toBe(true);
    expect(gate('Business Intelligence Developer')).toBe(true);
  });

  it('rejects the near-miss noise both vendors return for OR-matched queries', () => {
    // Every one of these came back from a live "Senior Data Engineer" search.
    expect(gate('Senior Data Scientist - Detection & Modeling')).toBe(false);
    expect(gate('Data Entry Operator')).toBe(false);
    expect(gate('Apprentice Electrician- Mission Critical Data Center')).toBe(false);
    expect(gate('Foreman - Mission Critical Data Center')).toBe(false);
    expect(gate('ANALISTA DE LABORATORIO JR - SANTOS')).toBe(false);
    expect(gate('')).toBe(false);
  });

  it('keeps everything when strict matching is turned off', () => {
    const loose = makeTitleGate({ titles: TITLES, strict: false });
    expect(loose('Data Entry Operator')).toBe(true);
  });
});

// Regression: a cross-company index keeps requisitions nobody ever closed.
// Across the real 17 target titles, 227 of 254 SmartRecruiters rows were over a
// YEAR old and the oldest was posted in 2014. They match on title, score like
// real jobs, and would each consume a tailored resume and an application.
describe('makeAgeGate', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

  it('rejects zombie requisitions past the ceiling', () => {
    const gate = makeAgeGate(180);
    expect(gate(daysAgo(1))).toBe(true);
    expect(gate(daysAgo(179))).toBe(true);
    expect(gate(daysAgo(400))).toBe(false);
    expect(gate('2014-04-01T00:00:00Z')).toBe(false);
  });

  it('defaults to a loose 180-day zombie guard, not a freshness filter', () => {
    // Real requisitions stay open for months; deciding what counts as "recent"
    // is the pipeline's job, not this adapter's.
    const gate = makeAgeGate(undefined);
    expect(gate(daysAgo(90))).toBe(true);
    expect(gate(daysAgo(365))).toBe(false);
  });

  it('keeps undated rows rather than assuming the worst', () => {
    const gate = makeAgeGate(180);
    expect(gate(null)).toBe(true);
    expect(gate('')).toBe(true);
    expect(gate('not a date')).toBe(true);
  });

  it('can be disabled outright', () => {
    expect(makeAgeGate(0)('2014-04-01T00:00:00Z')).toBe(true);
    expect(makeAgeGate(Infinity)('2014-04-01T00:00:00Z')).toBe(true);
  });
});

describe('makeCountryGate', () => {
  it('enforces country client-side because the SR endpoint ignores the param', () => {
    const gate = makeCountryGate('us');
    expect(gate({ country: 'us' })).toBe(true);
    expect(gate({ country: 'US' })).toBe(true);
    expect(gate({ country: 'fr' })).toBe(false);
    expect(gate({ country: 'in' })).toBe(false);
  });

  it('keeps a row with no country rather than dropping an unlabelled job', () => {
    expect(makeCountryGate('us')({})).toBe(true);
    expect(makeCountryGate('us')({ country: '' })).toBe(true);
  });

  it('is a no-op when no country is configured', () => {
    expect(makeCountryGate('')({ country: 'fr' })).toBe(true);
  });
});

describe('mapWorkableJob', () => {
  it('maps a search row into a complete, scoreable job with no detail fetch', () => {
    const job = mapWorkableJob(WORKABLE_ROW, 'Senior Data Engineer');
    expect(job.source).toBe('atsSearch');
    expect(job.company).toBe('Acme Data');
    expect(job.title).toBe('Senior Data Engineer');
    expect(job.url).toBe(WORKABLE_ROW.url);
    expect(job.postedAt).toBe('2026-07-30T10:00:00.000Z');
    expect(job.employmentType).toBe('Full-time');
    expect(job.rawMetadata.provider).toBe('workable');
  });

  it('folds requirementsSection into the JD (it holds the skill keywords)', () => {
    const job = mapWorkableJob(WORKABLE_ROW);
    expect(job.jdText).toContain('batch pipelines');
    expect(job.jdText).toContain('Azure Data Factory');
    expect(job.jdText).not.toContain('<');
  });

  it('uses workplace as the remote signal, not the city', () => {
    expect(mapWorkableJob(WORKABLE_ROW).location).toBe('Remote — Austin, Texas, United States');
    expect(mapWorkableJob({ ...WORKABLE_ROW, workplace: 'hybrid' }).location)
      .toBe('Hybrid — Austin, Texas, United States');
    expect(mapWorkableJob({ ...WORKABLE_ROW, workplace: 'on_site' }).location)
      .toBe('Austin, Texas, United States');
  });

  it('drops placeholder cities instead of rendering "Remote — TELECOMMUTE"', () => {
    const job = mapWorkableJob({
      ...WORKABLE_ROW,
      locations: ['TELECOMMUTE'],
      location: { city: 'TELECOMMUTE', countryName: 'United States' },
    });
    expect(job.location).toBe('Remote — United States');
  });

  it('returns null for a row with neither title nor url', () => {
    expect(mapWorkableJob({ id: 'x' })).toBeNull();
    expect(mapWorkableJob(null)).toBeNull();
  });
});

describe('mapSmartRecruitersHit', () => {
  it('maps a hit and marks it summaryOnly (the search row carries no JD)', () => {
    const job = mapSmartRecruitersHit(SR_HIT, 'Data Engineer');
    expect(job.company).toBe('VTekis Consulting LLP');
    expect(job.location).toBe('Pittsburgh, PA, US');
    expect(job.postedAt).toBe('2026-07-31T16:27:51.449Z');
    expect(job.rawMetadata.summaryOnly).toBe(true);
    expect(job.rawMetadata.detailsUrl).toBe(SR_HIT.actions.details);
  });

  it('captures the company slug so the harvester can reuse it as a board id', () => {
    expect(mapSmartRecruitersHit(SR_HIT).rawMetadata.companyIdentifier)
      .toBe('VTekisConsultingLLP');
  });

  it('labels remote and hybrid postings without inventing a city', () => {
    expect(mapSmartRecruitersHit({
      ...SR_HIT, location: { city: 'TELECOMMUTE', country: 'us', remote: true },
    }).location).toBe('Remote — US');
    expect(mapSmartRecruitersHit({
      ...SR_HIT, location: { city: 'Austin', region: 'TX', country: 'us', hybrid: true },
    }).location).toBe('Hybrid — Austin, TX, US');
  });
});

describe('smartRecruitersJdText', () => {
  it('flattens the jobAd sections in reading order and strips markup', () => {
    const text = smartRecruitersJdText({
      jobAd: {
        sections: {
          jobDescription: { text: '<p>Own the warehouse.</p>' },
          qualifications: { text: '<p>5 years SQL.</p>' },
          companyDescription: { text: '<p>We are Acme.</p>' },
        },
      },
    });
    expect(text.indexOf('Own the warehouse')).toBeLessThan(text.indexOf('5 years SQL'));
    expect(text).toContain('We are Acme');
    expect(text).not.toContain('<p>');
  });

  it('returns empty string when the payload has no sections', () => {
    expect(smartRecruitersJdText({})).toBe('');
    expect(smartRecruitersJdText(null)).toBe('');
  });
});

describe('run()', () => {
  const candidate = { targetTitles: TITLES };

  it('derives queries from candidate.targetTitles and searches both providers', async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url) => {
      seen.push(String(url));
      if (String(url).includes('workable')) {
        return { ok: true, json: async () => ({ jobs: [WORKABLE_ROW], nextPageToken: null }) };
      }
      return { ok: true, json: async () => ({ content: [SR_HIT] }) };
    });

    const { jobs, errors } = await atsSearch.run(
      { options: { maxQueries: 1, fetchDetails: false } },
      { fetchImpl, candidate, maxRetries: 0 },
    );

    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(2);
    // The candidate's first target title became the query, phrase-quoted.
    // Read it back through URLSearchParams rather than matching encoded text —
    // the two endpoints encode spaces differently ('+' vs '%20').
    const queries = seen.map((u) => {
      const p = new URL(u).searchParams;
      return p.get('query') ?? p.get('keyword');
    });
    expect(queries).toContain('"Senior Data Engineer"');
    expect(queries).toHaveLength(2); // one per provider
  });

  it('sends no country param to SmartRecruiters, since the server ignores it', async () => {
    const seen = [];
    const fetchImpl = vi.fn(async (url) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ content: [SR_HIT] }) };
    });
    await atsSearch.run(
      { options: { providers: ['smartrecruiters'], maxQueries: 1, fetchDetails: false } },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    expect(seen[0]).toContain('/sr-jobs/search');
    expect(seen[0]).not.toContain('country=');
  });

  it('drops non-US SmartRecruiters hits client-side', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        content: [
          SR_HIT,
          { ...SR_HIT, id: '2', location: { city: 'Berlin', country: 'de' } },
          { ...SR_HIT, id: '3', location: { city: 'Hyderabad', country: 'in' } },
        ],
      }),
    });
    const { jobs } = await atsSearch.run(
      { options: { providers: ['smartrecruiters'], maxQueries: 1, fetchDetails: false } },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].location).toContain('US');
  });

  it('follows Workable pagination until the token runs out', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        json: async () => ({
          jobs: [{ ...WORKABLE_ROW, id: `w${call}` }],
          nextPageToken: call < 3 ? `tok${call}` : null,
        }),
      };
    });
    const { jobs } = await atsSearch.run(
      { options: { providers: ['workable'], maxQueries: 1, maxPages: 10 } },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    expect(call).toBe(3);
    expect(jobs).toHaveLength(3);
  });

  // Regression: the adapter shipped without `day_range`. Workable ranks by
  // RELEVANCE and honors no sort parameter, so an unbounded search returned
  // postings up to 192 days old — 236 of the first 290 rows stored were over a
  // month old and none were from the last 24h. Worse, a wider window DISPLACES
  // fresh jobs within the fixed page budget: measured over the real target
  // titles, day_range=7 yielded 137 jobs under a week old where 30 yielded 76.
  describe('Workable freshness (regression: relevance-ranked stale results)', () => {
    const captureUrl = async (options) => {
      let href = null;
      await atsSearch.run(
        { options: { providers: ['workable'], maxQueries: 1, maxPages: 1, ...options } },
        {
          fetchImpl: async (url) => {
            href = String(url);
            return { ok: true, json: async () => ({ jobs: [], nextPageToken: null }) };
          },
          candidate,
          maxRetries: 0,
        },
      );
      return new URL(href).searchParams;
    };

    it('always bounds the search by day_range', async () => {
      expect((await captureUrl({})).get('day_range')).toBe('7');
    });

    it('honors a configured dayRange', async () => {
      expect((await captureUrl({ dayRange: 3 })).get('day_range')).toBe('3');
      expect((await captureUrl({ dayRange: 30 })).get('day_range')).toBe('30');
    });

    it('never sends a nonsensical window', async () => {
      expect((await captureUrl({ dayRange: 0 })).get('day_range')).toBe('1');
      expect((await captureUrl({ dayRange: -5 })).get('day_range')).toBe('1');
      expect((await captureUrl({ dayRange: 2.7 })).get('day_range')).toBe('2');
      // A malformed value must fall back to the default, not vanish.
      expect((await captureUrl({ dayRange: 'soon' })).get('day_range')).toBe('7');
    });

    it('keeps day_range set on every page, not just the first', async () => {
      const seen = [];
      let call = 0;
      await atsSearch.run(
        { options: { providers: ['workable'], maxQueries: 1, maxPages: 3, dayRange: 7 } },
        {
          fetchImpl: async (url) => {
            seen.push(new URL(String(url)).searchParams.get('day_range'));
            call += 1;
            // Must return rows: an empty page correctly ends pagination.
            return {
              ok: true,
              json: async () => ({
                jobs: [{ ...WORKABLE_ROW, id: `w${call}` }],
                nextPageToken: call < 3 ? `t${call}` : null,
              }),
            };
          },
          candidate,
          maxRetries: 0,
        },
      );
      expect(seen).toEqual(['7', '7', '7']);
    });

    it('does not send day_range to SmartRecruiters, which is already newest-first', async () => {
      let href = null;
      await atsSearch.run(
        { options: { providers: ['smartrecruiters'], maxQueries: 1, fetchDetails: false, dayRange: 7 } },
        {
          fetchImpl: async (url) => {
            href = String(url);
            return { ok: true, json: async () => ({ content: [] }) };
          },
          candidate,
          maxRetries: 0,
        },
      );
      expect(new URL(href).searchParams.get('day_range')).toBeNull();
    });
  });

  it('drops zombie SmartRecruiters requisitions before they reach the pipeline', async () => {
    const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        content: [
          { ...SR_HIT, id: 'live', releasedDate: daysAgo(2) },
          { ...SR_HIT, id: 'stale', releasedDate: daysAgo(400) },
          { ...SR_HIT, id: 'ancient', releasedDate: '2014-04-01T00:00:00Z' },
          { ...SR_HIT, id: 'undated', releasedDate: null },
        ],
      }),
    });
    const { jobs } = await atsSearch.run(
      { options: { providers: ['smartrecruiters'], maxQueries: 1, fetchDetails: false } },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    expect(jobs.map((j) => j.sourceJobId).sort()).toEqual(['live', 'undated']);
  });

  it('drops a stale Workable row even if the server ignores day_range', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        jobs: [
          { ...WORKABLE_ROW, id: 'fresh', created: new Date().toISOString() },
          { ...WORKABLE_ROW, id: 'zombie', created: '2015-01-01T00:00:00Z' },
        ],
        nextPageToken: null,
      }),
    });
    const { jobs } = await atsSearch.run(
      { options: { providers: ['workable'], maxQueries: 1 } },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].sourceJobId).toBe('fresh');
  });

  it('honors maxPages so one query cannot walk a board forever', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return {
        ok: true,
        json: async () => ({ jobs: [{ ...WORKABLE_ROW, id: `w${call}` }], nextPageToken: 'always' }),
      };
    });
    await atsSearch.run(
      { options: { providers: ['workable'], maxQueries: 1, maxPages: 2 } },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    expect(call).toBe(2);
  });

  it('enriches SmartRecruiters hits with the full JD within budget', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('api.smartrecruiters.com')) {
        return {
          ok: true,
          json: async () => ({ jobAd: { sections: { jobDescription: { text: '<p>Full description here.</p>' } } } }),
        };
      }
      return { ok: true, json: async () => ({ content: [SR_HIT] }) };
    };
    const { jobs } = await atsSearch.run(
      { options: { providers: ['smartrecruiters'], maxQueries: 1, fetchDetails: true } },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    expect(jobs[0].jdText).toContain('Full description here');
    expect(jobs[0].rawMetadata.summaryOnly).toBe(false);
  });

  it('keeps the job when detail enrichment fails, marking it summaryOnly', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('api.smartrecruiters.com')) return { ok: false, status: 429, headers: { get: () => null } };
      return { ok: true, json: async () => ({ content: [SR_HIT] }) };
    };
    const { jobs, errors } = await atsSearch.run(
      { options: { providers: ['smartrecruiters'], maxQueries: 1, fetchDetails: true } },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    // A missing description is a fidelity loss, never a lost job — and it must
    // not be reported as a source-level failure.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].rawMetadata.summaryOnly).toBe(true);
    expect(errors).toEqual([]);
  });

  it('reports a failing provider without losing the other provider results', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('workable')) return { ok: false, status: 503, headers: { get: () => null } };
      return { ok: true, json: async () => ({ content: [SR_HIT] }) };
    };
    const { jobs, errors } = await atsSearch.run(
      { options: { maxQueries: 1, fetchDetails: false } },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    expect(jobs).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].provider).toBe('workable');
    expect(errors[0].status).toBe(503);
  });

  it('reports an unknown provider instead of silently skipping it', async () => {
    const { errors } = await atsSearch.run(
      { options: { providers: ['bogus'], maxQueries: 1 } },
      { fetchImpl: async () => ({ ok: true, json: async () => ({}) }), candidate, maxRetries: 0 },
    );
    expect(errors[0].error).toContain('Unknown atsSearch provider');
  });

  it('explains itself when there are no queries at all', async () => {
    const { jobs, errors } = await atsSearch.run({ options: {} }, { fetchImpl: async () => ({}) });
    expect(jobs).toEqual([]);
    expect(errors[0].error).toContain('no queries');
  });

  it('stops promptly when the run is cancelled', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ content: [SR_HIT] }) }));
    const { jobs, cancelled } = await atsSearch.run(
      { options: { maxQueries: 3, fetchDetails: false } },
      { fetchImpl, candidate, maxRetries: 0, shouldCancel: () => true },
    );
    expect(cancelled).toBe(true);
    expect(jobs).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('de-duplicates queries so the same title is never searched twice', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ content: [] }) }));
    await atsSearch.run(
      {
        options: {
          providers: ['smartrecruiters'],
          queries: ['Data Engineer', 'data engineer', '  Data Engineer  ', 'Analytics Engineer'],
        },
      },
      { fetchImpl, maxRetries: 0 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
