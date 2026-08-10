/**
 * Root-cause analysis: every failure category the workbench promises to
 * explain must classify correctly, carry actionable guidance, and never leak
 * credentials into the sanitized message.
 */
import { describe, it, expect } from 'vitest';

import {
  classifyFailure, sanitizeErrorMessage, buildRca, RCA_CATEGORIES,
  inferScope, unitLabelFor,
} from '../../src/utils/failureRca.js';

describe('classifyFailure', () => {
  const cases = [
    ['timeout', Object.assign(new Error('request timed out after 15000ms'), { code: 'ETIMEDOUT' })],
    ['timeout', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['dns', Object.assign(new Error('getaddrinfo ENOTFOUND boards.greenhouse.io'), { code: 'ENOTFOUND' })],
    ['network', Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })],
    ['network', new Error('fetch failed')],
    ['auth', Object.assign(new Error('Unauthorized'), { statusCode: 401 })],
    ['auth', new Error('HTTP 403 Forbidden for url')],
    ['rate_limit', Object.assign(new Error('Too Many Requests'), { statusCode: 429 })],
    ['provider_error', Object.assign(new Error('Internal Server Error'), { statusCode: 502 })],
    ['invalid_json', new Error('Unexpected token < in JSON at position 0')],
    ['db_busy', new Error('SQLITE_BUSY: database is locked')],
    ['missing_resume', new Error('Master resume not found: resumes/base/MASTER_RESUME.docx')],
    ['missing_config', new Error('Missing Apify token. Set APIFY_TOKEN in your .env file.')],
    ['browser_launch', new Error("could not start browser: executable doesn't exist")],
    ['empty_response', new Error('empty response from provider')],
    ['schema_changed', new Error('missing required field "jobs" in response')],
    ['unknown', new Error('something completely different')],
  ];
  for (const [expected, err] of cases) {
    it(`classifies "${err.message}" as ${expected}`, () => {
      const c = classifyFailure(err);
      expect(c.category).toBe(expected);
      expect(RCA_CATEGORIES).toContain(c.category);
      expect(typeof c.guidance).toBe('string');
      expect(c.guidance.length).toBeGreaterThan(10);
    });
  }

  it('explicit context.status and context.category win over message heuristics', () => {
    expect(classifyFailure(new Error('weird'), { status: 429 }).category).toBe('rate_limit');
    expect(classifyFailure(new Error('weird'), { category: 'schema_changed' }).category).toBe('schema_changed');
  });

  it('an HTTP status in the message outranks prose that merely LOOKS like a network fault', () => {
    // Regression: an adapter wraps a 429 as "detail fetch failed (… HTTP 429 …)".
    // The substring "fetch failed" used to win the network rule, so the user was
    // told to check their internet connection while a board was throttling them.
    const wrapped = 'detail fetch failed (Workday detail HTTP 429 for https://nvidia.wd5.myworkdayjobs.com/j); kept summaryOnly';
    expect(classifyFailure(wrapped).category).toBe('rate_limit');

    expect(classifyFailure(new Error('fetch failed (Greenhouse HTTP 503 for https://x)')).category).toBe('provider_error');
    expect(classifyFailure(new Error('fetch failed (HTTP 403 for https://x)')).category).toBe('auth');
    // A board token that no longer exists is a config problem, not a network one.
    expect(classifyFailure(new Error('Lever HTTP 404 for https://api.lever.co/v0/postings/gone')).category).toBe('missing_config');
  });

  it('still calls a genuine transport failure a network failure', () => {
    // The status-first rule must not swallow the real thing: no status, no code.
    expect(classifyFailure(new Error('fetch failed')).category).toBe('network');
  });

  it('marks transient categories retryable and credential problems not', () => {
    expect(classifyFailure(new Error('x'), { status: 503 }).retryable).toBe(true);
    expect(classifyFailure(new Error('x'), { status: 401 }).retryable).toBe(false);
  });
});

describe('sanitizeErrorMessage', () => {
  it('redacts bearer tokens, apify tokens, key=value secrets, and URL secrets', () => {
    const dirty = 'HTTP 401 for https://api.apify.com/v2/acts?token=apify_api_SECRET123456 '
      + 'Authorization: Bearer abc.def.ghi-jkl token=supersecretvalue apikey="abcdef123456"';
    const clean = sanitizeErrorMessage(dirty);
    expect(clean).not.toMatch(/SECRET123456|abc\.def\.ghi|supersecretvalue|abcdef123456/);
    expect(clean).toContain('[REDACTED]');
  });
  it('leaves ordinary messages intact', () => {
    expect(sanitizeErrorMessage('connect ECONNREFUSED 127.0.0.1:443')).toBe('connect ECONNREFUSED 127.0.0.1:443');
  });
});

