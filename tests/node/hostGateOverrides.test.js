/**
 * Per-host ceilings, abortable waits, the rolling breaker, and DNS retries.
 *
 * The orchestrator shares ONE host gate across every source, which made a
 * source's own `hostConcurrency` unreachable (Workday's measured 8-per-pod ran
 * at the global 4); a queued waiter or a cooldown sleep could not be cancelled;
 * the breaker reset on any single success, so a pod throttling half of all
 * requests never opened it; and ENOTFOUND burned the full retry curve.
 */
import { describe, it, expect } from 'vitest';

import { createHostGate, RunCancelledError } from '../../src/utils/hostGate.js';
import { withRetry } from '../../src/utils/retryHandler.js';
import { run as runWorkday } from '../../src/search/adapters/workday.js';

const throttle = () => Object.assign(new Error('HTTP 429'), { status: 429 });

async function peakInFlight(gate, url, n) {
  let inFlight = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: n }, () => gate.run(url, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
  })));
  return peak;
}

describe('per-host overrides', () => {
  it('perHost raises one host without changing any other host', async () => {
    const gate = createHostGate({ maxConcurrent: 2, perHost: { 'acme.wd1.myworkdayjobs.com': 6 } });
    expect(await peakInFlight(gate, 'https://other.wd1.myworkdayjobs.com/x', 20)).toBe(6);
    expect(await peakInFlight(gate, 'https://api.lever.co/x', 20)).toBe(2);
  });

  it('configure() applies to a live gate and admits waiters when the ceiling rises', async () => {
    const gate = createHostGate({ maxConcurrent: 1 });
    expect(gate.configure('api.ashbyhq.com', 3)).toBe(3);
    expect(gate.limitFor('https://api.ashbyhq.com/a')).toBe(3);
    expect(await peakInFlight(gate, 'https://api.ashbyhq.com/a', 10)).toBe(3);
    expect(gate.configure('api.ashbyhq.com', 0)).toBeNull();
  });

  it('the Workday adapter configures its pods on the SHARED gate from source.hostConcurrency', async () => {
    const gate = createHostGate({ maxConcurrent: 4 });
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ total: 0, jobPostings: [] }) });
    await runWorkday({
      hostConcurrency: 8,
      tenants: [{ host: 'nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia', site: 'X', searchText: '' }],
    }, { fetchImpl, hostGate: gate, maxRetries: 0 });
    expect(gate.limitFor('https://citi.wd5.myworkdayjobs.com/x')).toBe(8);
    // Hosts the source does not own keep the global ceiling.
    expect(gate.limitFor('https://api.lever.co/x')).toBe(4);
  });
});

describe('abortable waits', () => {
  it('a waiter queued behind a busy host rejects the moment the run is cancelled', async () => {
    const gate = createHostGate({ maxConcurrent: 1 });
    const controller = new AbortController();
    let release;
    const hold = gate.run('https://h.test/a', () => new Promise((r) => { release = r; }));
    const queued = gate.run('https://h.test/b', async () => 'never', { signal: controller.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const err = await queued;
    expect(err).toBeInstanceOf(RunCancelledError);
    release('done');
    await expect(hold).resolves.toBe('done');
    // The slot was not leaked: a fresh call still gets through.
    await expect(gate.run('https://h.test/c', async () => 'ok')).resolves.toBe('ok');
  });

  it('a cooldown sleep is interrupted by cancel instead of being sat out', async () => {
    let resolveSleep;
    const gate = createHostGate({
      maxConcurrent: 2,
      sleepFn: () => new Promise((r) => { resolveSleep = r; }),
    });
    await gate.run('https://h.test/x', async () => { throw throttle(); }).catch(() => {});
    const controller = new AbortController();
    const waiting = gate.run('https://h.test/y', async () => 'never', { signal: controller.signal }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    expect(await waiting).toBeInstanceOf(RunCancelledError);
    resolveSleep?.();
  });
});

describe('rolling breaker', () => {
  it('opens on a host that throttles half of everything, even with successes in between', async () => {
    const gate = createHostGate({ maxConcurrent: 1, breakerThreshold: 4, sleepFn: async () => {} });
    const url = 'https://flaky.test/x';
    for (let i = 0; i < 12; i += 1) {
      // 429, 200, 429, 200 … — the old consecutive-only breaker never opened.
      await gate.run(url, async () => { if (i % 2 === 0) throw throttle(); return 'ok'; }).catch(() => {});
      if (gate.isOpen(url)) break;
    }
    expect(gate.isOpen(url)).toBe(true);
  });

  it('a mostly healthy host with occasional throttles stays closed', async () => {
    const gate = createHostGate({ maxConcurrent: 1, breakerThreshold: 4, sleepFn: async () => {} });
    const url = 'https://healthy.test/x';
    for (let i = 0; i < 30; i += 1) {
      await gate.run(url, async () => { if (i % 5 === 0) throw throttle(); return 'ok'; }).catch(() => {});
    }
    expect(gate.isOpen(url)).toBe(false);
  });
});

describe('DNS failures', () => {
  it('retries ENOTFOUND at most once, however generous maxRetries is', async () => {
    let calls = 0;
    const err = await withRetry(async () => {
      calls += 1;
      // Node's fetch hangs the socket error off `cause`, not `code`.
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }, { maxRetries: 5, sleepFn: async () => {} }).catch((e) => e);
    expect(calls).toBe(2);
    expect(err.attempts).toBe(1);
  });

  it('still retries other transient codes up to maxRetries', async () => {
    let calls = 0;
    await withRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    }, { maxRetries: 3, sleepFn: async () => {} }).catch(() => {});
    expect(calls).toBe(4);
  });
});
