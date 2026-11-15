/**
 * Every browser test file skips, rather than fails, when Chromium is missing
 * (audit P3). On a fresh clone before `npx playwright install chromium`, 14
 * files failed with "Executable doesn't exist" while the rest skipped, so
 * `npm test` reported failures that were not bugs.
 *
 * A file that launches Chromium must route the launch through the shared
 * helper (`browserUnavailable`, or `launchOrSkip` which wraps it). CI keeps
 * REQUIRE_BROWSER=1, so a broken install there still fails loudly.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(import.meta.dirname);
const LAUNCHES = /\bchromium\.launch\s*\(|\blaunchBrowser\s*\(/;
const GUARDED = /\bbrowserUnavailable\b|\blaunchOrSkip\b/;

describe('browser test files without Chromium', () => {
  it('route every Chromium launch through the skip helper', () => {
    const unguarded = readdirSync(DIR)
      .filter((name) => name.endsWith('.test.js'))
      .filter((name) => {
        const text = readFileSync(join(DIR, name), 'utf8');
        return LAUNCHES.test(text) && !GUARDED.test(text);
      });
    expect(unguarded).toEqual([]);
  });
});
