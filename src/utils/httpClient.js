/**
 * fetch() with a hard request timeout.
 *
 * Without a timeout, a single hung/slow endpoint stalls the ENTIRE discovery
 * run indefinitely — `withRetry` never helps because a hang never throws. This
 * wrapper aborts a request that exceeds `timeoutMs` and surfaces a retryable
 * error so the retry handler can back off and ultimately move on.
 *
 * Design note: when `timeoutMs` is not a positive number we call `fetchImpl`
 * with the ORIGINAL init untouched (no AbortSignal injected). That keeps unit
 * tests that assert on the exact fetch arguments unaffected — the timeout is a
 * production concern threaded from config (defaults.requestTimeoutMs).
 */

/**
 * How this agent identifies itself to every public endpoint it reads.
 *
 * This is a compliance feature, not cosmetics. The whole discovery layer rests
 * on the claim that it reads public endpoints openly and never evades — but
 * until now every request went out under Node's default UA, which says nothing
 * about who is calling. A server that can identify a caller can rate-limit or
 * contact it instead of blanket-blocking the IP.
 *
 * It deliberately does NOT imitate a browser. Spoofing a Chrome UA to slip past
 * bot detection is precisely the evasion this codebase refuses to do, so the
 * string names the tool and its purpose and nothing else.
 */
export const DISCOVERY_USER_AGENT = 'job-agent/0.1 (personal job-search assistant; contact via repository owner)';

/**
 * Merge the identifying User-Agent into a header bag.
 *
 * A caller-supplied User-Agent always wins, so a test or a source that must
 * present something specific stays in control.
 *
 * @param {Record<string, string>} [extra] caller headers
 * @returns {Record<string, string>}
 */
export function discoveryHeaders(extra = {}) {
  const hasUa = Object.keys(extra).some((k) => k.toLowerCase() === 'user-agent');
  return hasUa ? { ...extra } : { 'User-Agent': DISCOVERY_USER_AGENT, ...extra };
}

/**
 * Parse a `Retry-After` header into milliseconds.
 *
 * The header is either delta-seconds ("120") or an HTTP-date. Honoring it is
 * the difference between backing off for as long as the server asked and
 * blindly retrying on a 500ms curve that guarantees another 429.
 *
 * @param {string|null|undefined} value raw header value
 * @param {number} [nowMs] clock, for testing
 * @returns {number|null} milliseconds to wait, or null when absent/unparseable
 */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  // delta-seconds
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return Number.isFinite(ms) ? ms : null;
  }

  // HTTP-date
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * Build a rich Error from a non-OK Response.
 *
 * Carrying `status` and `retryAfterMs` on the error is what lets the retry
 * handler back off correctly, the host gate throttle every caller of that host,
 * and the RCA panel say "rate limited" instead of guessing "network" from the
 * prose of the message.
 *
 * @param {Response} res
 * @param {string} label e.g. "Workday detail"
 * @param {string|URL} url
 * @returns {Error & { status: number, retryAfterMs: number|null, retryable: boolean }}
 */
export function httpError(res, label, url) {
  const err = new Error(`${label} HTTP ${res.status} for ${url}`);
  err.status = res.status;
  err.retryAfterMs = parseRetryAfterMs(res.headers?.get?.('retry-after'));
  // 429/5xx are worth another attempt; other 4xx are our problem, not a blip.
  err.retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
  return err;
}

/** Body-reading methods a Response exposes — every one of them can stall. */
const BODY_METHODS = ['json', 'text', 'arrayBuffer', 'blob', 'formData'];

/** The retryable error a timeout surfaces as, whichever phase it fired in. */
function timeoutError(ms, phase = 'request') {
  const e = new Error(phase === 'body'
    ? `Response body timed out after ${ms}ms`
    : `Request timed out after ${ms}ms`);
  e.code = 'ETIMEDOUT';
  e.retryable = true;
  return e;
}

/** The labelled, non-retryable error a caller-initiated abort surfaces as. */
function cancelledError() {
  const e = new Error('cancelled: the run was stopped');
  // Keep `name` so the documented "an external abort stays an abort" contract
  // holds for existing consumers (linkHealth, failureRca), and add the
  // labelling on top rather than replacing it.
  e.name = 'AbortError';
  e.code = 'RUN_CANCELLED';
  e.retryable = false;
  e.cancelled = true;
  return e;
}

