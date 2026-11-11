import { describe, it, expect } from 'vitest';
import { mapSettled, mapWithConcurrency } from '../../src/utils/concurrency.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('mapSettled', () => {
  it('preserves input order regardless of completion order', async () => {
    const items = [30, 10, 20, 0];
    const results = await mapSettled(items, 4, async (n) => {
      await tick(n);
      return n;
    });
    expect(results.map((r) => r.value)).toEqual([30, 10, 20, 0]);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('never exceeds the concurrency ceiling', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await mapSettled(items, 3, async (i) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(5);
      inFlight -= 1;
      return i;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1); // actually ran in parallel
  });

  it('isolates a failing item without aborting the batch', async () => {
    const results = await mapSettled([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n * 10;
    });
    expect(results[0]).toEqual({ ok: true, value: 10 });
    expect(results[1].ok).toBe(false);
    expect(results[1].error.message).toBe('boom');
    expect(results[2]).toEqual({ ok: true, value: 30 });
  });

  it('returns [] for empty input and clamps limit to >= 1', async () => {
    expect(await mapSettled([], 5, async () => 1)).toEqual([]);
    const r = await mapSettled([1, 2], 0, async (n) => n);
    expect(r.map((x) => x.value)).toEqual([1, 2]);
  });
});

describe('mapWithConcurrency', () => {
  it('returns mapper values in input order', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6]);
  });
});
