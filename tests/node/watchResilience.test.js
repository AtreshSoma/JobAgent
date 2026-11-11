/**
 * Watch must survive a bad cycle, give up on a broken one, and let a second
 * Ctrl+C quit immediately. A single throw used to escape the loop and end an
 * overnight watch without a word.
 */
import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  runWatch, createWatchStopSignal, backoffMs, DEFAULT_MAX_CONSECUTIVE_FAILURES,
} from '../../src/cli/watch.js';
import { createDesktopSink } from '../../src/utils/notifier.js';

const db = { getKnownJobIds: () => new Set() };
const config = { runtime: {}, jobboards: { sources: [] } };
const ok = (queued = []) => ({ queued, counters: { jobs_found: queued.length } });

describe('a throwing watch cycle', () => {
  it('is caught, logged, and the watch carries on to the next cycle', async () => {
    const logger = { error: vi.fn() };
    const runPrepareAppsFn = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(ok([{ id: 'j1', company: 'Acme', title: 'DE', score: 90 }]))
      .mockResolvedValue(ok());
    const sleep = vi.fn(async () => {});
    const r = await runWatch({
      config, db, logger, options: { intervalMinutes: 20 },
      deps: { runPrepareAppsFn, sleep, maxCycles: 3, silent: true },
    });
    expect(r).toMatchObject({ cycles: 3, totalNew: 1, failed: false, consecutiveFailures: 0 });
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/cycle 1 failed: network down/), expect.any(Object));
  });

  it('backs off exponentially between consecutive failures, capped at the interval', async () => {
    const waits = [];
    const runPrepareAppsFn = vi.fn(async () => { throw new Error('boom'); });
    // interruptibleSleep slices waits into <=1 s calls; sum them per cycle.
    let current = 0;
    const sleep = vi.fn(async (ms) => { current += ms; });
    const cyclesSeen = [];
    const wrapped = vi.fn(async (...a) => {
      if (cyclesSeen.length) waits.push(current);
      current = 0;
      cyclesSeen.push(1);
      return runPrepareAppsFn(...a);
    });
    const r = await runWatch({
      config, db, logger: null,
      options: { intervalMinutes: 5, maxConsecutiveFailures: 4 },
      deps: { runPrepareAppsFn: wrapped, sleep, silent: true, retryBaseMs: 2000 },
    });
    expect(r.failed).toBe(true);
    expect(r.cycles).toBe(4);
    expect(waits).toEqual([2000, 4000, 8000]);
    expect(backoffMs(20, 5 * 60_000)).toBe(5 * 60_000);
  });

  it(`gives up after ${DEFAULT_MAX_CONSECUTIVE_FAILURES} consecutive failures by default`, async () => {
    const runPrepareAppsFn = vi.fn(async () => { throw new Error('still broken'); });
    const r = await runWatch({
      config, db, logger: null, options: { intervalMinutes: 20 },
      deps: { runPrepareAppsFn, sleep: async () => {}, silent: true },
    });
    expect(r).toMatchObject({ failed: true, cycles: DEFAULT_MAX_CONSECUTIVE_FAILURES, lastError: 'still broken' });
  });

  it('--once fails on its first error instead of retrying', async () => {
    const runPrepareAppsFn = vi.fn(async () => { throw new Error('nope'); });
    const r = await runWatch({
      config, db, logger: null, options: { once: true },
      deps: { runPrepareAppsFn, sleep: async () => {}, silent: true },
    });
    expect(r).toMatchObject({ failed: true, cycles: 1 });
  });
});

describe('Ctrl+C', () => {
  it('first signal requests a stop, second exits 130', () => {
    const proc = new EventEmitter();
    const exit = vi.fn();
    const onFirst = vi.fn();
    const s = createWatchStopSignal({ proc, exit, onFirst });
    expect(s.shouldStop()).toBe(false);
    proc.emit('SIGINT');
    expect(s.shouldStop()).toBe(true);
    expect(onFirst).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    proc.emit('SIGINT');
    expect(exit).toHaveBeenCalledWith(130);
    s.dispose();
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('new-match notifications', () => {
  it('notify a cycle with new matches through the injected notifier', async () => {
    const notifier = { actionRequired: vi.fn(async () => {}) };
    await runWatch({
      config, db, logger: null, options: { once: true },
      deps: {
        runPrepareAppsFn: async () => ok([{ id: 'a', company: 'Acme', title: 'DE' }, { id: 'b', company: 'Globex', title: 'DE' }]),
        silent: true, notifier,
      },
    });
    expect(notifier.actionRequired).toHaveBeenCalledWith('Job Agent: 2 new matches', 'Acme — DE (+1 more)', { count: 2 });
  });

  it('a failing notifier never fails the cycle', async () => {
    const notifier = { actionRequired: vi.fn(async () => { throw new Error('dbus gone'); }) };
    const r = await runWatch({
      config, db, logger: null, options: { once: true },
      deps: { runPrepareAppsFn: async () => ok([{ id: 'a' }]), silent: true, notifier },
    });
    expect(r.failed).toBe(false);
  });

  it('desktop sink passes text as argv (no shell) and falls back when the binary is missing', () => {
    const child = new EventEmitter();
    child.unref = vi.fn();
    const spawnImpl = vi.fn(() => child);
    const fallback = vi.fn();
    const sink = createDesktopSink({ platform: 'linux', spawnImpl, fallback });
    const event = { level: 'action_required', title: 'T "x"; rm -rf /', message: 'M', at: 'now' };
    sink(event);
    expect(spawnImpl).toHaveBeenCalledWith('notify-send', ['--app-name=Job Agent', '--', 'T "x"; rm -rf /', 'M'], expect.any(Object));
    child.emit('error', new Error('ENOENT'));
    expect(fallback).toHaveBeenCalledWith(event);
  });

  it('desktop sink uses the terminal fallback on Windows', () => {
    const spawnImpl = vi.fn();
    const fallback = vi.fn();
    createDesktopSink({ platform: 'win32', spawnImpl, fallback })({ title: 't', message: 'm' });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });
});
