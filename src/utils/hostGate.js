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

/**
 * Error thrown when the run was cancelled before a gated call could start.
 *
 * Deliberately NOT retryable, and flagged `cancelled` so callers can count it
 * as "stopped on request" rather than reporting a scary per-request failure for
 * every one of the hundreds of requests a cancel legitimately drops.
 */
export class RunCancelledError extends Error {
  constructor() {
    super('cancelled: the run was stopped before this request started');
    this.name = 'RunCancelledError';
    this.code = 'RUN_CANCELLED';
    this.retryable = false;
    this.cancelled = true;
  }
}

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
 * Sleep that a cancelled run can interrupt.
 *
 * A cooldown after a 429 can be a full minute. A plain `sleepFn` made every
 * caller queued behind that cooldown sit it out even after the user pressed
 * Stop, which is exactly the "Stopping…" stall the signal exists to prevent.
 *
 * @param {(ms: number) => Promise<void>} sleepFn
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function abortableSleep(sleepFn, ms, signal) {
  if (!signal) return sleepFn(ms);
  if (signal.aborted) return Promise.reject(new RunCancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new RunCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    sleepFn(ms).then(
      () => { signal.removeEventListener('abort', onAbort); resolve(); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

/**
 * @param {object} [options]
 * @param {number} [options.maxConcurrent=4] in-flight requests allowed per host
 * @param {Record<string, number>} [options.perHost] per-host ceilings that
 *   override `maxConcurrent` — keyed by hostname or URL, normalized through
 *   `hostKeyFor` so a Workday tenant host configures its whole pod
 * @param {number} [options.minSpacingMs=0] minimum gap between request STARTS per host
 * @param {number} [options.baseCooldownMs=2000] cooldown when a 429 carries no Retry-After
 * @param {number} [options.maxCooldownMs=60000] cap on any single cooldown
 * @param {number} [options.breakerThreshold=4] consecutive throttles before the breaker opens
 * @param {number} [options.breakerWindow=20] recent outcomes the rolling ratio is read over
 * @param {number} [options.breakerMinSamples=10] outcomes needed before the ratio may trip
 * @param {number} [options.breakerRatio=0.5] throttled share of the window that opens it
 * @param {number} [options.breakerOpenMs=60000] how long the breaker stays open
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleepFn]
 */
export function createHostGate({
  maxConcurrent = 4,
  perHost = {},
  minSpacingMs = 0,
  baseCooldownMs = 2000,
  maxCooldownMs = 60000,
  breakerThreshold = 4,
  breakerWindow = 20,
  breakerMinSamples = 10,
  breakerRatio = 0.5,
  breakerOpenMs = 60000,
  now = () => Date.now(),
  sleepFn = sleep,
} = {}) {
  /**
   * @typedef {object} HostState
   * @property {number} inFlight
   * @property {Array<{grant: () => void, cancelled: boolean}>} queue waiters for a slot
   * @property {number} nextStartAt earliest ms at which a request may start
   * @property {Promise<void>} startTail serializes actual request starts
   * @property {number} consecutiveThrottles drives the exponential cooldown
   * @property {boolean[]} outcomes rolling window, true = throttled
   * @property {number} openUntil breaker open until this ms (0 = closed)
   * @property {number} throttleEvents total 429/503 seen (for reporting)
   */
  /** @type {Map<string, HostState>} */
  const hosts = new Map();

  /**
   * PER-HOST CEILINGS.
   *
   * The orchestrator builds ONE gate for the whole run and hands it to every
   * adapter, which is right for politeness but made a source's own
   * `hostConcurrency` unreachable: the Workday adapter only builds its own gate
   * when none is supplied, and one always was, so its measured 8-in-flight pod
   * ceiling (see workday.js DEFAULT_HOST_CONCURRENCY) silently ran at the
   * global 4. Overrides let a source raise or lower ITS hosts without changing
   * anyone else's budget.
   */
  const limits = new Map();
  const clampLimit = (n) => {
    const v = Math.trunc(Number(n));
    return Number.isFinite(v) && v >= 1 ? v : null;
  };
  for (const [host, n] of Object.entries(perHost ?? {})) {
    const v = clampLimit(n);
    if (v) limits.set(hostKeyFor(host.includes('://') ? host : `https://${host}`), v);
  }
  const limitFor = (key) => limits.get(key) ?? maxConcurrent;

  /**
   * Set the in-flight ceiling for one host (or Workday pod).
   *
   * Waiters already queued are admitted immediately if the ceiling rose, so a
   * late configure never strands work behind a limit that no longer applies.
   *
   * @param {string} host hostname or URL
   * @param {number} n requests allowed in flight (>= 1)
   * @returns {number|null} the ceiling now in effect, or null when `n` was invalid
   */
  function configure(host, n) {
    const v = clampLimit(n);
    if (!v || !host) return null;
    const key = hostKeyFor(String(host).includes('://') ? host : `https://${host}`);
    limits.set(key, v);
    const s = hosts.get(key);
    if (s) {
      while (s.inFlight < v && s.queue.length) {
        const next = s.queue.shift();
        if (next.cancelled) continue;
        s.inFlight += 1;
        next.grant();
      }
    }
    return v;
  }

  function stateFor(key) {
    let s = hosts.get(key);
    if (!s) {
      s = {
        inFlight: 0,
        queue: [],
        nextStartAt: 0,
        startTail: Promise.resolve(),
        consecutiveThrottles: 0,
        outcomes: [],
        openUntil: 0,
        throttleEvents: 0,
      };
      hosts.set(key, s);
    }
    return s;
  }

  /**
   * Wait for an in-flight slot on this host.
   *
   * The wait itself is abortable: a cancelled run must not keep hundreds of
   * callers parked behind one pod's queue until the slot happens to free.
   */
  async function acquire(s, key, signal) {
    if (s.inFlight < limitFor(key)) {
      s.inFlight += 1;
      return;
    }
    // The releaser hands its slot straight to us, so we must NOT increment
    // again — doing so would let in-flight drift above the ceiling.
    await new Promise((resolve, reject) => {
      const waiter = { cancelled: false, grant: null };
      const onAbort = () => {
        waiter.cancelled = true;
        const at = s.queue.indexOf(waiter);
        if (at !== -1) s.queue.splice(at, 1);
        reject(new RunCancelledError());
      };
      waiter.grant = () => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      };
      s.queue.push(waiter);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  function release(s) {
    // Hand the slot to a live waiter (in-flight unchanged) rather than freeing
    // it and racing a fresh caller for it.
    while (s.queue.length) {
      const next = s.queue.shift();
      if (next.cancelled) continue;
      next.grant();
      return;
    }
    s.inFlight -= 1;
  }

  /** Record one outcome in the host's rolling window. */
  function noteOutcome(s, throttled) {
    s.outcomes.push(throttled);
    if (s.outcomes.length > breakerWindow) s.outcomes.shift();
  }

  /**
   * Should the breaker open for this host now?
   *
   * TWO RULES, EITHER SUFFICES.
   *
   * 1. A streak of `breakerThreshold` consecutive throttles — the host is
   *    refusing everything right now.
   * 2. A rolling throttle RATIO over the last `breakerWindow` outcomes. The
   *    streak alone was reset by any single success, so a pod answering
   *    429, 200, 429, 200 … — throttling half of everything — never opened the
   *    breaker and every retry kept landing on it. The ratio needs
   *    `breakerMinSamples` outcomes first, so one early blip beside a success
   *    still cannot trip it.
   */
  function shouldOpen(s) {
    if (s.consecutiveThrottles >= breakerThreshold) return true;
    if (s.outcomes.length < breakerMinSamples) return false;
    const throttled = s.outcomes.reduce((n, t) => n + (t ? 1 : 0), 0);
    return throttled / s.outcomes.length >= breakerRatio;
  }

  /** True while the host's breaker is open (auto-closes when it expires). */
  function isOpenKey(key) {
    const s = hosts.get(key);
    if (!s || s.openUntil === 0) return false;
    if (now() >= s.openUntil) {
      // Half-open: let the next caller through and see what happens. The window
      // is cleared too — its throttles are what opened the breaker, and keeping
      // them would re-open it on the very first probe.
      s.openUntil = 0;
      s.consecutiveThrottles = 0;
      s.outcomes = [];
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
    noteOutcome(s, true);
    // Honor Retry-After when the server sent one; otherwise back off
    // exponentially in the number of throttles we've already taken.
    const backoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : Math.min(baseCooldownMs * 2 ** (s.consecutiveThrottles - 1), maxCooldownMs);
    const cooldown = Math.min(backoff, maxCooldownMs);
    s.nextStartAt = Math.max(s.nextStartAt, now() + cooldown);
    if (shouldOpen(s)) {
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
   * @param {AbortSignal} [runOptions.signal] drop this call if the run is cancelled
   * @returns {Promise<T>}
   * @throws {HostCircuitOpenError} when the host's breaker is open
   * @throws {RunCancelledError} when `signal` aborts before the call starts
   */
  async function run(url, fn, runOptions = {}) {
    const key = hostKeyFor(url);
    const signal = runOptions.signal;
    // A cancelled run must not spend a queued slot. With hundreds of requests
    // waiting behind one pod's gate, dialling them all anyway is what made
    // "Stopping…" take as long as it did.
    if (signal?.aborted) throw new RunCancelledError();
    if (isOpenKey(key)) throw new HostCircuitOpenError(key);
    const s = stateFor(key);

    await acquire(s, key, signal);
    try {
      // Re-check after queueing: the run may have been cancelled, or the host may
      // have started throttling, while we waited for a slot — either way there is
      // no point spending the request.
      if (signal?.aborted) throw new RunCancelledError();
      if (isOpenKey(key)) throw new HostCircuitOpenError(key);

      const spacing = Math.max(0, Number(runOptions.minSpacingMs ?? minSpacingMs) || 0);
      let releaseStart = null;
      if (spacing > 0) {
        // Serialize the *actual* start, not only its nominal reservation. When
        // the event loop is busy, several overdue timers can otherwise wake in
        // one tick and create the exact burst this gate is meant to prevent.
        const previousStart = s.startTail;
        s.startTail = new Promise((resolve) => { releaseStart = resolve; });
        await previousStart;
      }

      try {
        const startAt = Math.max(s.nextStartAt, now());
        const waitMs = startAt - now();
        // A cooldown can be a minute long; a cancelled run must not sit it out.
        if (waitMs > 0) await abortableSleep(sleepFn, waitMs, signal);
        if (signal?.aborted) throw new RunCancelledError();
        if (spacing > 0) s.nextStartAt = now() + spacing;

        // Calling fn starts its synchronous portion before the next spaced
        // caller is released. The network operation itself remains concurrent.
        const operation = fn();
        releaseStart?.();
        releaseStart = null;
        const out = await operation;
        // A clean response ends the STREAK (that only drives the cooldown
        // curve) but not the rolling window — see shouldOpen.
        s.consecutiveThrottles = 0;
        noteOutcome(s, false);
        return out;
      } catch (err) {
        const status = Number(err?.status ?? err?.statusCode ?? NaN);
        if (isThrottleStatus(status)) noteThrottle(key, err?.retryAfterMs);
        throw err;
      } finally {
        // Also unlock if waiting or fn() throws synchronously.
        releaseStart?.();
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
        maxConcurrent: limitFor(key),
      };
    }
    return out;
  }

  return { run, isOpen, snapshot, hostKeyFor, configure, limitFor: (host) => limitFor(hostKeyFor(host)) };
}
