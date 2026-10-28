/** The fetch layer: every request goes through api(); mutations carry X-Job-Agent. */

import { $ } from './dom.js';
import { state } from './state.js';

/* ─────────────────────────── API layer ─────────────────────────── */

/**
 * The one place the page talks to the server.
 *
 * Every non-GET request carries `X-Job-Agent: 1`. A cross-site form or image
 * cannot set a custom header without a CORS preflight the server never grants,
 * so the header lets the server tell its own page from a drive-by POST — and
 * because it is added HERE, no mutation can be written that forgets it.
 *
 * Errors carry `status`, so a caller can tell "this server has no such route"
 * (an older process) from a real failure and fall back instead of breaking.
 */
export async function api(path, options = {}) {
  const method = String(options.method ?? 'GET').toUpperCase();
  const headers = { ...(options.headers ?? {}) };
  if (method !== 'GET' && method !== 'HEAD') headers['X-Job-Agent'] = '1';
  let res;
  try {
    res = await fetch(path, { ...options, method, headers });
  } catch {
    setServerStatus(false);
    throw new Error('Cannot reach the dashboard server — it may have stopped. '
      + 'Restart it with "npm run dashboard", then reload this page.');
  }
  setServerStatus(true);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // The server serves index.html and the modules from disk on every request, so a
    // browser reload picks up new front-end code while the RUNNING process
    // still has the old routes. That mismatch surfaced as a bare
    // "no route: GET /api/…", which reads like a bug rather than a stale
    // process. Say what it actually is.
    if (res.status === 404 && /^no route:/i.test(body.error ?? '')) {
      throw Object.assign(new Error('This feature is newer than the dashboard process that is running. '
        + 'Stop it and run "npm run dashboard" again, then reload this page.'), { status: 404, noRoute: true });
    }
    throw Object.assign(new Error(body.error || res.statusText), { status: res.status });
  }
  return body;
}

/**
 * GET an endpoint that an older server may not have. Resolves to `null` on a
 * 404 so the caller can fall back; every other failure still throws.
 */
export async function apiOptional(path) {
  try { return await api(path); }
  catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

export const postJson = (path, body) => api(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export function setServerStatus(up) {
  if (up === state.serverUp) return;
  state.serverUp = up;
  const conn = $('conn');
  // The dot is a CSS pseudo-element now, so the text must not carry one too.
  conn.textContent = up ? 'Connected' : 'Disconnected';
  conn.className = `conn ${up ? 'ok' : 'down'}`;
  $('offline').dataset.open = String(!up);
}
