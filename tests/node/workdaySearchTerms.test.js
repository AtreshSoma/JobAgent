/**
 * Workday multi-phrase search, derived from the candidate's own target titles.
 *
 * Background — every claim below was measured against live public CXS endpoints:
 *
 *  - The search is fuzzy-AND, not OR: it NARROWS as tokens are added. On one
 *    tenant "data" returned 115, "engineer" 57, "data engineer" 51,
 *    "data engineer bi" 27, and a nine-word "cover everything" query 0. So each
 *    derived phrase is capped at two tokens.
 *  - It is fuzzy enough that one phrase reaches sibling titles: "data engineer"
 *    surfaced "Senior Business Intelligence Engineer". Across 12 configured
 *    tenants a single phrase recovered every on-target title except three —
 *    two ETL Developer roles and one Quantitative Analytics Engineer.
 *  - `total` is reported on the FIRST page only; later pages return 0.
 *  - `limit` above 20 returns no rows at all.
 */
import { describe, it, expect, vi } from 'vitest';

import * as workday from '../../src/search/adapters/workday.js';
import { deriveSearchTerms } from '../../src/search/adapters/workday.js';

/** The real 17 target titles this was tuned against. */
const TITLES = [
  'Senior Data Engineer', 'Lead Data Engineer', 'Azure Data Engineer',
  'Data Engineering Lead', 'Data Engineer', 'Business Intelligence Developer',
  'BI Developer', 'Power BI Developer', 'Business Intelligence Engineer',
  'Analytics Engineer', 'Data Analytics Engineer', 'BI Engineer',
  'Data Warehouse Engineer', 'Data Warehouse Developer', 'ETL Developer',
  'Data Platform Engineer', 'Analytics Developer',
];

// These tests cover phrase resolution, paging and merging — not the optional
// full-JD enrichment, which has its own coverage and would otherwise fire a
// detail request per posting against the list stub.
const TENANT = {
  host: 'acme.wd5.myworkdayjobs.com', tenant: 'acme', site: 'Careers', company: 'Acme',
  fetchDetails: false,
};

/** rateLimitMs: 0 removes the 500ms inter-request host spacing. */
const FAST = { rateLimitMs: 0 };

const posting = (n) => ({
  title: `Data Engineer ${n}`,
  externalPath: `/job/US/Data-Engineer-${n}_R${n}`,
  locationsText: 'Austin, TX',
  postedOn: 'Posted 2 Days Ago',
  bulletFields: [`R${n}`],
});

/** A stub CXS endpoint: `bySearch` maps a phrase to the postings it returns. */
function stubCxs(bySearch) {
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const rows = bySearch[body.searchText] ?? [];
    const page = rows.slice(body.offset, body.offset + body.limit);
    return {
      ok: true,
      // `total` only on page 0 — mirrors the real endpoint.
      json: async () => ({ total: body.offset === 0 ? rows.length : 0, jobPostings: page }),
    };
  };
  return { fetchImpl, calls };
}

describe('deriveSearchTerms', () => {
  it('covers every target title with the fewest two-token phrases', () => {
    // "data engineer" reaches the 12 data/engineer titles; "bi developer"
    // reaches the five developer-suffixed ones a single phrase missed.
    expect(deriveSearchTerms(TITLES, 2)).toEqual(['data engineer', 'bi developer']);
  });

  it('stops as soon as the title list is covered, rather than spending the budget', () => {
    // Cost is per phrase, so a third query that covers nothing new is pure waste.
    expect(deriveSearchTerms(TITLES, 4)).toHaveLength(2);
    expect(deriveSearchTerms(TITLES, 9)).toEqual(deriveSearchTerms(TITLES, 2));
  });

  it('honors a tighter budget by keeping the highest-coverage phrase', () => {
    expect(deriveSearchTerms(TITLES, 1)).toEqual(['data engineer']);
  });

  it('never emits a phrase longer than two tokens', () => {
    for (const t of deriveSearchTerms(TITLES, 5)) {
      expect(t.split(' ').length).toBeLessThanOrEqual(2);
    }
  });

  it('strips seniority, which never changes which role a title names', () => {
    expect(deriveSearchTerms(['Senior Data Engineer'], 1)).toEqual(['data engineer']);
    expect(deriveSearchTerms(['Principal Data Engineer II'], 1)).toEqual(['data engineer']);
    expect(deriveSearchTerms(['Staff Analytics Engineer'], 1)).toEqual(['analytics engineer']);
  });

  it('adapts to a completely different profile', () => {
    // The whole point: this is derived, not hardcoded to data roles.
    expect(deriveSearchTerms(['Registered Nurse', 'Nurse Practitioner'], 2))
      .toEqual(expect.arrayContaining(['registered nurse']));
    expect(deriveSearchTerms(['Tax Accountant'], 1)).toEqual(['tax accountant']);
  });

  it('returns nothing rather than a junk query for unusable input', () => {
    expect(deriveSearchTerms([])).toEqual([]);
    expect(deriveSearchTerms(undefined)).toEqual([]);
    expect(deriveSearchTerms(null)).toEqual([]);
    expect(deriveSearchTerms(['', '   ', 'of the'])).toEqual([]);
    expect(deriveSearchTerms(TITLES, 0)).toEqual([]);
  });
});

