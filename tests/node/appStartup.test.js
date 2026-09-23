import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  createShutdownSignalWait,
  explainConfigError,
  openBrowser,
  parseDashboardPort,
  runApp,
} from '../../src/cli/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function startupHarness(overrides = {}) {
  const events = [];
  const db = {
    close: vi.fn(() => events.push('db.close')),
  };
  const dash = {
    url: 'http://127.0.0.1:4646',
    port: 4646,
    runState: { running: false },
    close: vi.fn(async () => { events.push('dash.close'); }),
  };
  class FakeJobLogger {
    constructor(args) { Object.assign(this, args); }
    error(message) { events.push(`logger.error:${message}`); }
  }
  const deps = {
    loadConfig: () => ({ root: join(ROOT, 'Project With Spaces'), candidate: {} }),
    openDatabase: () => db,
    JobLogger: FakeJobLogger,
    createPinoLogger: () => ({ logger: {} }),
    findFreePort: async (port) => port,
    // Never ask the real 4646: a developer usually has a dashboard running there.
    probeRunningDashboard: async () => null,
    startDashboard: async () => dash,
    installProcessSafetyNet: () => {
      events.push('safety.install');
      return () => events.push('safety.uninstall');
    },
    waitForReady: async () => true,
    openBrowser: vi.fn(() => true),
    shutdownSignal: Promise.resolve(),
    ...overrides,
  };
  return { deps, db, dash, events };
}

const parsed = () => ({ positionals: ['app'], options: {}, flags: new Set(['no-open']) });
const env = () => ({ APP_NO_OPEN: 'true', LOG_LEVEL: 'silent' });

