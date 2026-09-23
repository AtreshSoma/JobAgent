/**
 * Credentials must not survive into logs or notifications, whether they sit
 * under an obviously-secret key or inside an innocent-looking string.
 */
import { describe, expect, it } from 'vitest';

import { redact, scrubSecrets } from '../../src/utils/credentialManager.js';

const M = '[REDACTED]';

describe('secret key names', () => {
  it('masks names ending in key/secret/token/password, not only the old substrings', () => {
    const out = redact({
      ADZUNA_APP_KEY: 'k', JOB_AGENT_EXTENSION_KEY: 'x', appKey: 'a', clientSecret: 's',
      'x-auth-token': 't', dbPassword: 'p', company: 'Acme', title: 'Data Engineer',
    }, M, { env: {} });
    expect(out).toMatchObject({
      ADZUNA_APP_KEY: M, JOB_AGENT_EXTENSION_KEY: M, appKey: M, clientSecret: M,
      'x-auth-token': M, dbPassword: M, company: 'Acme', title: 'Data Engineer',
    });
  });
});

describe('secret values inside strings', () => {
  it('scrubs app_key and tokens from URLs, keeping the rest of the URL', () => {
    const url = 'https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=abc123&app_key=s3cr3tvalue&what=data';
    expect(scrubSecrets(url, { env: {} }))
      .toBe(`https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=abc123&app_key=${M}&what=data`);
    expect(scrubSecrets('GET /x?access_token=abcdef&page=2', { env: {} })).toBe(`GET /x?access_token=${M}&page=2`);
  });

  it('scrubs the literal value of any secret env var wherever it appears', () => {
    const env = { APIFY_TOKEN: 'apify_api_ABCDEFGH12345', RUN_MODE: 'DRY_RUN', HEADLESS: 'true' };
    const out = redact({ error: 'actor failed for token apify_api_ABCDEFGH12345 (401)', mode: 'DRY_RUN' }, M, { env });
    expect(out.error).toBe(`actor failed for token ${M} (401)`);
    // Non-secret env values are never treated as secrets.
    expect(out.mode).toBe('DRY_RUN');
  });

  it('scrubs Authorization headers and bearer tokens, but not job-description prose', () => {
    expect(scrubSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload', { env: {} })).toBe(`Authorization: ${M}`);
    expect(scrubSecrets('sent Bearer abcdefghijklmnop0123 upstream', { env: {} })).toBe(`sent Bearer ${M} upstream`);
    const jd = 'Basic Qualifications: 5+ years with Spark. Preferred Qualifications: Kafka.';
    expect(scrubSecrets(jd, { env: {} })).toBe(jd);
  });

  it('scrubs nested strings and arrays and never mutates the input', () => {
    const input = { nested: { url: 'https://x.test/?api_key=zzz' }, list: ['https://y.test/?token=abc'] };
    const out = redact(input, M, { env: {} });
    expect(out.nested.url).toBe(`https://x.test/?api_key=${M}`);
    expect(out.list[0]).toBe(`https://y.test/?token=${M}`);
    expect(input.nested.url).toBe('https://x.test/?api_key=zzz');
  });
});
