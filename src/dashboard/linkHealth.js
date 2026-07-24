/** Honest, non-bypassing health checks for job posting URLs. */
const AGGREGATORS = /(^|\.)(linkedin|indeed|glassdoor|dice|ziprecruiter|simplyhired|monster)\./i;

export function classifyJobUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    if (!['http:', 'https:'].includes(url.protocol)) return { kind: 'invalid', host: url.hostname };
    return { kind: AGGREGATORS.test(url.hostname) ? 'aggregator' : 'direct', host: url.hostname };
  } catch {
    return { kind: 'invalid', host: '' };
  }
}

export async function checkJobLink(value, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const classified = classifyJobUrl(value);
  if (classified.kind === 'invalid') {
    return { ...classified, status: 'invalid', httpStatus: null, finalUrl: null, message: 'This is not a valid HTTP(S) job URL.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(value, {
      method: 'GET', redirect: 'follow', signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'JobAgent-LinkCheck/1.0 (local availability check; no form submission)',
      },
    });
    try { await response.body?.cancel?.(); } catch { /* no body on test doubles */ }
    const httpStatus = Number(response.status) || null;
    const finalUrl = response.url || String(value);
    const finalKind = classifyJobUrl(finalUrl).kind;
    if (httpStatus >= 200 && httpStatus < 400) {
      return { kind: finalKind, status: 'reachable', httpStatus, finalUrl,
        message: finalUrl !== String(value) ? 'Posting is reachable and redirects to this URL.' : 'Posting is reachable.' };
    }
    if ([404, 410].includes(httpStatus)) {
      return { kind: finalKind, status: 'closed', httpStatus, finalUrl,
        message: 'The server reports that this posting is missing or closed.' };
    }
    if ([401, 403].includes(httpStatus)) {
      return { kind: finalKind, status: 'restricted', httpStatus, finalUrl,
        message: finalKind === 'aggregator'
          ? 'The aggregator restricts automated access. The posting may still open normally in your browser.'
          : 'The employer site restricts automated access. Open it manually; this does not prove the job is closed.' };
    }
    if (httpStatus === 429) {
      return { kind: finalKind, status: 'rate_limited', httpStatus, finalUrl,
        message: 'The site is rate-limiting checks. Wait and open the posting manually.' };
    }
    return { kind: finalKind, status: 'error', httpStatus, finalUrl,
      message: `The posting returned HTTP ${httpStatus ?? 'error'}.` };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return { ...classified, status: timedOut ? 'timeout' : 'unreachable', httpStatus: null,
      finalUrl: String(value), message: timedOut ? 'The link check timed out.' : `The posting could not be reached: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
