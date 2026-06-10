import { describe, it, expect, vi } from 'vitest';
import { createRateLimiter, jitter, sleep } from '../../src/utils/rateLimiter.js';

describe('rateLimiter', () => {
  it('jitter stays within +/- ratio bounds', () => {
    const lo = jitter(1000, 0.2, () => 0); // min: 1000 - 200
    const hi = jitter(1000, 0.2, () => 1); // max: 1000 + 200
    expect(lo).toBe(800);
    expect(hi).toBe(1200);
  });

  it('does not wait on the first call for a key', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    let t = 0;
    const limiter = createRateLimiter({
      minIntervalMs: 3000,
      jitterRatio: 0,
      now: () => t,
      sleepFn,
    });
    const waited = await limiter.wait('dice');
    expect(waited).toBe(0);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('waits the remaining interval on a too-soon second call', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    let t = 0;
    const limiter = createRateLimiter({
      minIntervalMs: 3000,
      jitterRatio: 0,
      now: () => t,
      sleepFn,
    });
    await limiter.wait('dice'); // records t=0
    t = 1000; // only 1s elapsed
    const waited = await limiter.wait('dice');
    expect(waited).toBe(2000);
    expect(sleepFn).toHaveBeenCalledWith(2000);
  });

  it('tracks keys independently', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    let t = 0;
    const limiter = createRateLimiter({
      minIntervalMs: 3000,
      jitterRatio: 0,
      now: () => t,
      sleepFn,
    });
    await limiter.wait('dice');
    const waited = await limiter.wait('linkedin'); // different key, no wait
    expect(waited).toBe(0);
  });

  it('sleep resolves', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});
