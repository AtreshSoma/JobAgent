/**
 * Artifact fetcher for the content script.
 *
 * TRUST BOUNDARY. The content script runs inside an employer's (or an
 * aggregator's) page and used to send `{ url, key }` here: the page's own
 * frame chose the URL and carried the shared connection key, so any script
 * able to reach this listener could aim that key at any host. Now:
 *   - only messages from THIS extension are served (`sender.id`);
 *   - the message names a job and an artifact kind, nothing else;
 *   - the URL is built here from chrome.storage, and only a loopback Job Agent
 *     server (127.0.0.1 / localhost over http) is ever contacted;
 *   - the key is read here and never leaves the service worker.
 */

/** Artifact kinds the companion serves. */
const KINDS = new Set(['resume', 'cover-letter']);

/**
 * The configured Job Agent origin, or null unless it is a loopback http URL.
 * @param {string} value
 * @returns {string|null}
 */
function loopbackServer(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:') return null;
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

/**
 * Build the artifact request for a message, or explain why not.
 * Pure (no chrome APIs) so it can be unit-tested.
 * @returns {{ ok: true, url: string, key: string } | { ok: false, error: string }}
 */
function artifactRequest(message, sender, runtimeId, settings) {
  if (!sender || sender.id !== runtimeId) return { ok: false, error: 'message not from this extension' };
  const jobId = String(message?.jobId || '');
  const kind = String(message?.kind || '');
  if (!jobId || !KINDS.has(kind)) return { ok: false, error: 'invalid artifact request' };
  const origin = loopbackServer(settings?.serverUrl);
  if (!origin) return { ok: false, error: 'Job Agent server must be http://127.0.0.1 or http://localhost' };
  const key = String(settings?.key || '');
  if (key.length < 32) return { ok: false, error: 'extension key is not configured' };
  return { ok: true, url: `${origin}/api/extension/jobs/${encodeURIComponent(jobId)}/files/${kind}`, key };
}

globalThis.__jobAgentWorker = { loopbackServer, artifactRequest };

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'JOB_AGENT_FETCH_ARTIFACT') return false;
    (async () => {
      try {
        const settings = await chrome.storage.local.get({ serverUrl: 'http://127.0.0.1:4646', key: '' });
        const request = artifactRequest(message, sender, chrome.runtime.id, settings);
        if (!request.ok) throw new Error(request.error);
        const response = await fetch(request.url, {
          headers: { 'x-job-agent-key': request.key },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        sendResponse({ ok: true, base64: btoa(binary), type: response.headers.get('content-type') || '', name: message.name });
      } catch (error) {
        sendResponse({ ok: false, error: error.message });
      }
    })();
    return true;
  });
}
