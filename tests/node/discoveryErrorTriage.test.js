/**
 * Two ways a run's error panel lied about what happened.
 *
 * 1. A DESTROYED SOURCE REPORTED AS A MYSTERY. `oracleRecruiting` read `vocab`
 *    to spend its detail budget best-first, but never destructured it from the
 *    context it was passed in. Under ESM strict mode a free variable is a
 *    ReferenceError, not `undefined`, so every tenant threw AFTER its listings
 *    had already been fetched: 41 tenants, 41 identical "vocab is not defined"
 *    errors, zero jobs, and a panel entry categorized `unknown` that told the
 *    user to go read a stack trace. Measured after the fix, three tenants alone
 *    return 2,741 postings.
 *
 * 2. COST CONTROLS REPORTED AS FAILURES. Hitting a `maxDetailFetches` ceiling
 *    is a deliberate, documented budget: the postings past it are KEPT as
 *    `needs_description` and recovered with `npm run enrich`. They arrived in
 *    the panel as category `unknown` — "Unrecognized failure" — at counts of
 *    11,031 and 4,058, which drowned the handful of entries that were real.
 *
 * Both are about the same thing: an error panel is only useful if its
 * categories are true, so these pin the categories rather than the prose.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { classifyFailure, RCA_CATEGORIES } from '../../src/utils/failureRca.js';
import * as oracleRecruiting from '../../src/search/adapters/oracleRecruiting.js';

const REPO = process.cwd();

describe('oracleRecruiting can spend its detail budget without crashing', () => {
  /** One tenant's listing + detail endpoints, served from memory. */
  function fakeFetch({ postings = 3 } = {}) {
    return async (url) => {
      const href = String(url);
      if (href.includes('recruitingCEJobRequisitionDetails')) {
        return {
          ok: true, status: 200,
          json: async () => ({ items: [{ requisitionList: [{ ExternalDescriptionStr: 'Build data pipelines in SQL and Python.' }] }] }),
        };
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          items: [{
            requisitionList: Array.from({ length: postings }, (_, i) => ({
              Id: `req-${i}`, Title: `Senior Data Engineer ${i}`,
              PostedDate: new Date(Date.now() - 2 * 864e5).toISOString(),
              PrimaryLocation: 'Remote, United States',
            })),
            TotalJobsCount: postings,
          }],
        }),
      };
    };
  }

  const source = {
    id: 'oracle-recruiting', adapter: 'oracleRecruiting',
    tenants: [{ host: 'example.oraclecloud.com', siteNumber: 'CX_1', company: 'Example' }],
    maxDetailFetches: 2,
  };

  it('does not throw a ReferenceError when a candidate profile is present', async () => {
    // The profile is what puts `vocab` into the context, so it is the path that
    // used to fail — and the only path a real run ever takes.
    const candidate = JSON.parse(readFileSync(join(REPO, 'config', 'candidate.example.json'), 'utf8'));
    const result = await oracleRecruiting.run(source, { fetchImpl: fakeFetch(), candidate });

    const messages = result.errors.map((e) => String(e.error ?? ''));
    expect(messages.join(' | ')).not.toMatch(/is not defined/);
    expect(result.jobs.length).toBeGreaterThan(0);
  });

  it('still works with no profile at all, where vocab is legitimately null', async () => {
    const result = await oracleRecruiting.run(source, { fetchImpl: fakeFetch() });
    expect(result.errors.map((e) => String(e.error ?? '')).join(' | ')).not.toMatch(/is not defined/);
    expect(result.jobs.length).toBeGreaterThan(0);
  });
});