describe('canonical app startup', () => {
  it('validates dashboard ports before trying to listen', () => {
    expect(parseDashboardPort(undefined)).toBe(4646);
    expect(parseDashboardPort('5000')).toBe(5000);
    for (const bad of [0, 65_536, -1, 4.5, 'not-a-port', '4646; Write-Host nope']) {
      expect(() => parseDashboardPort(bad)).toThrow(/whole number from 1 to 65535/);
    }
  });

  it('reports an invalid configured port without opening the database', async () => {
    const h = startupHarness();
    const badParsed = parsed();
    badParsed.options.port = '4646; Write-Host nope';
    const previousExitCode = process.exitCode;
    try {
      const result = await runApp({ parsed: badParsed, env: env(), deps: h.deps });
      expect(result).toMatchObject({ ok: false });
      expect(result.problems[0]).toMatch(/whole number from 1 to 65535/);
      expect(h.db.close).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('closes the server, safety handlers, and database after normal shutdown', async () => {
    const h = startupHarness();
    const result = await runApp({ parsed: parsed(), env: env(), deps: h.deps });

    expect(result).toMatchObject({ ok: true, port: 4646 });
    expect(h.dash.close).toHaveBeenCalledOnce();
    expect(h.db.close).toHaveBeenCalledOnce();
    expect(h.events).toEqual([
      'safety.install', 'dash.close', 'safety.uninstall', 'db.close',
    ]);
  });

  it('cleans every acquired resource when readiness fails', async () => {
    const h = startupHarness({
      waitForReady: async () => { throw new Error('dashboard never became ready'); },
    });

    await expect(runApp({ parsed: parsed(), env: env(), deps: h.deps }))
      .rejects.toThrow(/never became ready/);
    expect(h.dash.close).toHaveBeenCalledOnce();
    expect(h.db.close).toHaveBeenCalledOnce();
    expect(h.events).toEqual([
      'safety.install', 'dash.close', 'safety.uninstall', 'db.close',
    ]);
  });

  it('closes the database when port selection fails before a server exists', async () => {
    const h = startupHarness({
      findFreePort: async () => { throw new Error('no free port'); },
    });

    await expect(runApp({ parsed: parsed(), env: env(), deps: h.deps }))
      .rejects.toThrow(/no free port/);
    expect(h.dash.close).not.toHaveBeenCalled();
    expect(h.db.close).toHaveBeenCalledOnce();
  });

  it('closes the database when the HTTP server fails to start', async () => {
    const h = startupHarness({
      startDashboard: async () => { throw new Error('listen EADDRINUSE'); },
    });

    await expect(runApp({ parsed: parsed(), env: env(), deps: h.deps }))
      .rejects.toThrow(/EADDRINUSE/);
    expect(h.dash.close).not.toHaveBeenCalled();
    expect(h.db.close).toHaveBeenCalledOnce();
  });

  it('removes both signal listeners after either signal resolves shutdown', async () => {
    const proc = new EventEmitter();
    const wait = createShutdownSignalWait(proc);
    expect(proc.listenerCount('SIGINT')).toBe(1);
    expect(proc.listenerCount('SIGTERM')).toBe(1);

    proc.emit('SIGINT', 'SIGINT');
    await expect(wait.promise).resolves.toBe('SIGINT');
    wait.dispose();

    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });

  it('removes both process listeners through the full runApp lifecycle', async () => {
    const proc = new EventEmitter();
    const h = startupHarness({ process: proc });
    delete h.deps.shutdownSignal;

    const running = runApp({ parsed: parsed(), env: env(), deps: h.deps });
    await vi.waitFor(() => {
      expect(proc.listenerCount('SIGINT')).toBe(1);
      expect(proc.listenerCount('SIGTERM')).toBe(1);
    });
    proc.emit('SIGTERM');
    await running;

    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('invalid-configuration startup path', () => {
  it('turns each recognizable config failure into an actionable checklist', () => {
    const candidate = explainConfigError(new Error('ENOENT: no such file config/candidate.json'));
    expect(candidate).not.toBeNull();
    expect(candidate.join(' ')).toMatch(/candidate\.example\.json/);

    const screening = explainConfigError(new Error('ENOENT: no such file config/screening_answers.json'));
    expect(screening.join(' ')).toMatch(/screening_answers\.example\.json/);

    const schema = explainConfigError(new Error('scoring config failed schema validation: weights.titleFit is required'));
    expect(schema.join(' ')).toMatch(/failed validation/);
    expect(schema.join(' ')).toMatch(/titleFit/);

    const generic = explainConfigError(new Error('ENOENT: no such file config/jobboards.json'));
    expect(generic.join(' ')).toMatch(/required file is missing/);
  });

  it('points every missing seeded config file at `npm run setup`', () => {
    for (const file of ['candidate.json', 'screening_answers.json', 'cover_letter.json']) {
      const lines = explainConfigError(new Error(`Config file not found or unreadable: /x/config/${file} (ENOENT)`));
      expect(lines, file).not.toBeNull();
      expect(lines.join(' '), file).toMatch(/npm run setup/);
    }
  });

  it('rethrows an unrecognized error rather than masking it as a setup checklist', () => {
    expect(explainConfigError(new Error('kaboom: totally unexpected'))).toBeNull();
  });

  it('runApp returns a friendly checklist for a missing config, touching no database or server', async () => {
    const h = startupHarness({
      loadConfig: () => { throw new Error('ENOENT: no such file config/candidate.json'); },
      openDatabase: vi.fn(() => { throw new Error('database must not open when config is invalid'); }),
      startDashboard: vi.fn(() => { throw new Error('server must not start when config is invalid'); }),
    });
    const previousExitCode = process.exitCode;
    try {
      const result = await runApp({ parsed: parsed(), env: env(), deps: h.deps });
      expect(result).toMatchObject({ ok: false });
      expect(result.problems.join(' ')).toMatch(/candidate\.example\.json/);
      expect(h.deps.openDatabase).not.toHaveBeenCalled();
      expect(h.deps.startDashboard).not.toHaveBeenCalled();
      expect(h.db.close).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('runApp rethrows an unrecognized config-load failure (never a silent false success)', async () => {
    const h = startupHarness({
      loadConfig: () => { throw new Error('kaboom: totally unexpected'); },
      openDatabase: vi.fn(() => { throw new Error('database must not open'); }),
    });
    await expect(runApp({ parsed: parsed(), env: env(), deps: h.deps }))
      .rejects.toThrow(/kaboom/);
    expect(h.deps.openDatabase).not.toHaveBeenCalled();
  });
});

describe('browser and launcher safety', () => {
  it('starts cleanly and cleans up even when the browser refuses to open', async () => {
    // no-open is deliberately OFF so runApp actually attempts to launch a browser.
    const openParsed = { positionals: ['app'], options: {}, flags: new Set() };
    const openEnv = { LOG_LEVEL: 'silent' };
    const h = startupHarness({ openBrowser: vi.fn(() => false) });

    const result = await runApp({ parsed: openParsed, env: openEnv, deps: h.deps });

    expect(result).toMatchObject({ ok: true, port: 4646 });
    expect(h.deps.openBrowser).toHaveBeenCalledOnce();
    // A failed browser-open must not abort startup or leak resources.
    expect(h.dash.close).toHaveBeenCalledOnce();
    expect(h.db.close).toHaveBeenCalledOnce();
  });

  it('openBrowser returns false when the spawn implementation throws synchronously', () => {
    const spawnImpl = vi.fn(() => { throw new Error('spawn ENOENT'); });
    expect(openBrowser('http://127.0.0.1:4646', { platform: 'win32', spawnImpl })).toBe(false);
  });

  it('consumes asynchronous browser-open errors instead of crashing', () => {
    const child = new EventEmitter();
    child.unref = vi.fn();
    const onError = vi.fn();
    const spawnImpl = vi.fn(() => child);

    expect(openBrowser('http://127.0.0.1:4646', {
      platform: 'linux', spawnImpl, onError,
    })).toBe(true);
    child.emit('error', new Error('xdg-open missing'));

    expect(onError).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(spawnImpl).toHaveBeenCalledWith(
      'xdg-open', ['http://127.0.0.1:4646'], { detached: true, stdio: 'ignore' },
    );
  });

  it('keeps paths with spaces quoted and makes the old dashboard launcher a thin wrapper', () => {
    const cmd = readFileSync(join(ROOT, 'start-job-agent.cmd'), 'utf8');
    const compat = readFileSync(join(ROOT, 'start-dashboard.cmd'), 'utf8');
    const ps = readFileSync(join(ROOT, 'Start-JobAgent.ps1'), 'utf8');
    const sh = readFileSync(join(ROOT, 'start-job-agent.sh'), 'utf8');

    expect(cmd).toContain('cd /d "%~dp0"');
    // Every launcher delegates dependency freshness to one shared script.
    expect(cmd).toContain('node scripts\\prepareLaunch.mjs');
    expect(ps).toContain('node scripts/prepareLaunch.mjs');
    expect(sh).toContain('node scripts/prepareLaunch.mjs');
    expect(ps).toContain('Set-Location -Path $PSScriptRoot');
    expect(sh).toContain('cd -- "$(dirname "$0")"');
    expect(compat).toContain('call "%~dp0start-job-agent.cmd" "--port=%PORT%"');
    expect(compat).not.toMatch(/powershell|src\\index\.js/i);
  });
});
