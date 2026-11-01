/**
 * P1A — user-facing freshness/retention/enrichment settings and the
 * "why was it filtered" categorizer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readUserSettings, writeUserSettings, validateSettingsPatch, applyUserSettings, settingsPath, ENRICHMENT_DEFAULTS,
} from '../../src/config/userSettings.js';
import { discardCategory, dataQualitySummary, freshnessSummary } from '../../src/dashboard/dataQuality.js';
import { freshnessModelFor } from '../../src/scoring/scorer.js';
import { openDatabase } from '../../src/logging/db.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'settings-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('user settings file', () => {
  it('is empty and harmless when absent (backward compatible)', () => {
    expect(readUserSettings(root)).toEqual({ settings: {}, error: null });
    const applied = applyUserSettings({ runtime: { jobFreshnessMode: 'LAST_3_DAYS' }, exclusions: { staleness: { skipOlderThanDays: 45 } } }, {});
    expect(applied.runtime.jobFreshnessMode).toBe('LAST_3_DAYS');
    expect(applied.exclusions.staleness.skipOlderThanDays).toBe(45);
    expect(applied.sources).toEqual({ discoveryWindow: 'env', retentionDays: 'config' });
    expect(applied.runtime.enrichment).toEqual(ENRICHMENT_DEFAULTS);
    expect(applied.runtime.enrichment.enabled).toBe(false);
  });

  it('overrides .env and exclusions.json when set, and the freshness model follows', () => {
    writeUserSettings(root, { discoveryWindow: 'LAST_14_DAYS', retentionDays: 60, enrichment: { enabled: true, maxPerPass: 50 } });
    const { settings } = readUserSettings(root);
    const applied = applyUserSettings({ runtime: { jobFreshnessMode: 'LAST_3_DAYS' }, exclusions: { staleness: { skipOlderThanDays: 45, flagOlderThanDays: 7 } } }, settings);
    expect(applied.runtime.jobFreshnessMode).toBe('LAST_14_DAYS');
    expect(applied.exclusions.staleness).toEqual({ skipOlderThanDays: 60, flagOlderThanDays: 7 });
    expect(applied.sources).toEqual({ discoveryWindow: 'settings', retentionDays: 'settings' });
    expect(applied.runtime.enrichment).toMatchObject({ enabled: true, maxPerPass: 50, perSourceBudget: ENRICHMENT_DEFAULTS.perSourceBudget });
    expect(freshnessModelFor(applied)).toEqual({ discoveryDays: 14, retentionDays: 60 });
  });

  it('writes atomically and leaves no temp file behind', () => {
    writeUserSettings(root, { retentionDays: 30 });
    expect(JSON.parse(readFileSync(settingsPath(root), 'utf8'))).toEqual({ retentionDays: 30 });
    expect(readdirSync(join(root, 'data')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('merges patches and clears an override with null', () => {
    writeUserSettings(root, { discoveryWindow: 'LAST_7_DAYS', retentionDays: 30 });
    writeUserSettings(root, { enrichment: { enabled: true } });
    expect(readUserSettings(root).settings).toEqual({ discoveryWindow: 'LAST_7_DAYS', retentionDays: 30, enrichment: { enabled: true } });
    writeUserSettings(root, { discoveryWindow: null });
    expect(readUserSettings(root).settings).toEqual({ retentionDays: 30, enrichment: { enabled: true } });
  });

  it('rejects unknown keys, out-of-range values, and a window longer than retention', () => {
    expect(validateSettingsPatch({ nope: 1 })).toEqual(['unknown setting: nope']);
    expect(validateSettingsPatch({ discoveryWindow: 'LAST_2_DAYS' })[0]).toMatch(/discoveryWindow/);
    expect(validateSettingsPatch({ retentionDays: 3 })[0]).toMatch(/retentionDays/);
    expect(validateSettingsPatch({ enrichment: { enabled: 'yes' } })[0]).toMatch(/enabled/);
    expect(validateSettingsPatch({ enrichment: { hostConcurrency: 50 } })[0]).toMatch(/hostConcurrency/);
    expect(validateSettingsPatch({ enrichment: { bogus: 1 } })[0]).toMatch(/unknown enrichment/);
    expect(() => writeUserSettings(root, { discoveryWindow: 'LAST_30_DAYS', retentionDays: 14 })).toThrow(/cannot be longer/);
    expect(() => writeUserSettings(root, { retentionDays: 3 })).toThrow(/retentionDays/);
  });

  it('reports a corrupt file instead of failing', () => {
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(settingsPath(root), '{ not json');
    const out = readUserSettings(root);
    expect(out.settings).toEqual({});
    expect(out.error).toMatch(/not valid JSON/);
  });
});

describe('discardCategory', () => {
  it.each([
    ['stale: posted 29 day(s) ago (> 3d window)', 'outside_window'],
    ['stale: unknown posting date', 'undated'],
    ['unknown posting date', 'undated'],
    ['stale_posting: posted 47 days ago', 'retired'],
    ['expired: not listed by source for 3 runs', 'unlisted'],
    ['below near-miss threshold', 'low_fit'],
    ['below score threshold (description now read)', 'low_fit'],
    ['not judged: the description was never fetched (summary only)', 'unread_legacy'],
    ['geography_mismatch: located in Bangalore', 'geography_mismatch'],
    ['below_salary_floor: posted up to 100,000', 'below_salary_floor'],
    ['', 'unlabelled'],
    [null, 'unlabelled'],
  ])('%s -> %s', (reason, key) => {
    expect(discardCategory(reason)).toBe(key);
  });
});

describe('dataQualitySummary', () => {
  it('counts the board and groups discards with plain explanations', () => {
    const db = openDatabase({ path: ':memory:' });
    const row = (id, over) => db.upsertJob({ id, title: 'T', source: 'greenhouse', discovery_mode: 'profile', ...over });
    row('a', { status: 'scored' });
    row('b', { status: 'needs_description', url: 'https://x/1' });
    row('c', { status: 'discarded', discard_reason: 'stale: posted 9 day(s) ago (> 7d window)' });
    row('d', { status: 'discarded', discard_reason: 'stale: posted 12 day(s) ago (> 7d window)' });
    row('e', { status: 'discarded', discard_reason: 'geography_mismatch: Pune' });
    // Role-search rows are not the profile's board.
    db.upsertJob({ id: 'r', title: 'T', status: 'discarded', discard_reason: 'below near-miss threshold', discovery_mode: 'role_search' });
    const config = { runtime: { jobFreshnessMode: 'LAST_7_DAYS' }, exclusions: { staleness: { skipOlderThanDays: 45 } } };
    const out = dataQualitySummary(db, config, { now: new Date('2026-09-22T12:00:00Z') });
    expect(out.board).toMatchObject({ scored: 1, needsDescription: 1, active: 2 });
    expect(out.filtered.map((f) => [f.key, f.count])).toEqual([['outside_window', 2], ['geography_mismatch', 1]]);
    expect(out.filtered[0].action).toMatch(/Widen the discovery window/);
    expect(out.freshness.rules[0]).toMatch(/within 7 days/);
    expect(out.freshness.rules[1]).toMatch(/45 days old/);
    expect(out.enrichment.backlog).toMatchObject({ unread: 1, unsupported: 1 });
    db.close();
  });

  it('describes ALL as any age', () => {
    expect(freshnessSummary({ runtime: { jobFreshnessMode: 'ALL' } }).rules[0]).toMatch(/any age/);
  });
});
