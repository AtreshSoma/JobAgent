/**
 * Settings the user changes from the dashboard, stored in data/settings.json.
 *
 * WHY A SEPARATE FILE. The two freshness controls a person actually needs —
 * "how new must a posting be to be added?" and "when does a job leave my
 * board?" — lived in two different places: the discovery window in `.env`
 * (JOB_FRESHNESS_MODE) and the retention limit in the tracked
 * config/exclusions.json. Neither was visible in the dashboard, and the store
 * this was written against discarded ~70,000 postings as "stale" under a
 * 3-day window nobody could see. These settings are personal, so they live
 * under data/ (gitignored) and OVERRIDE the file-based values when present.
 *
 * Backward compatible by construction: with no settings file, every value
 * comes from `.env` and config/ exactly as before.
 *
 * Background description fetching is OFF until the user turns it on here.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { FRESHNESS_MODES, FRESHNESS_WINDOW_DAYS } from '../utils/credentialManager.js';

/** Bounds for the retention limit, in days. */
export const RETENTION_RANGE = Object.freeze({ min: 7, max: 365 });

/**
 * Enrichment (fetching descriptions that discovery never read) defaults.
 * Conservative on purpose: a few requests per host at a time, spaced out, a
 * bounded pass, and a per-source budget so one large ATS cannot use it all.
 */
export const ENRICHMENT_DEFAULTS = Object.freeze({
  enabled: false,
  maxPerPass: 100,
  perSourceBudget: 40,
  hostConcurrency: 2,
  minSpacingMs: 1000,
  maxRetries: 2,
  maxAttempts: 3,
  retryAfterHours: 24,
  intervalHours: 6,
});

/** Numeric enrichment settings and their allowed ranges. */
const ENRICHMENT_RANGES = Object.freeze({
  maxPerPass: [1, 1000],
  perSourceBudget: [1, 1000],
  hostConcurrency: [1, 8],
  minSpacingMs: [0, 60_000],
  maxRetries: [0, 5],
  maxAttempts: [1, 10],
  retryAfterHours: [1, 24 * 30],
  intervalHours: [1, 24 * 7],
});

/** @param {string} root project root */
export function settingsPath(root) {
  return join(root, 'data', 'settings.json');
}

/**
 * The stored settings, or `{}`. A corrupt file is reported, not fatal: the
 * dashboard must still start, on the file-based values.
 *
 * @param {string} root
 * @returns {{settings: object, error: string|null}}
 */
export function readUserSettings(root) {
  const path = settingsPath(root);
  if (!root || !existsSync(path)) return { settings: {}, error: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { settings: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}, error: null };
  } catch (err) {
    return { settings: {}, error: `data/settings.json is not valid JSON (${err.message}); using defaults` };
  }
}

/**
 * Validate a settings PATCH. Unknown keys are rejected so a typo is reported
 * instead of silently ignored.
 *
 * @param {object} patch
 * @returns {string[]} problems; empty when valid
 */
export function validateSettingsPatch(patch = {}) {
  const problems = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return ['settings must be an object'];
  for (const key of Object.keys(patch)) {
    if (!['discoveryWindow', 'retentionDays', 'enrichment'].includes(key)) problems.push(`unknown setting: ${key}`);
  }
  if (patch.discoveryWindow !== undefined && patch.discoveryWindow !== null
    && !FRESHNESS_MODES.includes(patch.discoveryWindow)) {
    problems.push(`discoveryWindow must be one of ${FRESHNESS_MODES.join(', ')}`);
  }
  if (patch.retentionDays !== undefined && patch.retentionDays !== null) {
    const n = Number(patch.retentionDays);
    if (!Number.isInteger(n) || n < RETENTION_RANGE.min || n > RETENTION_RANGE.max) {
      problems.push(`retentionDays must be a whole number from ${RETENTION_RANGE.min} to ${RETENTION_RANGE.max}`);
    }
  }
  if (patch.enrichment !== undefined) {
    const e = patch.enrichment;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      problems.push('enrichment must be an object');
    } else {
      for (const [key, value] of Object.entries(e)) {
        if (key === 'enabled') {
          if (typeof value !== 'boolean') problems.push('enrichment.enabled must be true or false');
          continue;
        }
        const range = ENRICHMENT_RANGES[key];
        if (!range) { problems.push(`unknown enrichment setting: ${key}`); continue; }
        const n = Number(value);
        if (!Number.isInteger(n) || n < range[0] || n > range[1]) {
          problems.push(`enrichment.${key} must be a whole number from ${range[0]} to ${range[1]}`);
        }
      }
    }
  }
  return problems;
}

