/**
 * Root-cause analysis: every failure category the workbench promises to
 * explain must classify correctly, carry actionable guidance, and never leak
 * credentials into the sanitized message.
 */
import { describe, it, expect } from 'vitest';

import { classifyFailure, sanitizeErrorMessage, buildRca, RCA_CATEGORIES } from '../../src/utils/failureRca.js';

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
