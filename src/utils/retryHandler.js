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
        // Record what we actually spent so the failure can report it honestly
        // instead of the RCA panel always printing "Retries spent: 0".
        if (err && typeof err === 'object' && err.attempts === undefined) {
          err.attempts = attempt;
        }
        throw err;
      }
      // A server that sent Retry-After told us exactly how long to wait. Obeying
      // it beats guessing: a blind 500ms/1s/2s curve just earns another 429.
      const retryAfter = Number(err?.retryAfterMs);
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter, maxDelayMs)
        // Exponential backoff: base * 2^attempt, capped, with bounded jitter.
        : jitter(Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs), 0.25, rng);
      attempt += 1;
      if (typeof onRetry === 'function') {
        onRetry({ attempt, delayMs, error: err });
      }
      await sleepFn(delayMs);
    }
  }
}
