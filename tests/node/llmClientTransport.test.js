/**
 * LLM transport: text-only source, bounded retries on 429/5xx honouring
 * Retry-After, and a timeout that covers reading the body.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { completeJson, retryAfterToMs } from '../../src/llm/client.js';

const settings = (extra = {}) => ({
  enabled: true, apiKey: 'k', baseUrl: 'https://llm.invalid/v1', model: 'm', timeoutMs: 200, cacheDir: null, ...extra,
});
const ok = (content) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content } }] }) });
const status = (code, retryAfter = null) => ({ ok: false, status: code, headers: { get: (h) => (h === 'retry-after' ? retryAfter : null) } });

describe('llm client transport', () => {
  it('has no literal NUL bytes (git must treat it as text)', () => {
    expect(readFileSync('src/llm/client.js').includes(0)).toBe(false);
  });

  it('keeps the historical cache key (NUL-separated)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-'));
    try {
      await completeJson({ system: 's', user: 'u', settings: settings({ cacheDir: dir }) }, { fetchImpl: async () => ok('{"a":1}') });
      const expected = createHash('sha256').update('m\u0000s\u0000u').digest('hex').slice(0, 32);
      expect(readdirSync(dir)).toEqual([`${expected}.json`]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('retries 429 (honouring Retry-After) and 5xx, then succeeds', async () => {
    const replies = [status(429, '2'), status(503), ok('{"x":true}')];
    const sleeps = [];
    const r = await completeJson({ system: 's', user: 'u', settings: settings() }, {
      fetchImpl: async () => replies.shift(), sleepFn: async (ms) => { sleeps.push(ms); },
    });
    expect(r).toMatchObject({ ok: true, data: { x: true } });
    expect(sleeps[0]).toBe(2000);
    expect(sleeps).toHaveLength(2);
  });

  it('gives up after a bounded number of retries and never retries a 4xx', async () => {
    let calls = 0;
    const r = await completeJson({ system: 's', user: 'u', settings: settings() }, {
      fetchImpl: async () => { calls += 1; return status(500); }, sleepFn: async () => {},
    });
    expect(r).toMatchObject({ ok: false, error: 'provider returned HTTP 500' });
    expect(calls).toBe(3);
    calls = 0;
    await completeJson({ system: 's', user: 'u', settings: settings() }, {
      fetchImpl: async () => { calls += 1; return status(401); }, sleepFn: async () => {},
    });
    expect(calls).toBe(1);
  });

  it('times out a response whose body never arrives', async () => {
    const r = await completeJson({ system: 's', user: 'u', settings: settings({ timeoutMs: 50 }) }, {
      fetchImpl: async (_url, { signal }) => ({
        ok: true, status: 200, headers: { get: () => null },
        json: () => new Promise((_, reject) => signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        })),
      }),
    });
    expect(r).toMatchObject({ ok: false, error: 'timed out after 50ms' });
  });

  it('parses Retry-After seconds and dates', () => {
    expect(retryAfterToMs('3')).toBe(3000);
    expect(retryAfterToMs(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(retryAfterToMs('')).toBeNull();
  });
});
