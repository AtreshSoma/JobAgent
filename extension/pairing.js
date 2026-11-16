// Pair with the local Job Agent server using the code its dashboard shows
// (audit A12). Loaded by options.html before options.js.
(() => {
  const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

  /**
   * @param {string} serverUrl loopback http origin only
   * @param {string} code the pairing code
   * @param {Function} fetchFn injectable for tests
   * @returns {Promise<{ok: true, key: string} | {ok: false, error: string}>}
   */
  async function pairWithServer(serverUrl, code, fetchFn = fetch) {
    const base = String(serverUrl || '').trim().replace(/\/$/, '');
    if (!LOOPBACK.test(base)) return { ok: false, error: 'Only a loopback HTTP server is allowed.' };
    let response;
    try {
      response = await fetchFn(`${base}/api/extension/pair`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }), cache: 'no-store',
      });
    } catch {
      return { ok: false, error: 'Could not reach the dashboard. Is it running on this computer?' };
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: body.error || `The dashboard refused the code (HTTP ${response.status}).` };
    if (typeof body.key !== 'string' || body.key.length < 32) return { ok: false, error: 'The dashboard did not return a usable key.' };
    return { ok: true, key: body.key };
  }

  globalThis.JobAgentPairing = { pairWithServer };
})();
