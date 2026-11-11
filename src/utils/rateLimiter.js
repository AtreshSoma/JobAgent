/**
 * Respectful, per-source rate limiting.
 *
 * This is for politeness and stability, NOT evasion. It enforces a minimum
 * spacing between requests to a given source and adds a small bounded jitter.
 */

/**
 * Sleep for `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return new Promise((resolve) => setTimeout(resolve, n));
}

/**
 * Small bounded jitter (+/- jitterRatio of base) for stability, not evasion.
 * @param {number} baseMs
 * @param {number} [jitterRatio=0.2]
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function jitter(baseMs, jitterRatio = 0.2, rng = Math.random) {
  const base = Math.max(0, Number(baseMs) || 0);
  const spread = base * jitterRatio;
  const delta = (rng() * 2 - 1) * spread;
  return Math.max(0, Math.round(base + delta));
}

/**
 * Creates a rate limiter that spaces calls per logical key (e.g. source id).
 *
 * ONE KEY, ONE CALLER AT A TIME. `wait()` reads the key's last-call stamp and
 * writes it back only after sleeping, so callers that are already in flight
 * concurrently all read the SAME stamp, all sleep the same interval, and are
 * released together. Measured: 48 concurrent waiters on one key at
 * minIntervalMs=3000 were all released at 3008ms — one burst, not 141s of
 * spacing. Used that way it enforces no spacing and only adds latency, which is
 * what it was doing for four adapters that keyed it on a constant host string.
 *
 * So: use this to space a SEQUENTIAL series of calls (a paging loop, one
 * per-key request per run). To bound CONCURRENT requests against a shared host,
 * use `createHostGate` — it queues properly, honors Retry-After, and trips a
 * breaker on repeated 429s.
 *
 * @param {object} [options]
 * @param {number} [options.minIntervalMs=3000] minimum spacing between calls
 * @param {number} [options.jitterRatio=0.2] bounded jitter applied to spacing
 * @param {() => number} [options.now] time source (ms), for testing
 * @param {(ms: number) => Promise<void>} [options.sleepFn] sleep impl, for testing
 * @param {() => number} [options.rng] randomness source, for testing
 */
export function createRateLimiter({
  minIntervalMs = 3000,
  jitterRatio = 0.2,
  now = () => Date.now(),
  sleepFn = sleep,
  rng = Math.random,
} = {}) {
  /** @type {Map<string, number>} last completion time per key */
  const lastCall = new Map();

  /**
   * Wait until enough time has elapsed since the last call for `key`.
   * @param {string} [key='default']
   * @param {number} [intervalMs] override the default interval for this call
   * @returns {Promise<number>} the number of ms waited
   */
  async function wait(key = 'default', intervalMs) {
    const interval = Number.isFinite(intervalMs) ? intervalMs : minIntervalMs;
    const spacing = jitter(interval, jitterRatio, rng);
    const last = lastCall.get(key);
    const current = now();

    let waited = 0;
    if (last !== undefined) {
      const elapsed = current - last;
      const remaining = spacing - elapsed;
      if (remaining > 0) {
        waited = remaining;
        await sleepFn(remaining);
      }
    }
    lastCall.set(key, now());
    return waited;
  }

  /** Reset the recorded timing for one key or all keys. */
  function reset(key) {
    if (key === undefined) lastCall.clear();
    else lastCall.delete(key);
  }

  return { wait, reset };
}
