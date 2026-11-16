/**
 * The launcher sets up Python too (audit F12 / P6).
 *
 * Node, dependencies, config and the browser were set up by the launchers;
 * Python (needed for resume tailoring) was a manual step, and System health
 * said so. The shared launch script now finds Python 3.12+, makes the
 * project's virtual environment and installs requirements.txt, and records
 * what it installed so it does it again only when requirements.txt changes.
 * It never stops the launch: without Python, jobs use the master resume.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensurePythonEnv } from '../../scripts/prepareLaunch.mjs';
import { dashboardFix } from '../../src/dashboard/healthFixes.js';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jobagent-pysetup-'));
  writeFileSync(join(root, 'requirements.txt'), 'python-docx==1.2.0\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** A fake process runner: python3 is 3.12; creating the venv makes its python. */
function fakeRun({ versions = { python3: 'Python 3.12.4' }, pipOk = true } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === '--version') return versions[cmd] ? { ok: true, stdout: versions[cmd] } : { ok: false, stdout: '' };
    if (args[0] === '-m' && args[1] === 'venv') {
      const bin = join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'), '');
      return { ok: true };
    }
    if (args.includes('pip')) return { ok: pipOk };
    return { ok: false };
  };
  return { run, calls };
}

describe('ensurePythonEnv', () => {
  it('makes the virtual environment and installs the requirements, once', () => {
    const { run, calls } = fakeRun();
    const r = ensurePythonEnv({ root, run, log: () => {} });
    expect(r).toMatchObject({ ok: true, installed: true });
    expect(calls.some((c) => c.includes('venv'))).toBe(true);
    expect(calls.some((c) => c.includes('pip') && c.includes('requirements.txt'))).toBe(true);
    const again = ensurePythonEnv({ root, run, log: () => {} });
    expect(again).toMatchObject({ ok: true, installed: false });
  });

  it('installs again when requirements.txt changes', () => {
    const { run } = fakeRun();
    ensurePythonEnv({ root, run, log: () => {} });
    writeFileSync(join(root, 'requirements.txt'), 'python-docx==1.2.1\n');
    expect(ensurePythonEnv({ root, run, log: () => {} })).toMatchObject({ ok: true, installed: true });
  });

  it('refuses a Python older than 3.12 and says what to install, without failing the launch', () => {
    const { run, calls } = fakeRun({ versions: { python3: 'Python 3.9.6' } });
    const lines = [];
    const r = ensurePythonEnv({ root, run, log: (l) => lines.push(l) });
    expect(r).toMatchObject({ ok: false, installed: false });
    expect(lines.join(' ')).toMatch(/3\.12/);
    expect(calls.some((c) => c.includes('venv'))).toBe(false);
    expect(existsSync(join(root, '.venv'))).toBe(false);
  });

  it('does not record success when pip fails, so it tries again next time', () => {
    const { run } = fakeRun({ pipOk: false });
    expect(ensurePythonEnv({ root, run, log: () => {} })).toMatchObject({ ok: false });
    expect(existsSync(join(root, '.venv', '.jobagent-requirements'))).toBe(false);
  });

  it('records what it installed', () => {
    const { run } = fakeRun();
    ensurePythonEnv({ root, run, log: () => {} });
    expect(readFileSync(join(root, '.venv', '.jobagent-requirements'), 'utf8')).toMatch(/^[0-9a-f]{64}/);
  });
});

describe('System health', () => {
  it('points at the launcher for Python now, with no command', () => {
    const fix = dashboardFix({ id: 'python', status: 'warn', fix: 'x' });
    expect(fix).toMatch(/launcher/i);
    expect(fix).not.toMatch(/npm|pip|`/);
  });
});
