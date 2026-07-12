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

/**
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

  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    // An abort due to OUR timer becomes a clean, retryable timeout error.
    if (err?.name === 'AbortError' && !external?.aborted) {
      const e = new Error(`Request timed out after ${ms}ms`);
      e.code = 'ETIMEDOUT';
      e.retryable = true;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener?.('abort', onAbort);
  }
}
