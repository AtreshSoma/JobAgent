/**
 * 2026-11-16 RCA follow-ups.
 *
 * 1. `npm run app` reused a dashboard older than the code on disk, so the
 *    "updated after it started" banner never cleared. It now restarts an idle
 *    stale server it can prove is its own.
 * 2. Cloudflare's firewall pages in front of Workday are named in errors: a
 *    403 is `bot_blocked` (final); a 429 is throttling (retried, waited out).
 */
import { describe, expect, it, vi } from 'vitest';

import { decideRestart, runApp, stopDashboardProcess } from '../../src/cli/app.js';
import { httpError, isFirewallBlock } from '../../src/utils/httpClient.js';
import { classifyFailure, RCA_CATEGORIES } from '../../src/utils/failureRca.js';
import { workdayFetch } from '../../src/search/adapters/workday.js';
import { safeFetch } from '../../src/utils/safeFetch.js';

const STARTED = '2026-11-16T13:10:31.284Z';
const holder = { pid: 4242, port: 4646, startedAt: STARTED };
const found = { url: 'http://127.0.0.1:4646', proven: true };
const newer = () => ({ mtimeMs: Date.parse(STARTED) + 60_000, file: 'resume/resumeProfile.js' });
const older = () => ({ mtimeMs: Date.parse(STARTED) - 60_000, file: 'x.js' });
const status = (running) => vi.fn(async () => ({ ok: true, json: async () => ({ running, phase: null, cancelRequested: false }) }));

describe('decideRestart', () => {
  it('restarts an idle server that is older than the code on disk', async () => {
    const d = await decideRestart({ holder, found, force: false, token: 't' }, { newestServerCode: newer, fetchImpl: status(false) });
    expect(d).toEqual({ restart: true, reason: 'stale' });
  });

  it('never cuts off a run in progress', async () => {
    const d = await decideRestart({ holder, found, force: true, token: 't' }, { newestServerCode: newer, fetchImpl: status(true) });
    expect(d).toEqual({ restart: false, reason: 'busy' });
  });

  it('leaves a current server alone unless --restart is given', async () => {
    const fetchImpl = status(false);
    expect(await decideRestart({ holder, found, force: false, token: 't' }, { newestServerCode: older, fetchImpl }))
      .toEqual({ restart: false, reason: 'current' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await decideRestart({ holder, found, force: true, token: 't' }, { newestServerCode: older, fetchImpl }))
      .toEqual({ restart: true, reason: 'forced' });
  });

  it('never signals a server that did not prove it is ours, or is not in our lock', async () => {
    const deps = { newestServerCode: newer, fetchImpl: status(false) };
    expect((await decideRestart({ holder, found: { ...found, proven: false }, force: true, token: 't' }, deps)).restart).toBe(false);
    expect((await decideRestart({ holder: null, found, force: true, token: 't' }, deps)).restart).toBe(false);
    expect((await decideRestart({ holder: { ...holder, port: 4747 }, found, force: true, token: 't' }, deps)).restart).toBe(false);
  });

  it('does not restart when the run status cannot be read', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNRESET'); });
    expect(await decideRestart({ holder, found, force: false, token: 't' }, { newestServerCode: newer, fetchImpl }))
      .toEqual({ restart: false, reason: 'status-unknown' });
  });
});

describe('stopDashboardProcess', () => {
  it('sends SIGTERM and waits for the process to exit', async () => {
    let alive = true;
    const kill = vi.fn(() => { setTimeout(() => { alive = false; }, 50); });
    expect(await stopDashboardProcess(4242, { kill, alive: () => alive, timeoutMs: 2000 })).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM');
  });

  it('reports failure when the process will not stop', async () => {
    expect(await stopDashboardProcess(4242, { kill: () => {}, alive: () => true, timeoutMs: 200 })).toBe(false);
  });
});

describe('runApp with a stale dashboard running', () => {
  const base = (over = {}) => ({
    loadConfig: () => ({ root: '/nonexistent-root', candidate: {} }),
    readLiveLock: () => holder,
    probeRunningDashboard: async () => found.url,
    openBrowser: vi.fn(() => true),
    ...over,
  });
  const parsed = { flags: new Set(['no-open']), options: {} };

  it('stops the old one and starts fresh', async () => {
    const stop = vi.fn(async () => true);
    const startDashboard = vi.fn(async () => ({ url: found.url, port: 4646, close: async () => {}, runState: {} }));
    const r = await runApp({
      parsed, env: {},
      deps: base({
        decideRestart: async () => ({ restart: true, reason: 'stale' }),
        stopDashboardProcess: stop,
        openDatabase: () => ({ close() {} }),
        JobLogger: class { error() {} },
        createPinoLogger: () => ({ logger: {} }),
        findFreePort: async (p) => p,
        startDashboard,
        writeLock: () => () => {},
        installProcessSafetyNet: () => () => {},
        waitForReady: async () => true,
        shutdownSignal: 'SIGINT',
      }),
    });
    expect(stop).toHaveBeenCalledWith(4242);
    expect(startDashboard).toHaveBeenCalled();
    expect(r.alreadyRunning).toBeUndefined();
  });

  it('reuses the old one while it is busy', async () => {
    const stop = vi.fn();
    const r = await runApp({ parsed, env: {}, deps: base({ decideRestart: async () => ({ restart: false, reason: 'busy' }), stopDashboardProcess: stop }) });
    expect(stop).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, alreadyRunning: true });
  });

  it('gives up cleanly when the old one will not stop', async () => {
    const r = await runApp({
      parsed, env: {},
      deps: base({ decideRestart: async () => ({ restart: true, reason: 'stale' }), stopDashboardProcess: async () => false }),
    });
    expect(r).toMatchObject({ ok: false, alreadyRunning: true });
  });
});

