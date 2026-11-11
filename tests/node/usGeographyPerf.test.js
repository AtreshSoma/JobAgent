import { describe, it, expect } from 'vitest';

import {
  usLocationSignal, matchUsState, matchUsNational, usLocationCacheSize,
} from '../../src/utils/usGeography.js';

/** The pre-optimisation whole-token matcher, kept as the reference. */
function referenceHasToken(text, term) {
  return new RegExp(`(^| )${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(text);
}
const loose = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

describe('usGeography — regex-free token match and memoized signal', () => {
  const SAMPLES = [
    'Dublin, OH', 'Remote - US', 'U.S.A.', 'New York, NY', 'Washington, D.C.', 'Berlin, DE',
    'Toronto, CA', 'Anywhere in the US', 'Kansas City', 'Arkansas', 'West Virginia', 'Virginia Beach, VA',
    'IN-KA-BANGALORE', 'united states of america', 'lower 48', 'usa-remote', '', null, 'Guam',
  ];

  it('agrees with the reference regex matcher on national markers and state names', () => {
    for (const s of SAMPLES) {
      const text = loose(s);
      const refNational = ['united states', 'united states of america', 'usa', 'u s a', 'u s',
        'us based', 'us only', 'us remote', 'remote us', 'anywhere in the us',
        'nationwide', 'continental us', 'lower 48', 'conus'].find((m) => text && referenceHasToken(text, m)) ?? null;
      expect(matchUsNational(s), String(s)).toBe(refNational);
    }
    expect(matchUsState('Arkansas').code).toBe('AR');
    expect(matchUsState('Kansas City').code).toBe('KS');
    expect(matchUsState('West Virginia').code).toBe('WV');
  });

  it('returns the same frozen object for a repeated location, bounded in size', () => {
    const a = usLocationSignal('Austin, TX');
    const b = usLocationSignal('Austin, TX');
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a).toMatchObject({ isUs: true, state: 'TX', strength: 'abbreviation' });
    for (let i = 0; i < 25_000; i += 1) usLocationSignal(`Town ${i}, TX`);
    expect(usLocationCacheSize()).toBeLessThanOrEqual(20_000);
  });
});
