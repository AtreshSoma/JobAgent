import { describe, it, expect } from 'vitest';
import {
  getSecret,
  requireSecrets,
  getRuntimeSettings,
  redact,
} from '../../src/utils/credentialManager.js';

describe('credentialManager', () => {
  it('getSecret reads, trims, and supports required/fallback', () => {
    const env = { API: '  abc  ', EMPTY: '   ' };
    expect(getSecret('API', { env })).toBe('abc');
    expect(getSecret('MISSING', { env })).toBeUndefined();
    expect(getSecret('MISSING', { env, fallback: 'def' })).toBe('def');
    expect(() => getSecret('EMPTY', { env, required: true })).toThrow(/Missing required secret: EMPTY/);
  });

  it('requireSecrets aggregates all missing keys', () => {
    const env = { A: '1', B: '' };
    expect(() => requireSecrets(['A'], env)).not.toThrow();
    expect(() => requireSecrets(['A', 'B', 'C'], env)).toThrow(/B, C/);
  });

  it('getRuntimeSettings parses and defaults safely', () => {
    expect(getRuntimeSettings({})).toEqual({
      mode: 'DRY_RUN',
      maxApplicationsPerDay: 15,
      headless: false,
      browserChannel: null,
      browserUserDataDir: null,
      browserSlowMo: 0,
      assistMaxSteps: 8,
      resumeExportPdf: true,
      jobFreshnessMode: 'LAST_7_DAYS',
      includeLast3DaysFallback: true,
      minResultsBeforeFallback: 10,
      includeUnknownDateJobs: false,
      excludeAlreadyApplied: true,
    });
    const s = getRuntimeSettings({
      RUN_MODE: 'prepare',
      MAX_APPLICATIONS_PER_DAY: '5',
      HEADLESS: 'true',
      BROWSER_CHANNEL: 'msedge',
      BROWSER_USER_DATA_DIR: 'C:/profiles/edge',
      BROWSER_SLOW_MO: '150',
      ASSIST_MAX_STEPS: '4',
      RESUME_EXPORT_PDF: 'false',
      JOB_FRESHNESS_MODE: 'last_24_hours',
      INCLUDE_LAST_3_DAYS_FALLBACK: 'false',
      MIN_RESULTS_BEFORE_3_DAY_FALLBACK: '25',
      INCLUDE_UNKNOWN_DATE_JOBS: 'true',
      EXCLUDE_ALREADY_APPLIED: 'false',
    });
    expect(s).toEqual({
      mode: 'PREPARE',
      maxApplicationsPerDay: 5,
      headless: true,
      browserChannel: 'msedge',
      browserUserDataDir: 'C:/profiles/edge',
      browserSlowMo: 150,
      assistMaxSteps: 4,
      resumeExportPdf: false,
      jobFreshnessMode: 'LAST_24_HOURS',
      includeLast3DaysFallback: false,
      minResultsBeforeFallback: 25,
      includeUnknownDateJobs: true,
      excludeAlreadyApplied: false,
    });
    // Invalid mode falls back to DRY_RUN; the removed LIVE_SUBMIT is no longer
    // a valid mode and is treated as the safe default (DRY_RUN).
    expect(getRuntimeSettings({ RUN_MODE: 'BOGUS' }).mode).toBe('DRY_RUN');
    expect(getRuntimeSettings({ RUN_MODE: 'live_submit' }).mode).toBe('DRY_RUN');
    expect(getRuntimeSettings({ RUN_MODE: 'live_assist' }).mode).toBe('LIVE_ASSIST');
    // Invalid freshness mode falls back to LAST_7_DAYS (recalibrated default:
    // the 3-day hard window discarded >75% of scoreable jobs before ranking).
    expect(getRuntimeSettings({ JOB_FRESHNESS_MODE: 'nonsense' }).jobFreshnessMode).toBe('LAST_7_DAYS');
  });

  it('redact masks secret-looking keys recursively', () => {
    const input = {
      user: 'priya',
      password: 'hunter2',
      nested: { apiKey: 'xyz', token: 't', safe: 1 },
      list: [{ cookie: 'c' }],
    };
    const out = redact(input);
    expect(out.user).toBe('priya');
    expect(out.password).toBe('[REDACTED]');
    expect(out.nested.apiKey).toBe('[REDACTED]');
    expect(out.nested.token).toBe('[REDACTED]');
    expect(out.nested.safe).toBe(1);
    expect(out.list[0].cookie).toBe('[REDACTED]');
    // Original is untouched.
    expect(input.password).toBe('hunter2');
  });
});