describe('firewall pages are named, and only a 403 is final', () => {
  const res = (status, headers) => ({ status, headers: new Headers(headers) });
  const cf = { server: 'cloudflare', 'content-type': 'text/html; charset=UTF-8' };

  it('recognises Cloudflare\'s instant HTML 429/403', () => {
    expect(isFirewallBlock(res(429, cf))).toBe(true);
    expect(isFirewallBlock(res(403, cf))).toBe(true);
    // The API's own throttle: JSON, or a Retry-After — a real slow-down.
    expect(isFirewallBlock(res(429, { server: 'cloudflare', 'content-type': 'application/json' }))).toBe(false);
    expect(isFirewallBlock(res(429, cf), 30_000)).toBe(false);
    expect(isFirewallBlock(res(404, cf))).toBe(false);
  });

  it('a firewall 403 is bot_blocked, final, and survives being flattened to text', () => {
    const err = httpError(res(403, cf), 'iCIMS', 'https://x.icims.com/jobs');
    expect(err.retryable).toBe(false);
    expect(RCA_CATEGORIES).toContain('bot_blocked');
    expect(classifyFailure(err).category).toBe('bot_blocked');
    expect(classifyFailure(err.message).category).toBe('bot_blocked');
  });

  it('a firewall 429 is throttling: named, but retried and classed as a rate limit', () => {
    const err = httpError(res(429, cf), 'Workday', 'https://x.wd1.myworkdayjobs.com/wday/cxs/x/y/jobs');
    expect(err.retryable).toBe(true);
    expect(err.firewall).toBe(true);
    expect(err.message).toMatch(/site firewall is throttling us/);
    expect(classifyFailure(err).category).toBe('rate_limit');
    expect(classifyFailure(httpError(res(429, { 'content-type': 'application/json' }), 'Workday', 'u')).category).toBe('rate_limit');
  });
});

describe('Workday transport', () => {
  it('defaults to node:https (safeFetch), not the built-in fetch Cloudflare refuses', () => {
    expect(typeof workdayFetch).toBe('function');
    expect(workdayFetch).not.toBe(globalThis.fetch);
    expect(workdayFetch).not.toBe(safeFetch); // its own keep-alive pool
  });
});

describe('host gate: searches wait out an open breaker, descriptions stop', async () => {
  const { createHostGate } = await import('../../src/utils/hostGate.js');
  const throttled = () => Promise.reject(Object.assign(new Error('Workday HTTP 429'), { status: 429 }));
  const makeGate = () => {
    let t = 0;
    const gate = createHostGate({
      breakerThreshold: 2, breakerOpenMs: 1000, baseCooldownMs: 1, maxCooldownMs: 1,
      now: () => t, sleepFn: async (ms) => { t += ms; },
    });
    return { gate, clock: () => t };
  };
  const url = 'https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/ext/job/1';
  const search = 'https://other.wd1.myworkdayjobs.com/wday/cxs/other/ext/jobs';

  async function trip(gate) {
    for (let i = 0; i < 2; i += 1) await gate.run(url, throttled).catch(() => {});
    expect(gate.isOpen(url)).toBe(true);
  }

  it('a plain call still fails fast while the pod is open', async () => {
    const { gate } = makeGate();
    await trip(gate);
    await expect(gate.run(search, async () => 'ok')).rejects.toMatchObject({ circuitOpen: true });
  });

  it('a search waits for the breaker to close, then goes through', async () => {
    const { gate, clock } = makeGate();
    await trip(gate);
    await expect(gate.run(search, async () => 'ok', { waitWhenOpenMs: 5000 })).resolves.toBe('ok');
    expect(clock()).toBeGreaterThanOrEqual(1000);
    expect(gate.snapshot()['wd1.myworkdayjobs.com'].inFlight).toBe(0);
  });

  it('a search gives up once its wait budget is spent', async () => {
    const { gate } = makeGate();
    await trip(gate);
    await expect(gate.run(search, async () => 'ok', { waitWhenOpenMs: 200 })).rejects.toMatchObject({ circuitOpen: true });
  });

  it('descriptions stop on a pod for the rest of the run once it has pushed back', async () => {
    const { gate } = makeGate();
    expect(gate.hasTripped(url)).toBe(false);
    await trip(gate);
    await gate.run(search, async () => 'ok', { waitWhenOpenMs: 5000 }); // breaker closed again
    expect(gate.isOpen(url)).toBe(false);
    expect(gate.hasTripped(url)).toBe(true);
    await expect(gate.run(url, async () => 'ok', { skipIfTripped: true })).rejects.toMatchObject({ circuitOpen: true });
    expect(gate.snapshot()['wd1.myworkdayjobs.com'].trips).toBe(1);
  });
});