describe('run failures are categorized by what actually happened', () => {
  it('calls a detail-budget ceiling a budget, not an unrecognized failure', () => {
    const budgetNotices = [
      '11031 title match(es) were kept WITHOUT a description: the per-company detail budget '
        + '(maxDetailFetches=80) was reached. They are stored as needs_description, not judged.',
      '618 title match(es) on Peraton went unread: the per-portal detail budget '
        + '(maxDetailFetches=40) was reached. Raise it, or narrow the target titles, to cover them.',
      '214 title match(es) on the "rippling" board went unread: the per-board detail budget '
        + '(maxDetailFetches=40) was reached.',
    ];
    for (const message of budgetNotices) {
      const { category, guidance, retryable } = classifyFailure(message);
      expect(category).toBe('budget_exhausted');
      // Retrying changes nothing: the same ceiling applies to the next run.
      expect(retryable).toBe(false);
      expect(guidance).toMatch(/npm run enrich|maxDetailFetches/);
      expect(guidance).not.toMatch(/Unrecognized/);
    }
  });

  it('recognizes a missing API credential as configuration, not as a mystery', () => {
    const { category, guidance } = classifyFailure(
      'Missing Adzuna credentials. Register a free key at https://developer.adzuna.com/ '
      + 'and set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env.',
    );
    expect(category).toBe('missing_config');
    expect(guidance).not.toMatch(/Unrecognized/);
  });

  it('keeps the categories the rest of the run panel already relied on', () => {
    // Regression guard for the rewritten missing-config branch: broadening it
    // must not have swallowed the statuses that outrank every word heuristic.
    const cases = [
      ['Apify HTTP 401 for https://api.apify.com/v2/acts/x/runs', 'auth'],
      ['Greenhouse HTTP 404 for https://boards-api.greenhouse.io/v1/boards/x/jobs', 'missing_config'],
      ['Workday HTTP 410 for https://x.myworkdayjobs.com/y/jobs', 'missing_config'],
      ['Workday HTTP 422 for https://x.myworkdayjobs.com/y/jobs', 'provider_error'],
      ['HTTP 429 from the board', 'rate_limit'],
      ['fetch failed', 'network'],
      ['blocked (http-403-forbidden); skipped', 'auth'],
    ];
    for (const [message, expected] of cases) {
      expect(classifyFailure(message).category, message).toBe(expected);
    }
  });

  it('declares the new category, so the UI can render it', () => {
    expect(RCA_CATEGORIES).toContain('budget_exhausted');
  });
});

describe('the configured job boards are ones that can actually answer', () => {
  const jobboards = JSON.parse(readFileSync(join(REPO, 'config', 'jobboards.json'), 'utf8'));
  const byId = Object.fromEntries(jobboards.sources.map((s) => [s.id, s]));

  it('does not ask Greenhouse for a board that moved to another ATS', () => {
    // ClickHouse left Greenhouse (verified: HTTP 404) and is served by Ashby,
    // where it was ALREADY listed — so the Greenhouse entry could only ever
    // produce a 404, once per run, forever.
    expect(byId['greenhouse-boards'].boards).not.toContain('clickhouse');
    expect(byId['ashby-boards'].boards).toContain('clickhouse');
    // Surfaced by a full verification run, then probed: 404 on Greenhouse and
    // on Ashby, so there is no board left to ask.
    expect(byId['greenhouse-boards'].boards).not.toContain('berkadia');
  });

  it('does not ask Workday for tenants that are gone', () => {
    // comcast: HTTP 410 Gone, and its External site answers HTML rather than
    // the CXS JSON API. otis: HTTP 422 on every site name across four pods.
    const tenants = byId['workday-public'].tenants.map((t) => t.tenant);
    expect(tenants).not.toContain('comcast');
    expect(tenants).not.toContain('otis');
  });

  it('leaves credential-less sources disabled rather than failing every run', () => {
    for (const id of ['apify-scrapers', 'apify-linkedin', 'adzuna-aggregator']) {
      expect(byId[id].enabled, id).toBe(false);
      // Switched off, never deleted, and each says what turns it back on.
      expect(byId[id].options?.note ?? '', id).toMatch(/re-enable/i);
    }
  });

  it('still leaves a query-first source enabled, so role search works', () => {
    // "Search by job role" needs at least one adapter that searches ACROSS
    // employers. Disabling Adzuna is only safe because ats-search remains.
    const queryFirst = jobboards.sources
      .filter((s) => s.enabled && ['atsSearch', 'adzuna'].includes(s.adapter));
    expect(queryFirst.length).toBeGreaterThan(0);
  });
});
