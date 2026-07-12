/**
 * Host-aware politeness gate.
 *
 * WHY THIS EXISTS
 *
 * Rate limits are enforced by the HOST. The rate limiter this sits beside is
 * keyed by the LOGICAL entity — a Greenhouse board token, a Workday tenant, a
 * page offset — and every one of those keys is used at most once per run. A key
 * used once never has a previous call to space against, so `wait()` returned
 * immediately every single time: the limiter was decorative, and dozens of
 * requests landed on one host at once.
 *
 * That is exactly how a discovery run earns an HTTP 429. Every Greenhouse board
 * shares `boards-api.greenhouse.io`; every Lever company shares `api.lever.co`;
 * and Workday tenants share a pod (`nvidia.wd5…`, `target.wd5…`, `citi.wd5…`
 * are all `wd5.myworkdayjobs.com`). Keying politeness by host — and by pod for
 * Workday — is the only way the budget we spend matches the budget the server
 * is counting.
 *
 * WHAT IT DOES
 *
 *   - bounds in-flight requests PER HOST (the politeness mechanism — never evasion)
 *   - honors `Retry-After` from a 429/503 for every caller of that host, not
 *     just the one request that happened to get throttled
 *   - trips a circuit breaker after repeated 429s so a throttled host is left
 *     alone instead of being hammered by retries of every remaining job
 *
 * This is a slow-down mechanism. It never bypasses, spoofs, or evades a limit —
 * it makes us obey one we were previously ignoring by accident.
 */

import { sleep } from './rateLimiter.js';

/** Error thrown when a host's breaker is open. Deliberately NOT retryable. */
export class HostCircuitOpenError extends Error {
  /** @param {string} host */
  constructor(host) {
    super(`skipped: ${host} is rate-limiting us (circuit open) — backing off`);
    this.name = 'HostCircuitOpenError';
    this.code = 'HOST_CIRCUIT_OPEN';
    this.host = host;
    /** withRetry must not retry this — backing off is the whole point. */
    this.retryable = false;
    this.circuitOpen = true;
  }
}

/**
 * The key a host's limit is actually enforced against.
 *
 * Workday runs many tenants on one shared pod and throttles at the pod, so
 * `nvidia.wd5.myworkdayjobs.com` and `citi.wd5.myworkdayjobs.com` must share a
 * budget. Everything else is keyed by hostname.
 *
 * @param {string|URL} url
 * @returns {string}
 */
export function hostKeyFor(url) {
  let hostname;
  try {
    hostname = (url instanceof URL ? url : new URL(String(url))).hostname.toLowerCase();
  } catch {
    return String(url ?? 'unknown').toLowerCase();
  }
  // {tenant}.wd{N}.myworkdayjobs.com -> wd{N}.myworkdayjobs.com (the shared pod)
  const pod = /^[^.]+\.(wd\d+\.myworkdayjobs\.com)$/.exec(hostname);
  if (pod) return pod[1];
  return hostname;
}

/** Statuses that mean "you are going too fast" rather than "this is broken". */
function isThrottleStatus(status) {
  return status === 429 || status === 503;
}

/**
 * @param {object} [options]
 * @param {number} [options.maxConcurrent=4] in-flight requests allowed per host
 * @param {number} [options.minSpacingMs=0] minimum gap between request STARTS per host
 * @param {number} [options.baseCooldownMs=2000] cooldown when a 429 carries no Retry-After
 * @param {number} [options.maxCooldownMs=60000] cap on any single cooldown
 * @param {number} [options.breakerThreshold=4] consecutive throttles before the breaker opens
 * @param {number} [options.breakerOpenMs=60000] how long the breaker stays open
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleepFn]
 */
