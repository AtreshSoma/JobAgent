/**
 * Credential manager.
 *
 * Secrets are read ONLY from process.env (populated from .env via dotenv at
 * startup). Secrets are never written to logs, never persisted, and never
 * returned in bulk. Callers request specific keys and get clear failures when
 * a required secret is missing.
 */

/**
 * Keys that are considered secret. Used by `redact` to scrub log payloads.
 * Matching is case-insensitive and substring-based.
 */
export const SECRET_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'api_key',
  'apikey',
  'cookie',
  'session',
  'authorization',
  'pass',
];

/**
 * Name suffixes that mark a secret even when no substring pattern matches:
 * `ADZUNA_APP_KEY`, `JOB_AGENT_EXTENSION_KEY`, `appKey`, `clientSecret`,
 * `x-auth-token`. `app_key` slipped past the substring list (it has no
 * `api_key`), so it could be logged verbatim.
 */
const SECRET_SUFFIXES = ['key', 'secret', 'token', 'password'];

/**
 * @param {string} name
 * @returns {boolean}
 */
function looksSecret(name) {
  const lower = String(name).toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => lower.includes(p))
    || SECRET_SUFFIXES.some((s) => lower.endsWith(s));
}

/**
 * Query/form parameters whose VALUE is a credential (`?app_key=…`,
 * `&access_token=…`). Adzuna, for one, authenticates with app_id/app_key in
 * the URL, so a request URL in an error message or log line carries the key.
 */
