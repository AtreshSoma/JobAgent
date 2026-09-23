/**
 * One Python resolver for the tailor, the PDF preview, the regenerate script
 * and doctor; and a Python bridge that survives split UTF-8 chunks, EPIPE and
 * timeouts without leaking its process tree.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  checkPythonVersion, killProcessTree, pythonCandidates, pythonExe, pythonSpawnOptions, pythonTimeoutMs,
  PYTHON_PDF_BUDGET_SECONDS, venvPython,
} from '../../src/resume/pythonEnv.js';
import { tailorResumeForJob } from '../../src/resume/tailorRunner.js';
import { runDoctor } from '../../src/cli/doctor.js';

describe('pythonExe / pythonCandidates', () => {
  const has = (...paths) => (p) => paths.includes(p);
  it('orders env override, project venv, python3, python', () => {
    expect(pythonExe({ PYTHON: '/x/py' }, { root: '/r', exists: () => true })).toBe('/x/py');
    expect(pythonExe({}, { root: '/r', platform: 'darwin', exists: has('/r/.venv/bin/python') })).toBe('/r/.venv/bin/python');
    expect(pythonExe({ PATH: '/usr/bin:/bin' }, { root: '/r', platform: 'linux', exists: has('/usr/bin/python3', '/bin/python') }))
      .toBe('python3');
    expect(pythonExe({ PATH: '/bin' }, { root: '/r', platform: 'linux', exists: has('/bin/python') })).toBe('python');
    expect(venvPython('C:\\r', 'win32')).toMatch(/\.venv[\\/]Scripts[\\/]python\.exe$/);
    expect(pythonExe({ PATH: 'C:\\Tools;C:\\Users\\Alice\\WindowsApps' }, {
      root: 'C:\\r', platform: 'win32', exists: has('C:\\Tools\\python.exe'),
    })).toBe('python');
    expect(pythonCandidates({}, { root: '/r', exists: has('/r/.venv/bin/python'), platform: 'linux' }))
      .toEqual(['/r/.venv/bin/python', 'python3', 'python']);
  });

  it('checks the minimum version', () => {
    expect(checkPythonVersion('Python 3.12.4')).toEqual({ version: '3.12.4', ok: true });
    expect(checkPythonVersion('Python 3.11.9').ok).toBe(false);
    expect(checkPythonVersion('Python 4.0').ok).toBe(true);
    expect(checkPythonVersion('garbage')).toEqual({ version: null, ok: false });
  });

  it('gives Node more time than Python\'s own PDF limits', () => {
    expect(pythonTimeoutMs({ exportPdf: true })).toBeGreaterThan(PYTHON_PDF_BUDGET_SECONDS * 1000);
    expect(pythonTimeoutMs({})).toBe(60_000);
    expect(pythonSpawnOptions({}, 'linux')).toMatchObject({ detached: true });
    expect(pythonSpawnOptions({}, 'win32')).not.toHaveProperty('detached');
  });

  it('kills the process group on POSIX and the tree on Windows', () => {
    const kills = [];
    killProcessTree({ pid: 42, kill: () => kills.push('direct') }, { platform: 'linux', killImpl: (pid, sig) => kills.push([pid, sig]) });
    expect(kills).toEqual([[-42, 'SIGKILL']]);
    const spawned = [];
    killProcessTree({ pid: 7 }, { platform: 'win32', spawnImpl: (c, a) => spawned.push([c, ...a]) });
    expect(spawned).toEqual([['taskkill', '/pid', '7', '/T', '/F']]);
  });
});

/** A fake child whose stdout emits `chunks`, then closes. */
function fakeChild({ chunks = [], stdinError = false, hang = false } = {}) {
  const child = new EventEmitter();
  child.pid = 99;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {};
  if (stdinError) {
    child.stdin.write = () => { setImmediate(() => child.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }))); return false; };
  }
  if (!hang) {
    setImmediate(() => {
      for (const c of chunks) child.stdout.write(c);
      child.stdout.end();
      setImmediate(() => child.emit('close', stdinError ? 1 : 0));
    });
  }
  return child;
}

describe('tailor bridge', () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-'));
  mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
  writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), 'x');
  const out = join(root, 'resumes', 'base', 'MASTER_RESUME.docx');
  const base = { job: { company: 'Acme', title: 'DE', jdText: '' }, score: {}, config: { root }, options: { llmAssist: false } };

  it('decodes a multi-byte character split across two chunks', async () => {
    const bytes = Buffer.from(JSON.stringify({ ok: true, output_path: out, summary_line: '84.51°' }));
    const cut = bytes.indexOf(Buffer.from('°')) + 1; // inside the 2-byte sequence
    let opts = null;
    const r = await tailorResumeForJob({
      ...base,
      deps: { spawnImpl: (_exe, _args, o) => { opts = o; return fakeChild({ chunks: [bytes.subarray(0, cut), bytes.subarray(cut)] }); } },
    });
    expect(r.summaryLine).toBe('84.51°');
    expect(opts.env.PYTHONUTF8).toBe('1');
  });

  it('survives EPIPE on stdin instead of crashing the process', async () => {
    const r = await tailorResumeForJob({ ...base, deps: { spawnImpl: () => fakeChild({ stdinError: true }) } });
    expect(r.tailored).toBe(false);
    expect(r.warning).toMatch(/produced no output/);
  });

  it('kills the whole tree on timeout', async () => {
    const killed = [];
    const r = await tailorResumeForJob({
      ...base,
      deps: {
        spawnImpl: () => fakeChild({ hang: true }), timeoutMs: 20, platform: 'linux',
        killImpl: (pid, sig) => killed.push([pid, sig]),
      },
    });
    expect(r.warning).toMatch(/timed out after 20ms/);
    expect(killed).toEqual([[-99, 'SIGKILL']]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('doctor python check', () => {
  it('uses the resolver, prints the resolved path and requires 3.12+', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-py-'));
    try {
      const probed = [];
      const spawnImpl = (cmd) => { probed.push(cmd); return { status: 0, stdout: 'Python 3.11.2\n', stderr: '' }; };
      const result = await runDoctor({ root, env: { PYTHON: '/opt/py311/bin/python' }, deps: { spawnImpl } });
      const py = result.checks.find((c) => c.id === 'python');
      expect(probed[0]).toBe('/opt/py311/bin/python');
      expect(py.status).toBe('warn');
      expect(py.detail).toMatch(/\/opt\/py311\/bin\/python is Python 3\.11\.2/);
      expect(py.fix ?? py.hint ?? JSON.stringify(py)).toMatch(/Install Python 3\.12\+/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
