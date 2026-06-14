import { describe, it, expect, vi } from 'vitest';
import { fetchWithTimeout } from '../../src/utils/httpClient.js';

describe('fetchWithTimeout', () => {
  it('passes through verbatim (no AbortSignal) when no timeout is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    await fetchWithTimeout(fetchImpl, 'http://x', { headers: { a: '1' } });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init).toEqual({ headers: { a: '1' } });
    expect(init.signal).toBeUndefined();
  });

  it('injects an AbortSignal when a timeout is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    await fetchWithTimeout(fetchImpl, 'http://x', {}, 1000);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeDefined();
    expect(typeof init.signal.aborted).toBe('boolean');
  });

  it('aborts a slow request and throws a retryable ETIMEDOUT error', async () => {
    // Simulate a hung request that only rejects when its signal aborts.
    const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
    const err = await fetchWithTimeout(fetchImpl, 'http://slow', {}, 10).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('ETIMEDOUT');
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/timed out after 10ms/);
  });

  it('resolves normally and clears the timer when the request is fast', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const res = await fetchWithTimeout(fetchImpl, 'http://fast', {}, 1000);
    expect(res.status).toBe(200);
  });

  it('propagates an externally-triggered abort as the original error', async () => {
    const external = new AbortController();
    const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    });
    const p = fetchWithTimeout(fetchImpl, 'http://x', { signal: external.signal }, 10_000);
    external.abort();
    const err = await p.catch((e) => e);
    // External abort is NOT rewritten into a timeout error.
    expect(err.code).not.toBe('ETIMEDOUT');
    expect(err.name).toBe('AbortError');
  });
});