/**
 * Merge a validated patch into the stored settings and write atomically
 * (temp file + rename), so an interrupted write never leaves half a file.
 * `null` for discoveryWindow / retentionDays clears the override.
 *
 * @param {string} root
 * @param {object} patch
 * @returns {object} the settings now stored
 */
export function writeUserSettings(root, patch) {
  const problems = validateSettingsPatch(patch);
  if (problems.length) {
    const err = new Error(problems.join('; '));
    err.statusCode = 400;
    throw err;
  }
  const { settings: current } = readUserSettings(root);
  const next = { ...current };
  for (const key of ['discoveryWindow', 'retentionDays']) {
    if (patch[key] === null) delete next[key];
    else if (patch[key] !== undefined) next[key] = key === 'retentionDays' ? Number(patch[key]) : patch[key];
  }
  if (patch.enrichment) {
    next.enrichment = { ...(current.enrichment ?? {}) };
    for (const [key, value] of Object.entries(patch.enrichment)) {
      next.enrichment[key] = key === 'enabled' ? value : Number(value);
    }
  }
  // A window wider than retention would admit a posting only to retire it.
  const windowDays = FRESHNESS_WINDOW_DAYS[next.discoveryWindow];
  if (next.retentionDays && Number.isFinite(windowDays) && windowDays > next.retentionDays) {
    const err = new Error(`the discovery window (${windowDays} days) cannot be longer than retention (${next.retentionDays} days)`);
    err.statusCode = 400;
    throw err;
  }
  const path = settingsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return next;
}

/**
 * Apply stored settings over the file-based runtime and exclusions.
 *
 * @param {{runtime: object, exclusions: object}} parts
 * @param {object} settings stored settings
 * @returns {{runtime: object, exclusions: object, sources: {discoveryWindow: string, retentionDays: string}}}
 *   new objects, plus where each effective value came from ('settings' | 'env' | 'config')
 */
export function applyUserSettings({ runtime = {}, exclusions = {} } = {}, settings = {}) {
  const out = {
    runtime: { ...runtime },
    exclusions: { ...exclusions, staleness: { ...(exclusions.staleness ?? {}) } },
    sources: { discoveryWindow: 'env', retentionDays: 'config' },
  };
  if (FRESHNESS_MODES.includes(settings.discoveryWindow)) {
    out.runtime.jobFreshnessMode = settings.discoveryWindow;
    out.sources.discoveryWindow = 'settings';
  }
  const retention = Number(settings.retentionDays);
  if (Number.isInteger(retention) && retention >= RETENTION_RANGE.min && retention <= RETENTION_RANGE.max) {
    out.exclusions.staleness.skipOlderThanDays = retention;
    out.sources.retentionDays = 'settings';
  }
  const enrichment = { ...ENRICHMENT_DEFAULTS };
  for (const [key, value] of Object.entries(settings.enrichment ?? {})) {
    if (key === 'enabled') enrichment.enabled = value === true;
    else if (ENRICHMENT_RANGES[key]) {
      const n = Number(value);
      const [lo, hi] = ENRICHMENT_RANGES[key];
      if (Number.isInteger(n) && n >= lo && n <= hi) enrichment[key] = n;
    }
  }
  out.runtime.enrichment = enrichment;
  return out;
}
