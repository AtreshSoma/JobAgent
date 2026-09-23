/**
 * P3 — script and cache write safety.
 *
 *  - harvestSources refuses a merged config that fails the schema or would
 *    list a board twice.
 *  - enrichDescriptions derives the Workday tenant correctly for
 *    myworkdaysite.com/recruiting/<tenant>/<site> URLs, and skips expired rows.
 *  - source_timings.json is written atomically (temp + rename).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkHarvestedConfig } from '../../scripts/harvestSources.mjs';
import { workdayDetailApi, isExpiredRow } from '../../scripts/enrichDescriptions.mjs';
import { duplicateCoordinateKeys } from '../../src/search/sourceHarvest.js';
import { createSourceTimings } from '../../src/search/sourceTimings.js';

const board = (sources) => ({ defaults: { rateLimitMs: 0, maxRetries: 0 }, sources });

describe('harvest write validation', () => {
  it('accepts a valid config with no new duplicates', () => {
    const cfg = board([{ id: 'gh', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['acme'] }]);
    expect(checkHarvestedConfig(cfg, cfg)).toEqual([]);
  });

  it('refuses a board listed twice that was not already listed twice', () => {
    const before = board([{ id: 'gh', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['acme'] }]);
    const after = board([{ id: 'gh', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['acme', 'acme'] }]);
    expect(duplicateCoordinateKeys(after)).toHaveLength(1);
    expect(checkHarvestedConfig(after, before).join(' ')).toMatch(/listed twice/);
  });

  it('refuses a config that fails the schema', () => {
    expect(checkHarvestedConfig({ sources: 'nope' }, {}).length).toBeGreaterThan(0);
  });
});

describe('enrichDescriptions helpers', () => {
  it('derives the tenant from the path on myworkdaysite.com', () => {
    expect(workdayDetailApi('https://wd5.myworkdaysite.com/en-US/recruiting/acme/External/job/Austin-TX/Data-Engineer_R1'))
      .toBe('https://wd5.myworkdaysite.com/wday/cxs/acme/External/job/Austin-TX/Data-Engineer_R1');
    expect(workdayDetailApi('https://wd5.myworkdaysite.com/recruiting/acme/External/job/Data-Engineer_R1'))
      .toBe('https://wd5.myworkdaysite.com/wday/cxs/acme/External/job/Data-Engineer_R1');
  });

  it('keeps the host-label tenant on myworkdayjobs.com', () => {
    expect(workdayDetailApi('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/X_JR1'))
      .toBe('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/X_JR1');
    expect(workdayDetailApi('not a url')).toBeNull();
  });

  it('recognizes expired rows', () => {
    expect(isExpiredRow({ status: 'discarded', discard_reason: 'expired: not listed by source for 3 runs' })).toBe(true);
    expect(isExpiredRow({ status: 'expired' })).toBe(true);
    expect(isExpiredRow({ status: 'scored' })).toBe(false);
  });
});

describe('source timings', () => {
  it('writes atomically and records notes apart from errors', () => {
    const root = mkdtempSync(join(tmpdir(), 'timings-'));
    const t = createSourceTimings({ root, now: () => Date.parse('2026-09-22T00:00:00Z') });
    t.record([{ source: 'wd', durationMs: 100, found: 3, errors: 0, notes: 2 }]);
    const file = join(root, 'data', 'source_timings.json');
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(join(root, 'data')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const entry = JSON.parse(readFileSync(file, 'utf8')).sources.wd.history[0];
    expect(entry).toMatchObject({ errors: 0, notes: 2 });
  });
});
