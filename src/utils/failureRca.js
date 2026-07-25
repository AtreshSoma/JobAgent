/**
 * Root-cause analysis for run failures — the structured record behind the
 * dashboard's "what failed, why, and what should I do" panel.
 *
 * Every failed discovery source, pipeline phase, or browser-assist run is
 * turned into one sanitized, categorized entry. Categorization is heuristic
 * (error codes, HTTP statuses, message patterns) and deliberately says
 * "unknown" rather than guessing a probable cause the evidence does not
 * support. Messages are sanitized so credentials, tokens, and query secrets
 * never reach the UI or logs.
 */

/** Failure categories the UI understands. Keep in sync with the RCA panel. */
export const RCA_CATEGORIES = Object.freeze([
  'timeout', 'network', 'dns', 'auth', 'rate_limit', 'quota_exhausted',
  'provider_error', 'invalid_json', 'schema_changed', 'empty_response',
  'db_busy', 'missing_config', 'missing_resume', 'browser_launch', 'unknown',
]);

/** Human guidance per category — actionable, never alarmist. */
const GUIDANCE = Object.freeze({
  timeout: 'The source did not answer in time. It is usually transient — retry; if it persists, the site may be slow or blocking automated clients.',
  network: 'Could not reach the network endpoint. Check your internet connection, VPN, or proxy, then retry.',
  dns: 'The hostname could not be resolved. Check the source URL/domain in config/jobboards.json and your DNS/VPN.',
  auth: 'The source rejected the credentials (401/403). Verify the API token in .env is current and has the right scopes.',
  quota_exhausted: 'The account has spent its usage allowance for the billing period, so the provider is refusing new work. Nothing is wrong with the setup and no other source is affected — raise the plan limit, or leave this source disabled until the cycle resets.',
  rate_limit: 'The source rate-limited us (429). It is throttling by host, so every board/tenant on that host shares one budget. Wait a few minutes and retry; if it repeats, raise rateLimitMs or lower detailConcurrency for this source.',
  provider_error: 'The provider returned an error (5xx, or a 4xx rejecting our request). Usually on their side — retry later; if a 4xx repeats, the adapter contract needs updating.',
  invalid_json: 'The source answered with malformed JSON. Usually transient; if it persists the provider changed or is erroring.',
  schema_changed: 'The response parsed but no longer matches the expected shape — the provider likely changed their API. The adapter needs updating.',
  empty_response: 'The source answered with no data. The board may genuinely be empty, or the query/token may be too restrictive.',
  db_busy: 'The local database was busy or locked. Close other Job Agent processes (or a DB browser) and retry.',
  missing_config: 'A required configuration file or field is missing. Run "npm run doctor" for the exact fix.',
  missing_resume: 'The master resume is missing at resumes/base/MASTER_RESUME.docx — tailoring cannot run without it.',
  browser_launch: 'The browser could not be started. Close other automation windows using the same profile, or run "npx playwright install chromium".',
  unknown: 'Unrecognized failure. Open the technical details; if it repeats, the message usually names the failing component.',
});

/** Which categories are worth an automatic/user retry as-is. */
const RETRYABLE = new Set(['timeout', 'network', 'dns', 'rate_limit', 'provider_error', 'invalid_json', 'empty_response', 'db_busy', 'browser_launch']);

/**
 * Recover the HTTP status from a message when the thrown value carried no
 * status field — which is the norm by the time an adapter note has been
 * flattened to a string for the UI.
 *
 * This exists because adapters wrap failures in their own prose ("detail fetch
 * failed (… HTTP 429 …)"), and prose is ambiguous: the phrase "fetch failed"
 * used to win the network heuristic and label a plain 429 as "check your
 * internet connection". A status in the text is hard evidence and must outrank
 * every word-matching guess.
 *
 * @param {string} message
 * @returns {number|null}
 */
export function extractHttpStatus(message) {
  const m = /\bHTTP[\s:_-]*(\d{3})\b/i.exec(String(message ?? ''));
  if (!m) return null;
  const status = Number(m[1]);
  return status >= 100 && status <= 599 ? status : null;
}

/**
 * Strip anything credential-shaped from an error message so RCA entries are
 * safe to render and persist. Conservative and idempotent.
 * @param {unknown} message
 * @returns {string}
 */
