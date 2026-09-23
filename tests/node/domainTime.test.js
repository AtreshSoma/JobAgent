import { describe, it, expect } from 'vitest';

import { candidateTimeZone, dayOf, localDayWindow } from '../../src/domain/time.js';

describe('domain/time — the candidate\'s local day', () => {
  it('reads the zone from the candidate profile', () => {
    expect(candidateTimeZone({ candidate: { location: { timezone: ' America/New_York ' } } })).toBe('America/New_York');
    expect(candidateTimeZone({})).toBeNull();
  });

  it('dayOf uses the local calendar day, falling back to UTC slicing', () => {
    expect(dayOf('2026-09-23T01:30:00.000Z', 'America/New_York')).toBe('2026-09-22');
    expect(dayOf('2026-09-23T01:30:00.000Z', null)).toBe('2026-09-23');
    expect(dayOf('2026-09-23T01:30:00.000Z', 'Not/AZone')).toBe('2026-09-23');
    expect(dayOf('', 'America/New_York')).toBe('');
  });

  it('an evening in New York is still the same local day (the UTC-day cap reset at 8 pm)', () => {
    const w = localDayWindow(new Date('2026-09-23T01:30:00.000Z'), 'America/New_York');
    expect(w).toEqual({ day: '2026-09-22', start: '2026-09-22T04:00:00.000Z', end: '2026-09-23T04:00:00.000Z' });
  });

  it('handles the DST fall-back day (a 25-hour local day)', () => {
    const w = localDayWindow(new Date('2026-11-01T12:00:00.000Z'), 'America/New_York');
    expect(w.start).toBe('2026-11-01T04:00:00.000Z');
    expect(w.end).toBe('2026-11-02T05:00:00.000Z');
  });

  it('handles zones ahead of UTC and the UTC fallback', () => {
    expect(localDayWindow(new Date('2026-09-22T20:00:00.000Z'), 'Asia/Kolkata'))
      .toEqual({ day: '2026-09-23', start: '2026-09-22T18:30:00.000Z', end: '2026-09-23T18:30:00.000Z' });
    expect(localDayWindow(new Date('2026-09-22T20:00:00.000Z'), null))
      .toEqual({ day: '2026-09-22', start: '2026-09-22T00:00:00.000Z', end: '2026-09-23T00:00:00.000Z' });
  });
});
