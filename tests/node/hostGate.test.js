/**
 * Host-aware politeness gate.
 *
 * These tests pin the behaviour that a discovery run depends on: limits are
 * enforced by the HOST, so a run must ration itself per host (per Workday POD),
 * obey Retry-After, and stop asking a host that is refusing us instead of
 * multiplying one 429 into hundreds of retries.
 */
import { describe, it, expect } from 'vitest';

import { createHostGate, hostKeyFor, HostCircuitOpenError } from '../../src/utils/hostGate.js';

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
