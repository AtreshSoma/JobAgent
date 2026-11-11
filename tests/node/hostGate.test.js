/**
 * Host-aware politeness gate.
 *
 * These tests pin the behaviour that a discovery run depends on: limits are
 * enforced by the HOST, so a run must ration itself per host (per Workday POD),
 * obey Retry-After, and stop asking a host that is refusing us instead of
 * multiplying one 429 into hundreds of retries.
 */
import { describe, it, expect } from 'vitest';

import {
  createHostGate, hostKeyFor, HostCircuitOpenError, RunCancelledError,
} from '../../src/utils/hostGate.js';

/** An error shaped like the ones httpError() builds. */
function throttle(status = 429, retryAfterMs = null) {
  return Object.assign(new Error(`HTTP ${status}`), { status, retryAfterMs });
}

describe('hostKeyFor', () => {
  it('collapses Workday tenants onto their shared pod', () => {
    // The 429s in the field were ALL wd5 tenants — the pod is the thing that
    // throttles, so nvidia/citi/target must share one budget.
    expect(hostKeyFor('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/X/jobs')).toBe('wd5.myworkdayjobs.com');
    expect(hostKeyFor('https://citi.wd5.myworkdayjobs.com/wday/cxs/citi/2/jobs')).toBe('wd5.myworkdayjobs.com');
    expect(hostKeyFor('https://tmobile.wd1.myworkdayjobs.com/x')).toBe('wd1.myworkdayjobs.com');
  });

  it('keys everything else on the hostname, and is idempotent', () => {
    expect(hostKeyFor('https://boards-api.greenhouse.io/v1/boards/foo/jobs')).toBe('boards-api.greenhouse.io');
    expect(hostKeyFor('boards-api.greenhouse.io')).toBe('boards-api.greenhouse.io');
  });
});

describe('createHostGate', () => {
  it('never exceeds the per-host ceiling, even under a burst', async () => {
    const gate = createHostGate({ maxConcurrent: 3 });
    let inFlight = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 25 }, () => gate.run('https://api.lever.co/x', async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    })));
    expect(peak).toBe(3);
    expect(inFlight).toBe(0);
  });

  it('counts two boards on the same host against ONE budget', async () => {
    // The old rate limiter keyed on the board token, so N boards each believed
    // they owned the host. This is that regression.
    const gate = createHostGate({ maxConcurrent: 2 });
    let peak = 0;
    let inFlight = 0;
    const hit = (board) => gate.run(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(hit));
    expect(peak).toBe(2);
  });

  it('reserves distinct start times for concurrent callers instead of waking as a burst', async () => {
    const gate = createHostGate({ maxConcurrent: 4 });
    const started = [];
    const zero = Date.now();
    await Promise.all(Array.from({ length: 4 }, () => gate.run(
      'https://nvidia.wd5.myworkdayjobs.com/x',
      async () => { started.push(Date.now() - zero); },
      { minSpacingMs: 20 },
    )));
    started.sort((a, b) => a - b);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(10);
    expect(started[2] - started[1]).toBeGreaterThanOrEqual(10);
    expect(started[3] - started[2]).toBeGreaterThanOrEqual(10);
  });

  it('keeps starts spaced when overdue timers resume after an event-loop stall', async () => {
    const gate = createHostGate({ maxConcurrent: 4 });
    const started = [];
    const zero = Date.now();
    const requests = Promise.all(Array.from({ length: 4 }, () => gate.run(
      'https://nvidia.wd5.myworkdayjobs.com/x',
      async () => { started.push(Date.now() - zero); },
      { minSpacingMs: 20 },
    )));

    // Let the old implementation schedule all nominal timers, then make every
    // timer overdue. It used to wake them as one burst after this stall.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const blockedUntil = Date.now() + 90;
    while (Date.now() < blockedUntil) { /* intentionally block this test's event loop */ }
    await requests;

    started.sort((a, b) => a - b);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(10);
    expect(started[2] - started[1]).toBeGreaterThanOrEqual(10);
    expect(started[3] - started[2]).toBeGreaterThanOrEqual(10);
  });

  it('honors Retry-After for every caller of the host, not just the throttled one', async () => {
    const slept = [];
    const gate = createHostGate({
      maxConcurrent: 1,
      now: () => 0, // frozen clock: the cooldown is whatever we were told to wait
      sleepFn: async (ms) => { slept.push(ms); },
    });
    await expect(gate.run('https://x.test/a', async () => { throw throttle(429, 5000); })).rejects.toThrow();
    // A DIFFERENT request to the same host must wait out the server's window.
    await gate.run('https://x.test/b', async () => 'ok');
    expect(slept).toContain(5000);
  });

  it('opens the circuit after repeated throttles and stops spending requests', async () => {
    const gate = createHostGate({
      maxConcurrent: 1, breakerThreshold: 3, sleepFn: async () => {},
    });
    let calls = 0;
    const hit = () => gate.run('https://nvidia.wd5.myworkdayjobs.com/j', async () => {
      calls += 1;
      throw throttle(429);
    });
    for (let i = 0; i < 3; i += 1) await expect(hit()).rejects.toThrow();
    expect(calls).toBe(3);

    // Breaker is open: further work is refused WITHOUT touching the network,
    // and a tenant on the same pod is refused too.
    expect(gate.isOpen('https://citi.wd5.myworkdayjobs.com/j')).toBe(true);
    await expect(hit()).rejects.toBeInstanceOf(HostCircuitOpenError);
    expect(calls).toBe(3);
  });

  it('a circuit-open error is not retryable — backing off is the point', async () => {
    const err = new HostCircuitOpenError('wd5.myworkdayjobs.com');
    expect(err.retryable).toBe(false);
    expect(err.circuitOpen).toBe(true);
  });

  it('a clean response resets the throttle streak so one blip never trips the breaker', async () => {
    const gate = createHostGate({ maxConcurrent: 1, breakerThreshold: 2, sleepFn: async () => {} });
    const url = 'https://api.ashbyhq.com/x';
    await expect(gate.run(url, async () => { throw throttle(429); })).rejects.toThrow();
    await gate.run(url, async () => 'ok');
    await expect(gate.run(url, async () => { throw throttle(429); })).rejects.toThrow();
    expect(gate.isOpen(url)).toBe(false);
  });

  it('does not throttle on ordinary failures — only on 429/503', async () => {
    const gate = createHostGate({ maxConcurrent: 1, breakerThreshold: 2, sleepFn: async () => {} });
    const url = 'https://api.lever.co/x';
    for (let i = 0; i < 5; i += 1) {
      await expect(gate.run(url, async () => { throw throttle(404); })).rejects.toThrow();
    }
    expect(gate.isOpen(url)).toBe(false);
  });
});