const SECRET_PARAM_RE = /([?&;](?:[\w.-]*?(?:key|secret|token|password|passwd|signature|sig)|auth|code)=)[^&#\s"'<>]+/gi;

/**
 * `Authorization: <anything>` and a free-standing `Bearer <token>`. Not a bare
 * "Basic <word>": job descriptions say "Basic Qualifications".
 */
const AUTH_HEADER_RE = /(authorization\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;"'}]+/gi;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/g;

/**
 * Values of secret-named environment variables, longest first, so they can be
 * scrubbed wherever they appear — including inside strings no key name
 * describes. Short values are skipped: masking "1" or "true" everywhere would
 * destroy logs without protecting anything.
 */
function knownSecretValues(env) {
  const values = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    const v = String(value ?? '').trim();
    if (v.length >= 8 && looksSecret(name)) values.push(v);
  }
  return values.sort((a, b) => b.length - a.length);
}

/**
 * Scrub credentials out of a free-text string: secret query parameters,
 * bearer/basic tokens, and any literal value of a secret env var.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.mask='[REDACTED]']
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @returns {string}
 */
export function scrubSecrets(text, { mask = '[REDACTED]', env = process.env } = {}) {
  if (typeof text !== 'string' || !text) return text;
  let out = text
    .replace(SECRET_PARAM_RE, `$1${mask}`)
    .replace(AUTH_HEADER_RE, `$1${mask}`)
    .replace(BEARER_RE, `$1 ${mask}`);
  for (const value of knownSecretValues(env)) {
    if (out.includes(value)) out = out.split(value).join(mask);
  }
  return out;
}

/**
 * Read a single secret from the environment.
 *
 * @param {string} name env var name
 * @param {object} [options]
 * @param {boolean} [options.required=false] throw if missing/empty
 * @param {string} [options.fallback] value to use when not required and missing
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 * @returns {string|undefined}
 */
export function getSecret(name, { required = false, fallback, env = process.env } = {}) {
  const raw = env[name];
  const value = raw === undefined ? undefined : String(raw).trim();
  if (value) return value;
  if (required) {
    throw new Error(`Missing required secret: ${name}. Set it in your .env file.`);
  }
  return fallback;
}

/**
 * Ensure all named secrets are present. Throws a single aggregated error
 * listing every missing key (without revealing any values).
 *
 * @param {string[]} names
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {void}
 */
export function requireSecrets(names, env = process.env) {
  const missing = (names || []).filter((n) => {
    const v = env[n];
    return v === undefined || String(v).trim() === '';
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required secret(s): ${missing.join(', ')}. ` +
        'Add them to your .env file (see .env.example).',
    );
  }
}

/**
 * Return non-secret runtime settings parsed from the environment.
 * These are NOT secrets and are safe to log.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 */
export function getRuntimeSettings(env = process.env) {
  const mode = String(env.RUN_MODE ?? 'DRY_RUN').trim().toUpperCase();
  return {
    // This assistant is human-approved only. There is no auto-submit mode:
    // any unknown/legacy value (including the removed LIVE_SUBMIT) is treated
    // as the safe default, DRY_RUN.
    mode: VALID_RUN_MODES.has(mode) ? mode : 'DRY_RUN',
    maxApplicationsPerDay: Number.parseInt(env.MAX_APPLICATIONS_PER_DAY ?? '15', 10) || 15,
    headless: String(env.HEADLESS ?? 'false').trim().toLowerCase() === 'true',
    // Optional: launch a real, installed browser (e.g. 'msedge' or 'chrome')
    // reusing your signed-in profile so logged-in job sites don't re-prompt.
    // Leave BROWSER_USER_DATA_DIR unset to use a clean, isolated context.
    browserChannel: String(env.BROWSER_CHANNEL ?? '').trim() || null,
    browserUserDataDir: String(env.BROWSER_USER_DATA_DIR ?? '').trim() || null,
    // Slow each Playwright action by N ms so you can SEE the bot type, click,
    // and upload while it works (0 = full speed). Handy when running headed.
    browserSlowMo: Math.max(0, Number.parseInt(env.BROWSER_SLOW_MO ?? '0', 10) || 0),
    // How many multi-step pages LIVE_ASSIST will advance through (clicking only
    // safe Next/Continue/Review controls) before it stops for the human.
    assistMaxSteps: Math.max(1, Number.parseInt(env.ASSIST_MAX_STEPS ?? '8', 10) || 8),
    // Also export a PDF next to each tailored .docx resume (most ATS prefer PDF).
    resumeExportPdf: String(env.RESUME_EXPORT_PDF ?? 'true').trim().toLowerCase() !== 'false',
    // ── Freshness (prioritize recent postings) ──────────────────────────────
    // Primary recency window for discovered jobs. One of:
    //   LAST_24_HOURS | LAST_3_DAYS | LAST_7_DAYS | LAST_14_DAYS | LAST_30_DAYS | ALL
    // The dashboard's "Discovery & data quality" setting (data/settings.json)
    // overrides this; see src/config/userSettings.js.
    jobFreshnessMode: normalizeFreshnessMode(env.JOB_FRESHNESS_MODE),
    // When the strict window yields too few results, widen to a 3-day window.
    includeLast3DaysFallback:
      String(env.INCLUDE_LAST_3_DAYS_FALLBACK ?? 'true').trim().toLowerCase() !== 'false',
    // Minimum kept results before the 3-day fallback widens the window.
    minResultsBeforeFallback: Math.max(
      0,
      Number.parseInt(env.MIN_RESULTS_BEFORE_3_DAY_FALLBACK ?? '10', 10) || 10,
    ),
    // Jobs with an unknown posting date are NEVER mixed into the fresh results.
    // Off by default; when true they are surfaced only in a separate
    // UNKNOWN_DATE_REVIEW bucket for manual review (never scored/prepared).
    includeUnknownDateJobs:
      String(env.INCLUDE_UNKNOWN_DATE_JOBS ?? 'false').trim().toLowerCase() === 'true',
    // Exclude jobs already submitted (applied=1) from discovery/dedup.
    excludeAlreadyApplied:
      String(env.EXCLUDE_ALREADY_APPLIED ?? 'true').trim().toLowerCase() !== 'false',
  };
}

/** The only valid run modes. This assistant never auto-submits. */
export const VALID_RUN_MODES = Object.freeze(new Set(['DRY_RUN', 'PREPARE', 'LIVE_ASSIST']));

/** Valid freshness window modes. */
export const FRESHNESS_MODES = Object.freeze([
  'LAST_24_HOURS', 'LAST_3_DAYS', 'LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'ALL',
]);

/** Map a freshness mode to its window length in days (ALL => Infinity). */
export const FRESHNESS_WINDOW_DAYS = Object.freeze({
  LAST_24_HOURS: 1,
  LAST_3_DAYS: 3,
  LAST_7_DAYS: 7,
  // Roles outside fast-moving tech hiring (public sector, healthcare,
  // education, senior and executive searches) routinely stay open for weeks.
  LAST_14_DAYS: 14,
  LAST_30_DAYS: 30,
  ALL: Infinity,
});

/**
 * Normalize a raw JOB_FRESHNESS_MODE value to a supported mode.
 * Unknown/empty values default to LAST_7_DAYS: real requisitions routinely
 * stay open for weeks, and the previous 3-day default was measured discarding
 * >75% of scoreable jobs — including 75+ scoring senior data-engineering
 * roles — before they were ever ranked.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeFreshnessMode(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  return FRESHNESS_MODES.includes(v) ? v : 'LAST_7_DAYS';
}

/**
 * Produce a copy of an object with secret-looking values redacted.
 * Use before logging any structured payload that may contain credentials.
 *
 * Two layers: a value under a secret-looking KEY is masked whole, and every
 * string VALUE is scrubbed (see scrubSecrets) — because a key name like
 * `url` or `error` says nothing about the app_key embedded in it.
 *
 * @param {any} obj
 * @param {string} [mask='[REDACTED]']
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env=process.env] source of known secret values
 * @returns {any}
 */
export function redact(obj, mask = '[REDACTED]', { env = process.env } = {}) {
  if (typeof obj === 'string') return scrubSecrets(obj, { mask, env });
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, mask, { env }));
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (looksSecret(key)) {
      out[key] = mask;
    } else if (value && typeof value === 'object') {
      out[key] = redact(value, mask, { env });
    } else if (typeof value === 'string') {
      out[key] = scrubSecrets(value, { mask, env });
    } else {
      out[key] = value;
    }
  }
  return out;
}
