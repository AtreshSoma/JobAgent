/**
 * System health in the dashboard shows screens and buttons, never command
 * lines (S1). `npm run doctor` keeps its terminal fixes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { COMMAND_LINE, dashboardFix, forDashboard } from '../../src/dashboard/healthFixes.js';
import { runDoctor } from '../../src/cli/doctor.js';
import { buildTestRoot } from './globalSetup.js';

const DOCTOR = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'cli', 'doctor.js'), 'utf8');
const CHECK_IDS = [...new Set([...DOCTOR.matchAll(/makeCheck\('([a-z-]+)'/g)].map((m) => m[1]))];

describe('System health fixes in the dashboard', () => {
  it('every doctor check that can fail has a fix with no command line', () => {
    expect(CHECK_IDS.length).toBeGreaterThan(15);
    for (const id of CHECK_IDS) {
      const fix = dashboardFix({ id, status: 'warn', fix: 'Run: npm ci' });
      expect(fix, id).toBeTruthy();
      expect(fix, id).not.toMatch(COMMAND_LINE);
    }
  });

  it('an unknown check keeps a plain fix and loses a command', () => {
    expect(dashboardFix({ id: 'new-check', status: 'warn', fix: 'Restart your computer.' })).toBe('Restart your computer.');
    expect(dashboardFix({ id: 'new-check', status: 'warn', fix: 'Run `npm run something`' })).not.toMatch(COMMAND_LINE);
    expect(dashboardFix({ id: 'node', status: 'pass' })).toBeNull();
  });

  it('a real doctor report, rewritten, holds no command line', async () => {
    const root = buildTestRoot();
    const report = forDashboard(await runDoctor({ env: process.env, root }));
    expect(report.checks.length).toBeGreaterThan(10);
    for (const check of report.checks) {
      if (check.fix) expect(check.fix, check.id).not.toMatch(COMMAND_LINE);
    }
    // The terminal report is untouched.
    const terminal = await runDoctor({ env: process.env, root });
    expect(terminal.checks.some((c) => /npm|npx|pip|config\//.test(c.fix ?? '') || c.status === 'pass')).toBe(true);
  }, 60_000);
});
