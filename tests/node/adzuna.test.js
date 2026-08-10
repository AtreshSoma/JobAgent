/**
 * Adzuna aggregator adapter — offline tests with stubbed fetch.
 *
 * The response shapes below follow Adzuna's published schema
 * (Adzuna::API::Response::Job / ::Ad / ::Location) and were confirmed against a
 * real key on 2026-08-01 (see docs/SUPPORT_MATRIX.md). That same live run showed
 * `what_phrase` matches anywhere in the posting, not just the title — a "Data
 * Engineer" query returned 31,148 results including "Accounts Payable
 * Administrator". The title gate below (reused from atsSearch, which hit the
 * identical problem on Workable/SmartRecruiters) is what makes the adapter
 * usable rather than a source of noise.
 */
import { describe, it, expect, vi } from 'vitest';

import * as adzuna from '../../src/search/adapters/adzuna.js';
import { buildSearchUrl, mapJob, stripQuery } from '../../src/search/adapters/adzuna.js';
import { adapterKind, sourceKind } from '../../src/search/sources.js';
import { ADAPTERS } from '../../src/search/index.js';

const ROW = {
  id: '4321',
  created: '2026-07-30T09:00:00Z',
  title: 'Senior Data Engineer',
  description: 'Short blurb truncated by the API...',
  full_description: 'Own the Azure data platform. Spark, Databricks, and dbt.',
  redirect_url: 'https://www.adzuna.com/land/ad/4321',
  company: { display_name: 'Acme Analytics' },
  location: { display_name: 'Austin, Texas', area: ['US', 'Texas', 'Austin'] },
  contract_type: 'permanent',
  contract_time: 'full_time',
  salary_min: 150000,
  salary_max: 185000,
  salary_is_predicted: '0',
  category: { label: 'IT Jobs' },
};

const CREDS = { ADZUNA_APP_ID: 'id-123', ADZUNA_APP_KEY: 'key-456' };

describe('registration', () => {
  it('is wired in as a real discovery adapter', () => {
    expect(ADAPTERS.adzuna).toBeDefined();
    expect(adapterKind('adzuna')).toBe('discovery');
    expect(sourceKind('adzuna')).toBe('discovery');
  });
});

describe('buildSearchUrl', () => {
  const url = buildSearchUrl({
    country: 'us', page: 1, appId: 'id-123', appKey: 'key-456',
    query: 'Senior Data Engineer', where: 'United States', perPage: 50, maxDaysOld: 7,
  });
  const parsed = new URL(url);

  it('targets the documented search path', () => {
    expect(parsed.host).toBe('api.adzuna.com');
    expect(parsed.pathname).toBe('/v1/api/jobs/us/search/1');
  });

  it('uses what_phrase, not what, so terms are not OR-matched', () => {
    expect(parsed.searchParams.get('what_phrase')).toBe('Senior Data Engineer');
    expect(parsed.searchParams.get('what')).toBeNull();
  });

  it('carries credentials, freshness and date sorting', () => {
    expect(parsed.searchParams.get('app_id')).toBe('id-123');
    expect(parsed.searchParams.get('app_key')).toBe('key-456');
    expect(parsed.searchParams.get('max_days_old')).toBe('7');
    expect(parsed.searchParams.get('sort_by')).toBe('date');
    expect(parsed.searchParams.get('results_per_page')).toBe('50');
  });
});

describe('stripQuery', () => {
  it('removes the query string so a logged URL cannot leak the API key', () => {
    expect(stripQuery('https://api.adzuna.com/v1/api/jobs/us/search/1?app_key=secret'))
      .toBe('https://api.adzuna.com/v1/api/jobs/us/search/1');
    expect(stripQuery('https://api.adzuna.com/x')).toBe('https://api.adzuna.com/x');
  });
});

describe('mapJob', () => {
  it('maps a result to the normalized shape', () => {
    const job = mapJob(ROW, 'Senior Data Engineer');
    expect(job.source).toBe('adzuna');
    expect(job.sourceJobId).toBe('4321');
    expect(job.company).toBe('Acme Analytics');
    expect(job.title).toBe('Senior Data Engineer');
    expect(job.location).toBe('Austin, Texas');
    expect(job.postedAt).toBe('2026-07-30T09:00:00Z');
    expect(job.employmentType).toBe('full_time, permanent');
  });

  it('prefers full_description and marks blurb-only rows summaryOnly', () => {
    expect(mapJob(ROW).jdText).toContain('Databricks');
    expect(mapJob(ROW).rawMetadata.summaryOnly).toBe(false);

    const blurbOnly = mapJob({ ...ROW, full_description: undefined });
    expect(blurbOnly.jdText).toContain('Short blurb');
    expect(blurbOnly.rawMetadata.summaryOnly).toBe(true);
  });

  it("uses redirect_url as the apply URL, as Adzuna's terms require", () => {
    expect(mapJob(ROW).url).toBe('https://www.adzuna.com/land/ad/4321');
    // No redirect_url means no compliant way to send the user anywhere.
    expect(mapJob({ ...ROW, redirect_url: '' })).toBeNull();
  });

  it('reverses the broadest-first area chain when display_name is absent', () => {
    const job = mapJob({ ...ROW, location: { area: ['US', 'Texas', 'Austin'] } });
    expect(job.location).toBe('Austin, Texas, US');
  });

  it('records an advertised salary but never a predicted one', () => {
    expect(mapJob(ROW).rawMetadata.compensation).toBe('$150,000 - $185,000');
    expect(mapJob({ ...ROW, salary_is_predicted: '1' }).rawMetadata.compensation).toBeUndefined();
  });

  it('returns null for unusable rows', () => {
    expect(mapJob(null)).toBeNull();
    expect(mapJob({ redirect_url: 'https://x/y' })).toBeNull();
  });
});

