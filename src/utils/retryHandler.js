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
  const code = errorCode(err);
  if (code && transientCodes.has(code)) return true;

  return false;
}

/**
 * The low-level error code, wherever the runtime put it.
 *
 * Node's fetch (undici) does not set `code` on the error it throws: it throws
 * `TypeError: fetch failed` and hangs the socket error off `cause`. Reading
 * only `err.code` meant a DNS failure was classified by prose, not by code.
 *
 * @param {any} err
 * @returns {string|null}
 */
export function errorCode(err) {
  return err?.code ?? err?.cause?.code ?? null;
}

/**
 * A host that does not resolve.
 *
 * Worth exactly ONE retry — a resolver blip is real, and it clears in a second.
 * Beyond that it is a typo'd or decommissioned host (a careers domain that
 * moved), and spending the full backoff curve on it is ~8s of wall clock per
 * request that can never succeed.
 */
const DNS_FAILURE_CODES = new Set(['ENOTFOUND']);

/** Retries allowed for a DNS failure, whatever `maxRetries` says. */
const MAX_DNS_RETRIES = 1;

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
      const dnsExhausted = DNS_FAILURE_CODES.has(errorCode(err)) && attempt >= MAX_DNS_RETRIES;
      const isLast = attempt >= maxRetries || dnsExhausted;
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
