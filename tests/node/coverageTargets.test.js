/**
 * Every employer in config/coverage_targets.json with an automated route must
 * be configured in an enabled source (audit 2026-11-20, plan 3.4). Microsoft,
 * Apple and ~30 other major employers were missing from the config for months
 * with nothing to say so; this makes that a test failure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { configuredIn, matchesCompany, NON_ROUTES, zeroYieldTargets } from '../../src/search/coverageTargets.js';

const root = join(import.meta.dirname, '..', '..');
const targets = JSON.parse(readFileSync(join(root, 'config', 'coverage_targets.json'), 'utf8')).targets;
const jobboards = JSON.parse(readFileSync(join(root, 'config', 'jobboards.json'), 'utf8'));

describe('coverage targets', () => {
  it('lists a reason for every employer without an automated route', () => {
    for (const t of targets.filter((x) => NON_ROUTES.has(x.route))) {
      expect(String(t.reason ?? '').length, t.name).toBeGreaterThan(30);
    }
  });

  it.each(targets.filter((t) => !NON_ROUTES.has(t.route)).map((t) => [t.name, t]))(
    '%s is configured in an enabled source',
    (_name, target) => {
      const sources = configuredIn(target, jobboards);
      expect(sources.length, `${target.name} has route ${target.route} but no enabled source names it`).toBeGreaterThan(0);
      if (target.source) expect(sources).toContain(target.source);
    },
  );
});

describe('matchesCompany', () => {
  it('matches by leading words, not substrings', () => {
    const cisco = { name: 'Cisco' };
    expect(matchesCompany(cisco, 'Cisco Systems, Inc.')).toBe(true);
    expect(matchesCompany(cisco, 'University of California - San Francisco')).toBe(false);
    expect(matchesCompany({ name: 'Amazon' }, 'Amazon.com Services LLC')).toBe(true);
    expect(matchesCompany({ name: 'EY', aliases: ['Ernst & Young'] }, 'Eyenovia')).toBe(false);
  });
});

describe('zeroYieldTargets', () => {
  const boards = { sources: [
    { id: 'wd', adapter: 'workday', enabled: true, tenants: [{ company: 'Contoso' }, { company: 'Fabrikam' }] },
    { id: 'gh', adapter: 'greenhouse', enabled: true, boards: ['northwind'] },
  ] };
  const targets = [
    { name: 'Contoso', route: 'workday' }, { name: 'Fabrikam', route: 'workday' },
    { name: 'Northwind', route: 'greenhouse' }, { name: 'Tailspin', route: 'manual', reason: 'no route' },
  ];

  it('names configured employers a complete listing returned nothing for', () => {
    const out = zeroYieldTargets({
      targets, jobboards: boards, companies: ['Contoso Ltd'],
      perSource: [{ source: 'wd', succeeded: true }, { source: 'gh', succeeded: false }],
    });
    expect(out).toEqual([{ name: 'Fabrikam', sources: ['wd'] }]);
  });

  it('says nothing about a source that skipped pages or was cancelled', () => {
    const out = zeroYieldTargets({
      targets, jobboards: boards, companies: [],
      perSource: [{ source: 'wd', succeeded: true, cached: true }, { source: 'gh', succeeded: true, cancelled: true }],
    });
    expect(out).toEqual([]);
  });
});