describe('run()', () => {
  const candidate = { targetTitles: ['Senior Data Engineer', 'Analytics Engineer'] };

  it('refuses to run without credentials and says how to get them', async () => {
    const fetchImpl = vi.fn();
    const { jobs, errors } = await adzuna.run({ options: {} }, { fetchImpl, env: {}, candidate });
    expect(jobs).toEqual([]);
    expect(errors[0].category).toBe('missing_credentials');
    expect(errors[0].error).toContain('developer.adzuna.com');
    // Critically: it must not burn a call to discover it has no key.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('derives queries from candidate.targetTitles and maps results', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, json: async () => ({ count: 1, results: [ROW] }),
    }));
    const { jobs, errors } = await adzuna.run(
      { options: { maxPages: 1 } },
      { fetchImpl, env: CREDS, candidate, maxRetries: 0 },
    );
    expect(errors).toEqual([]);
    expect(jobs).toHaveLength(2); // one per target title
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Regression: `what_phrase` is a full-text match, not a title match. Verified
  // live — "Data Engineer" returned 31,148 results, including titles like
  // "Accounts Payable Administrator" that merely mention data engineers
  // somewhere in the body. Without this gate, every generic query floods the
  // pipeline with off-target noise exactly like Workable/SmartRecruiters did
  // before atsSearch's makeTitleGate.
  describe('title gate (regression: what_phrase matches full text, not title)', () => {
    const candidate = { targetTitles: ['Data Engineer', 'Business Intelligence Developer'] };
    const OFF_TARGET = { ...ROW, id: 'noise', title: 'Accounts Payable Administrator' };
    const ON_TARGET = { ...ROW, id: 'good', title: 'Senior Data Engineer' };

    it('drops rows whose title is not actually on-target', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true, json: async () => ({ results: [OFF_TARGET, ON_TARGET] }),
      }));
      const { jobs } = await adzuna.run(
        { options: { queries: ['Data Engineer'], maxPages: 1 } },
        { fetchImpl, env: CREDS, candidate, maxRetries: 0 },
      );
      expect(jobs.map((j) => j.sourceJobId)).toEqual(['good']);
    });

    it('keeps a generic role-shaped title even off the exact candidate list', async () => {
      // Mirrors atsSearch's ROLE_TOKEN_RE fallback — a BI/ETL/analytics-shaped
      // title should survive even when it is not a verbatim target title.
      const genericFit = { ...ROW, id: 'etl', title: 'ETL Warehouse Developer' };
      const fetchImpl = vi.fn(async () => ({
        ok: true, json: async () => ({ results: [OFF_TARGET, genericFit] }),
      }));
      const { jobs } = await adzuna.run(
        { options: { queries: ['Data Engineer'], maxPages: 1 } },
        { fetchImpl, env: CREDS, candidate, maxRetries: 0 },
      );
      expect(jobs.map((j) => j.sourceJobId)).toEqual(['etl']);
    });

    it('can be disabled via strictTitleMatch: false', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true, json: async () => ({ results: [OFF_TARGET] }),
      }));
      const { jobs } = await adzuna.run(
        { options: { queries: ['Data Engineer'], maxPages: 1, strictTitleMatch: false } },
        { fetchImpl, env: CREDS, candidate, maxRetries: 0 },
      );
      expect(jobs).toHaveLength(1);
    });

    it('gates on the configured queries when there is no candidate profile', async () => {
      const fetchImpl = vi.fn(async () => ({
        ok: true, json: async () => ({ results: [OFF_TARGET, ON_TARGET] }),
      }));
      const { jobs } = await adzuna.run(
        { options: { queries: ['Data Engineer'], maxPages: 1 } },
        { fetchImpl, env: CREDS, maxRetries: 0 }, // no candidate
      );
      expect(jobs.map((j) => j.sourceJobId)).toEqual(['good']);
    });
  });

  it('stops paging a query as soon as a short page arrives', async () => {
    // The free tier is ~1,000 calls/month; spending them on empty pages is the
    // difference between covering every title and running out mid-month.
    const fetchImpl = vi.fn(async () => ({
      ok: true, json: async () => ({ results: [ROW] }),
    }));
    await adzuna.run(
      { options: { queries: ['Data Engineer'], maxPages: 5, resultsPerPage: 50 } },
      { fetchImpl, env: CREDS, maxRetries: 0 },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps earlier pages when a later page fails', async () => {
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, json: async () => ({ results: Array.from({ length: 2 }, (_, i) => ({ ...ROW, id: `p${i}` })) }) };
      }
      return { ok: false, status: 500, headers: { get: () => null } };
    };
    const { jobs, errors } = await adzuna.run(
      { options: { queries: ['Data Engineer'], maxPages: 3, resultsPerPage: 2 } },
      { fetchImpl, env: CREDS, maxRetries: 0 },
    );
    expect(jobs).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it('never puts the API key in an error message', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, headers: { get: () => null } });
    const { errors } = await adzuna.run(
      { options: { queries: ['Data Engineer'], maxPages: 1 } },
      { fetchImpl, env: CREDS, maxRetries: 0 },
    );
    expect(errors).toHaveLength(1);
    expect(errors[0].error).not.toContain('key-456');
    expect(errors[0].error).not.toContain('id-123');
  });

  it('stops promptly when the run is cancelled', async () => {
    const fetchImpl = vi.fn();
    const { cancelled } = await adzuna.run(
      { options: { queries: ['Data Engineer'] } },
      { fetchImpl, env: CREDS, shouldCancel: () => true, maxRetries: 0 },
    );
    expect(cancelled).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
