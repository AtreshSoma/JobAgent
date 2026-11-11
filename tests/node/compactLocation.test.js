import { describe, it, expect } from 'vitest';

// compactLocation lives in format.js, a DOM-free module, so it runs under node.
describe('compactLocation (job detail header)', async () => {
  const { compactLocation } = await import('../../src/dashboard/public/assets/js/format.js');
  it('keeps short locations as they are', () => {
    expect(compactLocation('Remote, US')).toBe('Remote, US');
    expect(compactLocation('')).toBe('');
  });
  it('summarises long multi-site lists instead of printing all of them', () => {
    const many = Array.from({ length: 30 }, (_, i) => `S${i}, Working at Home - State ${i}`).join('; ');
    expect(compactLocation(many)).toBe('S0, Working at Home - State 0; S1, Working at Home - State 1 + 28 more');
  });
  it('truncates one very long site with an ellipsis', () => {
    const out = compactLocation('x'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out.endsWith('…')).toBe(true);
  });
});
