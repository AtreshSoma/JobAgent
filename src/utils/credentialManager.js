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
 * @param {string} name
 * @returns {boolean}
 */
function looksSecret(name) {
  const lower = String(name).toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => lower.includes(p));
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
    //   LAST_24_HOURS | LAST_3_DAYS | LAST_7_DAYS | ALL
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
export const FRESHNESS_MODES = Object.freeze(['LAST_24_HOURS', 'LAST_3_DAYS', 'LAST_7_DAYS', 'ALL']);

/** Map a freshness mode to its window length in days (ALL => Infinity). */
export const FRESHNESS_WINDOW_DAYS = Object.freeze({
  LAST_24_HOURS: 1,
  LAST_3_DAYS: 3,
  LAST_7_DAYS: 7,
  ALL: Infinity,
});

/**
 * Normalize a raw JOB_FRESHNESS_MODE value to a supported mode.
 * Unknown/empty values default to LAST_3_DAYS.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeFreshnessMode(raw) {
  const v = String(raw ?? '').trim().toUpperCase();
  return FRESHNESS_MODES.includes(v) ? v : 'LAST_3_DAYS';
}

/**
 * Produce a shallow copy of an object with secret-looking values redacted.
 * Use before logging any structured payload that may contain credentials.
 *
 * @param {Record<string, any>} obj
 * @param {string} [mask='[REDACTED]']
 * @returns {Record<string, any>}
 */
export function redact(obj, mask = '[REDACTED]') {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, mask));
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (looksSecret(key)) {
      out[key] = mask;
    } else if (value && typeof value === 'object') {
      out[key] = redact(value, mask);
    } else {
      out[key] = value;
    }
  }
  return out;
}
