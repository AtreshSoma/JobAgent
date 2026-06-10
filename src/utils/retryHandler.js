/**
 * Retry with exponential backoff and jitter for SAFE, transient failures only.
 *
 * Only retries errors explicitly marked retryable (or matching a predicate).
 * Never retries on logic errors, validation errors, or auth failures.
 */

import { sleep, jitter } from './rateLimiter.js';

/**
 * Default predicate: retry network-ish/transient errors and 429/5xx statuses.
 * @param {any} err
 * @returns {boolean}
 */
export function defaultIsRetryable(err) {
  if (!err) return false;
  if (err.retryable === true) return true;
  if (err.retryable === false) return false;

  const status = err.status ?? err.statusCode ?? err.response?.status;
  if (typeof status === 'number') {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }

  const transientCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'EPIPE',
  ]);
  if (err.code && transientCodes.has(err.code)) return true;

  return false;
}

/**
 * Run `fn` with retries.
 *
 * @template T
 * @param {() => Promise<T>} fn operation to attempt
 * @param {object} [options]
 * @param {number} [options.maxRetries=3] retries after the first attempt
 * @param {number} [options.baseDelayMs=500] base backoff delay
 * @param {number} [options.maxDelayMs=15000] cap on a single backoff delay
 * @param {(err: any) => boolean} [options.isRetryable=defaultIsRetryable]
 * @param {(info: {attempt: number, delayMs: number, error: any}) => void} [options.onRetry]
 * @param {(ms: number) => Promise<void>} [options.sleepFn=sleep] for testing
 * @param {() => number} [options.rng=Math.random] for testing
 * @returns {Promise<T>}
 */
export async function withRetry(fn, {
  maxRetries = 3,
  baseDelayMs = 500,
  maxDelayMs = 15000,
  isRetryable = defaultIsRetryable,
  onRetry,
  sleepFn = sleep,
  rng = Math.random,
} = {}) {
  let attempt = 0;
  // total attempts = maxRetries + 1
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt >= maxRetries;
      if (isLast || !isRetryable(err)) {
        throw err;
      }
      // Exponential backoff: base * 2^attempt, capped, with bounded jitter.
      const raw = baseDelayMs * Math.pow(2, attempt);
      const capped = Math.min(raw, maxDelayMs);
      const delayMs = jitter(capped, 0.25, rng);
      attempt += 1;
      if (typeof onRetry === 'function') {
        onRetry({ attempt, delayMs, error: err });
      }
      await sleepFn(delayMs);
    }
  }
}