describe('run() — search phrase resolution', () => {
  const candidate = { targetTitles: TITLES };

  const searchTextsSent = async (source, ctx = {}) => {
    const { fetchImpl, calls } = stubCxs({});
    await workday.run({ ...FAST, tenants: [TENANT], ...source }, { fetchImpl, maxRetries: 0, ...ctx });
    return [...new Set(calls.map((c) => c.searchText))];
  };

  it('derives its phrases from candidate.targetTitles', async () => {
    expect(await searchTextsSent({}, { candidate })).toEqual(['data engineer', 'bi developer']);
  });

  it('lets a source pin phrases for every tenant', async () => {
    expect(await searchTextsSent({ searchTexts: ['etl developer'] }, { candidate }))
      .toEqual(['etl developer']);
  });

  it('lets a single tenant override the source', async () => {
    const sent = await searchTextsSent(
      { tenants: [{ ...TENANT, searchText: 'clinical data' }], searchTexts: ['etl developer'] },
      { candidate },
    );
    expect(sent).toEqual(['clinical data']);
  });

  it('treats an explicit empty searchText as "enumerate everything"', async () => {
    // Absent means "derive one"; empty string is a deliberate instruction and
    // must not be silently replaced by a derived phrase.
    expect(await searchTextsSent({ tenants: [{ ...TENANT, searchText: '' }] }, { candidate }))
      .toEqual(['']);
  });

  it('falls back to enumerating everything when there is no profile', async () => {
    expect(await searchTextsSent({}, {})).toEqual(['']);
  });

  it('respects maxSearchTerms as a cost ceiling', async () => {
    expect(await searchTextsSent({ maxSearchTerms: 1 }, { candidate })).toEqual(['data engineer']);
  });

  it('never sends a limit above 20, which the endpoint rejects outright', async () => {
    const { fetchImpl, calls } = stubCxs({});
    await workday.run(
      { ...FAST, tenants: [{ ...TENANT, pageSize: 500 }] },
      { fetchImpl, candidate, maxRetries: 0 },
    );
    expect(calls.every((c) => c.limit <= 20)).toBe(true);
  });
});

describe('run() — merging multiple phrases', () => {
  const candidate = { targetTitles: TITLES };

  it('returns the union of both phrases', async () => {
    const { fetchImpl } = stubCxs({
      'data engineer': [posting(1), posting(2)],
      'bi developer': [posting(3)],
    });
    const { jobs, errors } = await workday.run({ ...FAST, tenants: [TENANT] }, { fetchImpl, candidate, maxRetries: 0 });
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(3);
  });

  it('de-duplicates a requisition both phrases matched', async () => {
    // The same job legitimately matches both queries; storing it twice would
    // double-spend the detail budget and show the user a duplicate row.
    const shared = posting(1);
    const { fetchImpl } = stubCxs({
      'data engineer': [shared, posting(2)],
      'bi developer': [shared, posting(3)],
    });
    const { jobs } = await workday.run({ ...FAST, tenants: [TENANT] }, { fetchImpl, candidate, maxRetries: 0 });
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((j) => j.url)).size).toBe(3);
  });

  it('pages each phrase independently, reading total from page 0 only', async () => {
    const many = Array.from({ length: 45 }, (_, i) => posting(i));
    const { fetchImpl, calls } = stubCxs({ 'data engineer': many, 'bi developer': [] });
    const { jobs } = await workday.run({ ...FAST, tenants: [TENANT] }, { fetchImpl, candidate, maxRetries: 0 });
    expect(jobs).toHaveLength(45);
    const offsets = calls.filter((c) => c.searchText === 'data engineer').map((c) => c.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 20, 40]);
  });

  it('keeps one phrase’s results when the other fails outright', async () => {
    const fetchImpl = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.searchText === 'bi developer') return { ok: false, status: 503, headers: { get: () => null } };
      return { ok: true, json: async () => ({ total: body.offset === 0 ? 1 : 0, jobPostings: body.offset === 0 ? [posting(1)] : [] }) };
    };
    const { jobs, errors } = await workday.run({ ...FAST, tenants: [TENANT] }, { fetchImpl, candidate, maxRetries: 0 });
    expect(jobs).toHaveLength(1);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports a tenant-level failure when every phrase fails', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, headers: { get: () => null } });
    const { jobs, errors } = await workday.run({ ...FAST, tenants: [TENANT] }, { fetchImpl, candidate, maxRetries: 0 });
    expect(jobs).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('stops between phrases when the run is cancelled', async () => {
    const { fetchImpl, calls } = stubCxs({ 'data engineer': [posting(1)], 'bi developer': [posting(2)] });
    const { cancelled } = await workday.run(
      { ...FAST, tenants: [TENANT] },
      { fetchImpl, candidate, maxRetries: 0, shouldCancel: () => true },
    );
    expect(cancelled).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