/**
 * fetch() whose timeout covers the WHOLE exchange — headers AND body.
 *
 * REGRESSION GUARD. The timer used to be cleared in a `finally` the moment the
 * headers arrived, so `await res.json()` ran with no deadline at all. A server
 * that answers 200 and then stalls mid-body (reproduced with a local server that
 * writes headers and never ends the response) hung the adapter forever, and the
 * whole discovery run with it — `withRetry` never helps because a hang never
 * throws. The deadline now stays armed until the body has been read, and a
 * stalled body read rejects with the same retryable ETIMEDOUT a stalled connect
 * does.
 *
 * The response's body methods are wrapped in place, so every existing
 * `res.json()` / `res.text()` caller is covered without a migration; new code
 * should prefer {@link fetchJsonWithTimeout} / {@link fetchTextWithTimeout}.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs] abort after this many ms (omit/<=0 to disable)
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) {
    // No timeout configured — pass through verbatim (test-arg fidelity).
    return fetchImpl(url, init);
  }

  // Compose with any caller-supplied signal so both can abort the request.
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const external = init.signal;
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onAbort, { once: true });
  }

  let timedOut = false;
  /** @type {Array<(err: Error) => void>} pending body reads to fail on timeout */
  const bodyWaiters = [];
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    for (const fail of bodyWaiters.splice(0)) fail(timeoutError(ms, 'body'));
  }, ms);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    if (external) external.removeEventListener?.('abort', onAbort);
  };

  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    release();
    // An abort due to OUR timer becomes a clean, retryable timeout error.
    if (err?.name === 'AbortError' && !external?.aborted) throw timeoutError(ms);
    // An abort from the CALLER's signal is a deliberate cancellation, not a
    // fault. Surfaced as a labelled, non-retryable error carrying `cancelled`
    // so a stopped run reports "stopped on request" instead of a wall of raw
    // DOMExceptions — one per request the cancel legitimately dropped.
    if (err?.name === 'AbortError' && external?.aborted) throw cancelledError();
    throw err;
  }

  const methods = res && typeof res === 'object'
    ? BODY_METHODS.filter((m) => typeof res[m] === 'function')
    : [];
  if (!methods.length) {
    // Nothing left that could stall (a test double, or a body-less response).
    release();
    return res;
  }
  // The timer must not keep an otherwise-finished process alive just because a
  // caller chose not to read a body (an error status it threw on). While a read
  // IS in flight the socket keeps the loop alive, so the timer still fires.
  timer.unref?.();

  for (const name of methods) {
    const original = res[name];
    const guarded = (...args) => {
      if (timedOut) return Promise.reject(timeoutError(ms, 'body'));
      const read = new Promise((resolve, reject) => {
        bodyWaiters.push(reject);
        Promise.resolve()
          .then(() => original.apply(res, args))
          .then(resolve, (err) => {
            if (timedOut) reject(timeoutError(ms, 'body'));
            else if (err?.name === 'AbortError' && external?.aborted) reject(cancelledError());
            else reject(err);
          });
      });
      return read.finally(release);
    };
    try {
      Object.defineProperty(res, name, { value: guarded, configurable: true, writable: true });
    } catch {
      // A frozen response cannot be guarded; fall back to the old behaviour
      // rather than failing a request that already succeeded.
      release();
      return res;
    }
  }
  return res;
}

/**
 * Request and parse JSON under ONE deadline, throwing `httpError` on a non-2xx
 * status. This is the helper adapters should reach for: the body read — the
 * half of the exchange that used to run unguarded — cannot be forgotten here.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 * @param {string} [label] names the source in error messages ("Workday detail")
 * @returns {Promise<any>}
 */
export async function fetchJsonWithTimeout(fetchImpl, url, init = {}, timeoutMs, label = 'HTTP') {
  const res = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);
  if (!res.ok) throw httpError(res, label, url);
  return res.json();
}

/**
 * Text counterpart of {@link fetchJsonWithTimeout}.
 *
 * @param {typeof fetch} fetchImpl
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 * @param {string} [label]
 * @returns {Promise<string>}
 */
export async function fetchTextWithTimeout(fetchImpl, url, init = {}, timeoutMs, label = 'HTTP') {
  const res = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);
  if (!res.ok) throw httpError(res, label, url);
  return res.text();
}