// PERFORMANCE + CANCELLATION.
//
// Cancelling a discovery run used to take ~30 seconds with the UI stuck on
// "Stopping…", matching `requestTimeoutMs` almost exactly. Cancel was
// cooperative polling only (`shouldCancel` checked BETWEEN operations), so a
// request already on the wire ran to completion or to its timeout, and every
// request already queued behind a pod's gate was still dialled. With 200+
// Workday tenants funnelling through a handful of pod gates, that queue is
// hundreds of requests deep.
describe('createHostGate cancellation', () => {
  it('refuses a call outright when the run is already cancelled', async () => {
    const gate = createHostGate({ maxConcurrent: 4, sleepFn: async () => {} });
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(gate.run(
      'https://acme.wd1.myworkdayjobs.com/x',
      async () => { ran = true; return 'ok'; },
      { signal: controller.signal },
    )).rejects.toThrow(RunCancelledError);
    expect(ran, 'the request must never be sent').toBe(false);
  });

  it('drops work still QUEUED behind a busy gate instead of dialling it', async () => {
    // This is the case that made "Stopping…" slow: the gate had a long queue and
    // every waiter still got its turn on the wire.
    const gate = createHostGate({ maxConcurrent: 1, sleepFn: async () => {} });
    const url = 'https://acme.wd1.myworkdayjobs.com/x';
    const controller = new AbortController();

    let releaseFirst;
    const finishFirst = new Promise((resolve) => { releaseFirst = resolve; });
    let announceStarted;
    // `await acquire()` yields a microtask even when a slot is free, so we must
    // wait for the work to be genuinely ON THE WIRE before cancelling —
    // otherwise this would be testing the already-covered "cancelled before it
    // started" path instead of the queue-draining one.
    const firstIsRunning = new Promise((resolve) => { announceStarted = resolve; });
    let sent = 0;

    // Occupy the only slot and hold it.
    const first = gate.run(url, async () => {
      sent += 1;
      announceStarted();
      await finishFirst;
      return 'first';
    }, { signal: controller.signal });
    await firstIsRunning;

    // Queue three more behind it, then cancel before the slot frees.
    const queued = [1, 2, 3].map(() => gate.run(url, async () => {
      sent += 1;
      return 'queued';
    }, { signal: controller.signal }).catch((e) => e));

    controller.abort();
    releaseFirst();

    await expect(first, 'work already on the wire is allowed to finish').resolves.toBe('first');
    const results = await Promise.all(queued);

    expect(results.every((r) => r instanceof RunCancelledError)).toBe(true);
    expect(sent, 'only the already-started request should have been sent').toBe(1);
  });

  it('a cancellation is labelled, non-retryable, and not a host fault', async () => {
    // withRetry must not re-attempt it, and it must not count as a throttle that
    // would trip the breaker or slow down a host that did nothing wrong.
    const gate = createHostGate({ maxConcurrent: 1, breakerThreshold: 1, sleepFn: async () => {} });
    const url = 'https://acme.wd1.myworkdayjobs.com/x';
    const controller = new AbortController();
    controller.abort();
    const err = await gate.run(url, async () => 'never', { signal: controller.signal }).catch((e) => e);
    expect(err.cancelled).toBe(true);
    expect(err.retryable).toBe(false);
    expect(err.code).toBe('RUN_CANCELLED');
    expect(gate.isOpen(url), 'a cancel is not the host throttling us').toBe(false);
  });

  it('is unaffected when no signal is supplied at all', async () => {
    const gate = createHostGate({ maxConcurrent: 2, sleepFn: async () => {} });
    await expect(gate.run('https://x.example.com/a', async () => 'ok')).resolves.toBe('ok');
  });
});