describe('buildRca', () => {
  it('produces a complete, UI-ready entry for a per-source failure', () => {
    const entry = buildRca({
      operation: 'discover',
      source: 'greenhouse',
      error: Object.assign(new Error('HTTP 429 Too Many Requests'), { statusCode: 429 }),
      runId: 'run-1',
      attempt: 2,
      partialResultsValid: true,
      now: new Date('2026-07-11T12:00:00Z'),
    });
    expect(entry).toMatchObject({
      runId: 'run-1', source: 'greenhouse', operation: 'discover',
      category: 'rate_limit', retryable: true, retryCount: 2,
      partialResultsValid: true, status: 429,
    });
    expect(entry.at).toBe('2026-07-11T12:00:00.000Z');
    expect(entry.impact).toContain('greenhouse');
    expect(entry.guidance).toMatch(/rate/i);
  });
});

describe('blast radius: "missing" must mean missing', () => {
  it('does not claim results are missing when the source delivered jobs', () => {
    // THE BUG THIS PINS. A live run reported, verbatim:
    //   workday-public  38,830 found · 1 error · partial
    //   "Results from workday-public are missing from this run"
    // Both the FAILED badge and the impact line were false — 38,830 jobs were
    // sitting on the board. Whether results are missing is not a property of
    // the error; it is the relationship between the error and what was
    // delivered, so `kept` decides it.
    const entry = buildRca({
      operation: 'discover', source: 'workday-public', error: 'fetch failed',
      kept: 38830, scope: 'board', unitLabel: 'citi',
    });
    expect(entry.outcome).toBe('partial');
    expect(entry.impact).not.toMatch(/are missing from this run/);
    expect(entry.impact).toContain('38,830');
    expect(entry.impact).toContain('kept');
    // A board-scope loss costs a whole employer — name it, and say so.
    expect(entry.impact).toContain('citi');
    expect(entry.impact).toContain('that employer contributed nothing');
  });

  it('reports a page-scope loss as a subset, not a dead source', () => {
    const entry = buildRca({
      operation: 'discover', source: 'adzuna-aggregator',
      error: 'Adzuna HTTP 503 for https://api.adzuna.com/v1/api/jobs/us/search/2',
      status: 503, attempt: 3, kept: 691, scope: 'page',
    });
    expect(entry.outcome).toBe('partial');
    expect(entry.impact).toContain('691');
    expect(entry.impact).toContain('1 page failed');
    expect(entry.impact).not.toMatch(/are missing from this run/);
  });

  it('still says missing when the source genuinely returned nothing', () => {
    const entry = buildRca({
      operation: 'discover', source: 'dice-public', error: 'HTTP 403', status: 403, kept: 0,
    });
    expect(entry.outcome).toBe('failed');
    expect(entry.impact).toMatch(/returned no jobs|missing entirely/);
  });

  it('keeps degraded meaning "kept but lower fidelity", never missing', () => {
    const entry = buildRca({
      operation: 'discover', source: 'oracle-recruiting',
      error: 'detail budget reached', degraded: true, kept: 190, count: 95,
    });
    expect(entry.outcome).toBe('degraded');
    expect(entry.impact).toContain('KEPT');
    expect(entry.impact).not.toMatch(/are missing from this run/);
  });

  it('does not assert either way when the caller did not report delivery', () => {
    // Absence of evidence is not evidence of loss.
    const entry = buildRca({ operation: 'discover', source: 'x', error: 'boom' });
    expect(entry.outcome).toBe('unknown');
    expect(entry.kept).toBeNull();
  });

  it('infers the failing unit from the fields adapters already attach', () => {
    expect(inferScope({ offset: 100, searchText: 'data engineer' })).toBe('page');
    expect(inferScope({ tenant: 'citi', site: 'External' })).toBe('board');
    expect(inferScope({ board: 'acme' })).toBe('board');
    expect(inferScope({ error: 'generic' })).toBe('source');
    // An explicit scope always wins over inference.
    expect(inferScope({ scope: 'source', offset: 1 })).toBe('source');
    expect(unitLabelFor({ tenant: 'citi' })).toBe('citi');
    expect(unitLabelFor({ company: 'Acme Corp' })).toBe('Acme Corp');
    expect(unitLabelFor({})).toBeNull();
  });
});
