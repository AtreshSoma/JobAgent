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
