import { describe, it, expect, vi } from 'vitest';
import { withRetry, defaultIsRetryable } from '../../src/utils/retryHandler.js';

const noSleep = () => Promise.resolve();

describe('retryHandler', () => {
  it('defaultIsRetryable: 429 and 5xx retry, 4xx do not', () => {
    expect(defaultIsRetryable({ status: 429 })).toBe(true);
    expect(defaultIsRetryable({ status: 503 })).toBe(true);
    expect(defaultIsRetryable({ status: 404 })).toBe(false);
    expect(defaultIsRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(defaultIsRetryable({ retryable: false, status: 500 })).toBe(false);
    expect(defaultIsRetryable(null)).toBe(false);
  });

  it('waits exactly as long as Retry-After asks, instead of guessing', async () => {
    const slept = [];
    const err = Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs: 7000 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    await withRetry(fn, { maxRetries: 2, sleepFn: async (ms) => { slept.push(ms); } });
    // A blind 500ms backoff here is what earns a second 429.
    expect(slept).toEqual([7000]);
  });

  it('caps a hostile Retry-After at maxDelayMs so one source cannot stall the run', async () => {
    const slept = [];
    const err = Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs: 3_600_000 });
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue('ok');
    await withRetry(fn, { maxRetries: 2, maxDelayMs: 15000, sleepFn: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([15000]);
  });

  it('records the attempts actually spent on the error it finally throws', async () => {
    // The RCA panel printed "Retries spent: 0" for every failure because nothing
    // ever wrote the real number down.
    const err = Object.assign(new Error('HTTP 429'), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxRetries: 3, sleepFn: noSleep })).rejects.toMatchObject({ attempts: 3 });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('returns immediately on success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { sleepFn: noSleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries retryable errors up to maxRetries then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValue('recovered');
    const onRetry = vi.fn();
    const result = await withRetry(fn, { maxRetries: 3, sleepFn: noSleep, onRetry });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-retryable errors', async () => {
    const err = { status: 400, message: 'bad request' };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { sleepFn: noSleep })).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting retries', async () => {
    const err = { status: 500 };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { maxRetries: 2, sleepFn: noSleep })).rejects.toEqual(err);
    expect(fn).toHaveBeenCalledTimes(3); // 1 + 2 retries
  });
});
