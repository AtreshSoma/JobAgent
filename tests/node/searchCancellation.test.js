import { describe, it, expect, vi } from 'vitest';

import { runSearch } from '../../src/search/index.js';

describe('discovery cancellation checkpoint', () => {
  it('does not start queued sources after cancellation and reports them distinctly from failures', async () => {
    const fetchImpl = vi.fn(() => { throw new Error('network must not be called after cancellation'); });
    const result = await runSearch({
      jobboards: {
        defaults: { sourceConcurrency: 1 },
        sources: [
          { id: 'gh', adapter: 'greenhouse', enabled: true, priority: 1, boards: ['acme'] },
          { id: 'lever', adapter: 'lever', enabled: true, priority: 2, boards: ['acme'] },
        ],
      },
      ctx: { fetchImpl, shouldCancel: () => true },
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.perSource.every((source) => source.cancelled)).toBe(true);
  });
});
