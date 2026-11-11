/**
 * A stale node_modules is detected and refreshed, not just a missing one.
 *
 * The launchers used to check only that node_modules existed; one machine ran
 * vitest 2.1.9 against a lockfile pinning 4.1.10 for weeks.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installNeeded, installedVersionDrift, lockfileHash, writeInstallStamp,
  compareVersions, nodeVersionSupported, INSTALL_STAMP,
} from '../../src/cli/dependencyCheck.js';
import { ensureDependencies } from '../../scripts/prepareLaunch.mjs';
import { runDoctor } from '../../src/cli/doctor.js';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deps-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { alpha: '^1.0.0' }, devDependencies: { beta: '^2.0.0' } }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    packages: { 'node_modules/alpha': { version: '1.2.0' }, 'node_modules/beta': { version: '2.5.0' } },
  }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const install = (name, version) => {
  mkdirSync(join(root, 'node_modules', name), { recursive: true });
  writeFileSync(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version }));
};

describe('installNeeded', () => {
  it('needs an install when node_modules is missing', () => {
    expect(installNeeded(root)).toMatchObject({ needed: true, reason: /missing/ });
  });

  it('needs an install when node_modules exists but was never stamped', () => {
    install('alpha', '1.2.0');
    expect(installNeeded(root)).toMatchObject({ needed: true, reason: /no install stamp/ });
  });

  it('is up to date only while the lockfile hash matches the stamp', () => {
    install('alpha', '1.2.0');
    writeInstallStamp(root);
    expect(readFileSync(join(root, INSTALL_STAMP), 'utf8').trim()).toBe(lockfileHash(root));
    expect(installNeeded(root).needed).toBe(false);
    // A git pull that changes the lockfile makes the install stale.
    writeFileSync(join(root, 'package-lock.json'), '{"packages":{}}');
    expect(installNeeded(root)).toMatchObject({ needed: true, reason: /package-lock\.json changed/ });
  });
});

describe('ensureDependencies (the launchers)', () => {
  it('runs npm ci and stamps the install', () => {
    const run = vi.fn((args) => { install('alpha', '1.2.0'); return { ok: args[0] === 'ci' }; });
    const r = ensureDependencies({ root, run, log: () => {} });
    expect(r).toMatchObject({ ok: true, installed: true, via: 'npm ci' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(installNeeded(root).needed).toBe(false);
  });

  it('falls back to npm install when npm ci fails, and says why', () => {
    const lines = [];
    const run = vi.fn((args) => { install('alpha', '1.2.0'); return { ok: args[0] === 'install', status: 1 }; });
    const r = ensureDependencies({ root, run, log: (l) => lines.push(l) });
    expect(r).toMatchObject({ ok: true, via: 'npm install' });
    expect(run.mock.calls.map((c) => c[0][0])).toEqual(['ci', 'install']);
    expect(lines.join('\n')).toMatch(/npm ci failed.*Trying npm install/s);
  });

  it('does nothing when the stamp is current', () => {
    install('alpha', '1.2.0');
    writeInstallStamp(root);
    const run = vi.fn();
    expect(ensureDependencies({ root, run, log: () => {} })).toMatchObject({ ok: true, installed: false });
    expect(run).not.toHaveBeenCalled();
  });

  it('reports failure when both installers fail', () => {
    const r = ensureDependencies({ root, run: () => ({ ok: false, status: 1 }), log: () => {} });
    expect(r.ok).toBe(false);
  });
});

describe('installedVersionDrift (doctor)', () => {
  it('lists direct dependencies whose installed version differs from the lockfile', () => {
    install('alpha', '1.2.0');
    install('beta', '2.1.9');
    expect(installedVersionDrift(root)).toEqual({
      checked: 2, drift: [{ name: 'beta', installed: '2.1.9', locked: '2.5.0' }],
    });
  });

  it('doctor warns with "npm ci" on drift', async () => {
    const result = await runDoctor({
      root, env: {},
      deps: { dependencyDrift: () => ({ checked: 1, drift: [{ name: 'vitest', installed: '2.1.9', locked: '4.1.10' }] }) },
    });
    const check = result.checks.find((c) => c.id === 'dependencies');
    expect(check).toMatchObject({ status: 'warn' });
    expect(check.detail).toMatch(/vitest 2\.1\.9 \(lockfile 4\.1\.10\)/);
    expect(check.fix).toMatch(/npm ci/);
  });
});

describe('Node version floor', () => {
  it('compares full semver, not just the major', () => {
    expect(nodeVersionSupported('v22.5.0')).toBe(false);
    expect(nodeVersionSupported('v22.12.9')).toBe(false);
    expect(nodeVersionSupported('v22.13.0')).toBe(true);
    expect(nodeVersionSupported('v24.1.0')).toBe(true);
    expect(nodeVersionSupported('v25.0.0-nightly2026')).toBe(true);
    expect(compareVersions('22.13.1', '22.13.0')).toBeGreaterThan(0);
  });

  it('doctor fails an old 22.x with ">= 22.13 required"', async () => {
    const result = await runDoctor({ root, env: {}, deps: { nodeVersion: 'v22.5.1', dependencyDrift: () => null } });
    const check = result.checks.find((c) => c.id === 'node');
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/>= 22\.13 required/);
  });
});