export function sanitizeErrorMessage(message) {
  let s = String(message ?? '').slice(0, 600);
  // Authorization headers / bearer tokens.
  s = s.replace(/\b(authorization|bearer)[:=\s]+[\w.\-+/=]{8,}/gi, '$1 [REDACTED]');
  // Known token formats (Apify, generic long hex/base64 blobs after key-ish words).
  s = s.replace(/\bapify_api_\w+/gi, 'apify_api_[REDACTED]');
  s = s.replace(/\b(token|apikey|api_key|secret|password|pass|credential)s?[:=\s"']+[^\s"'&]{6,}/gi, '$1=[REDACTED]');
  // Secrets embedded in URLs (?token=..., &key=...).
  s = s.replace(/([?&](?:token|key|apikey|api_key|secret|signature|sig|auth)=)[^\s&"']+/gi, '$1[REDACTED]');
  return s;
}

/**
 * Categorize one failure from its error object + optional context.
 *
 * @param {unknown} err Error (or message string)
 * @param {object} [context]
 * @param {number} [context.status] HTTP status when known
 * @param {string} [context.category] explicit override (adapter knows best)
 * @returns {{ category: string, retryable: boolean, guidance: string }}
 */
export function classifyFailure(err, context = {}) {
  const message = String(err?.message ?? err ?? '');
  const code = String(err?.code ?? '');
  // A status the caller knows beats one we scrape from the message, which in
  // turn beats any word-matching heuristic below.
  const status = Number(context.status ?? err?.statusCode ?? err?.status ?? extractHttpStatus(message) ?? NaN);

  let category = 'unknown';
  if (context.category && RCA_CATEGORIES.includes(context.category)) {
    category = context.category;
  } else if (status === 429) {
    category = 'rate_limit';
  } else if (status === 401 || status === 403) {
    category = 'auth';
  } else if (status === 408 || status === 504) {
    category = 'timeout';
  } else if (status >= 500 && status <= 599) {
    category = 'provider_error';
  } else if (status === 404 || status === 410) {
    // The board/tenant we were told to read is gone — a config problem, not a
    // connectivity one.
    category = 'missing_config';
  } else if (Number.isFinite(status) && status >= 400) {
    // Any other definite 4xx is the provider rejecting OUR request (a contract
    // drift), never a network fault — don't let prose drag it into "network".
    category = 'provider_error';
  } else if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || err?.name === 'AbortError' || /\btime(d)? ?out\b/i.test(message)) {
    category = 'timeout';
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /getaddrinfo|ENOTFOUND/i.test(message)) {
    category = 'dns';
  } else if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)
      || /fetch failed|socket hang up|network|ECONNREFUSED|ECONNRESET/i.test(message)) {
    category = 'network';
  } else if (/unauthorized|forbidden/i.test(message)) {
    category = 'auth';
  } else if (/rate.?limit|too many requests/i.test(message)) {
    category = 'rate_limit';
  } else if (/internal server error|bad gateway|service unavailable/i.test(message)) {
    category = 'provider_error';
  } else if (/unexpected token|invalid json|json parse|not valid JSON/i.test(message)) {
    category = 'invalid_json';
  } else if (/SQLITE_BUSY|database is locked|readonly database/i.test(message)) {
    category = 'db_busy';
  } else if (/master resume|MASTER_RESUME/i.test(message)) {
    category = 'missing_resume';
  } else if (/candidate\.json|screening_answers\.json|jobboards\.json|configuration|missing .*(token|config)|no `options\.actors`/i.test(message)) {
    category = 'missing_config';
  } else if (/browser|playwright|chromium|executable doesn't exist|could not start browser/i.test(message)) {
    category = 'browser_launch';
  } else if (/empty response|no items|no data returned/i.test(message)) {
    category = 'empty_response';
  } else if (/schema|expected (field|shape|array)|missing required field/i.test(message)) {
    category = 'schema_changed';
  }

  return { category, retryable: RETRYABLE.has(category), guidance: GUIDANCE[category] };
}

/**
 * Build one complete, UI-ready RCA entry.
 *
 * @param {object} args
 * @param {string} args.operation what was being attempted ("discover", "score", "assist", …)
 * @param {unknown} args.error the failure
 * @param {string} [args.source] failing component/source id (e.g. "greenhouse")
 * @param {string} [args.runId] correlation id for this run
 * @param {number} [args.attempt] retry count already spent
 * @param {number} [args.status] HTTP status when known
 * @param {string} [args.category] explicit category override
 * @param {string} [args.impact] user-facing impact statement
 * @param {boolean} [args.partialResultsValid] other sources' results still usable
 * @param {boolean} [args.degraded] results were KEPT but are lower-fidelity
 *   (e.g. a job kept with a summary-only description). A degraded failure must
 *   never claim results are missing — that sends the user hunting for jobs that
 *   are sitting in the board.
 * @param {number} [args.count] how many items this entry stands for once
 *   identical failures are folded together
 * @param {Date} [args.now]
 * @returns {object} structured RCA entry
 */
export function buildRca({
  operation, error, source = null, runId = null, attempt = 0,
  status = undefined, category = undefined, impact = null,
  partialResultsValid = false, degraded = false, count = 1, now = new Date(),
} = {}) {
  const cls = classifyFailure(error, { status, category });
  const message = sanitizeErrorMessage(error?.message ?? error);
  const effectiveStatus = Number(
    status ?? error?.statusCode ?? error?.status ?? extractHttpStatus(message),
  );
  // Retries actually spent: prefer what the caller counted, else what the retry
  // handler recorded on the error. Reporting a hard-coded 0 hid the fact that a
  // throttled host was being hammered several times per job.
  const retryCount = Number(attempt || error?.attempts || 0);
  return {
    runId,
    source,
    operation,
    at: now.toISOString(),
    category: cls.category,
    status: Number.isFinite(effectiveStatus) ? effectiveStatus : null,
    message,
    retryCount: Number.isFinite(retryCount) ? retryCount : 0,
    retryable: cls.retryable,
    guidance: cls.guidance,
    impact: impact ?? defaultImpact({ source, operation, degraded, count }),
    degraded,
    count: Number.isFinite(Number(count)) && Number(count) > 0 ? Number(count) : 1,
    partialResultsValid,
  };
}

/** Impact text that matches what actually happened to the results. */
function defaultImpact({ source, operation, degraded, count }) {
  if (!source) return `The ${operation} run did not complete.`;
  const n = Number(count) > 1 ? `${count} results from` : 'Results from';
  if (degraded) {
    return `${n} "${source}" were KEPT but are lower-fidelity (summary-only description, no full job text); nothing was lost and other sources are unaffected.`;
  }
  return `${n} "${source}" are missing from this run; other sources are unaffected.`;
}