export function createHostGate({
  maxConcurrent = 4,
  minSpacingMs = 0,
  baseCooldownMs = 2000,
  maxCooldownMs = 60000,
  breakerThreshold = 4,
  breakerOpenMs = 60000,
  now = () => Date.now(),
  sleepFn = sleep,
} = {}) {
  /**
   * @typedef {object} HostState
   * @property {number} inFlight
   * @property {Array<() => void>} queue waiters for a slot
   * @property {number} nextStartAt earliest ms at which a request may start
   * @property {number} consecutiveThrottles
   * @property {number} openUntil breaker open until this ms (0 = closed)
   * @property {number} throttleEvents total 429/503 seen (for reporting)
   */
  /** @type {Map<string, HostState>} */
  const hosts = new Map();

  function stateFor(key) {
    let s = hosts.get(key);
    if (!s) {
      s = { inFlight: 0, queue: [], nextStartAt: 0, consecutiveThrottles: 0, openUntil: 0, throttleEvents: 0 };
      hosts.set(key, s);
    }
    return s;
  }

  async function acquire(s) {
    if (s.inFlight < maxConcurrent) {
      s.inFlight += 1;
      return;
    }
    // The releaser hands its slot straight to us, so we must NOT increment
    // again — doing so would let in-flight drift above the ceiling.
    await new Promise((resolve) => s.queue.push(resolve));
  }

  function release(s) {
    const next = s.queue.shift();
    // Hand the slot to a waiter (in-flight unchanged) rather than freeing it and
    // racing a fresh caller for it.
    if (next) next();
    else s.inFlight -= 1;
  }

  /** True while the host's breaker is open (auto-closes when it expires). */
  function isOpenKey(key) {
    const s = hosts.get(key);
    if (!s || s.openUntil === 0) return false;
    if (now() >= s.openUntil) {
      // Half-open: let the next caller through and see what happens.
      s.openUntil = 0;
      s.consecutiveThrottles = 0;
      return false;
    }
    return true;
  }

  /** @param {string|URL} url */
  function isOpen(url) {
    return isOpenKey(hostKeyFor(url));
  }

  /**
   * Record a throttle response so EVERY caller of this host slows down.
   * @param {string} key
   * @param {number} [retryAfterMs]
   */
  function noteThrottle(key, retryAfterMs) {
    const s = stateFor(key);
    s.consecutiveThrottles += 1;
    s.throttleEvents += 1;
    // Honor Retry-After when the server sent one; otherwise back off
    // exponentially in the number of throttles we've already taken.
    const backoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : Math.min(baseCooldownMs * 2 ** (s.consecutiveThrottles - 1), maxCooldownMs);
    const cooldown = Math.min(backoff, maxCooldownMs);
    s.nextStartAt = Math.max(s.nextStartAt, now() + cooldown);
    if (s.consecutiveThrottles >= breakerThreshold) {
      s.openUntil = now() + breakerOpenMs;
    }
  }

  /**
   * Run `fn` under this host's concurrency ceiling, cooldown, and breaker.
   *
   * @template T
   * @param {string|URL} url the request target (only its host is used)
   * @param {() => Promise<T>} fn
   * @param {object} [runOptions]
   * @param {number} [runOptions.minSpacingMs] per-call minimum between starts
   * @returns {Promise<T>}
   * @throws {HostCircuitOpenError} when the host's breaker is open
   */
  async function run(url, fn, runOptions = {}) {
    const key = hostKeyFor(url);
    if (isOpenKey(key)) throw new HostCircuitOpenError(key);
    const s = stateFor(key);

    await acquire(s);
    try {
      // Re-check after queueing: the host may have started throttling while we
      // waited for a slot, in which case there is no point spending the request.
      if (isOpenKey(key)) throw new HostCircuitOpenError(key);

      // Reserve a distinct start time while still in the synchronous section.
      // Previously every queued caller observed the same nextStartAt, slept to
      // the same instant, and then woke as a burst — defeating the limiter.
      const spacing = Math.max(0, Number(runOptions.minSpacingMs ?? minSpacingMs) || 0);
      const startAt = Math.max(s.nextStartAt, now());
      if (spacing > 0) s.nextStartAt = startAt + spacing;
      const waitMs = startAt - now();
      if (waitMs > 0) await sleepFn(waitMs);

      try {
        const out = await fn();
        s.consecutiveThrottles = 0; // a clean response means we're within budget
        return out;
      } catch (err) {
        const status = Number(err?.status ?? err?.statusCode ?? NaN);
        if (isThrottleStatus(status)) noteThrottle(key, err?.retryAfterMs);
        throw err;
      }
    } finally {
      release(s);
    }
  }

  /** Per-host counters, for reporting what actually happened during a run. */
  function snapshot() {
    const out = {};
    for (const [key, s] of hosts) {
      out[key] = {
        throttleEvents: s.throttleEvents,
        circuitOpen: s.openUntil > now(),
        inFlight: s.inFlight,
      };
    }
    return out;
  }

  return { run, isOpen, snapshot, hostKeyFor };
}
