import { describe, it, expect } from 'vitest';
import {
  parseDate,
  daysBetween,
  ageInDays,
  isStale,
  dateStamp,
  isWithinLast24Hours,
  formatPostedRelative,
} from '../../src/utils/dates.js';

describe('dates', () => {
  it('parseDate handles strings, Date, and invalid input', () => {
    expect(parseDate('2026-01-01T00:00:00Z')).toBeInstanceOf(Date);
    expect(parseDate(new Date('2026-01-01'))).toBeInstanceOf(Date);
    expect(parseDate('not-a-date')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });

  it('daysBetween computes floored whole days', () => {
    expect(daysBetween('2026-01-11T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(10);
    expect(daysBetween('2026-01-01T00:00:00Z', '2026-01-11T00:00:00Z')).toBe(-10);
    expect(daysBetween('bad', '2026-01-01')).toBeNull();
  });

  it('ageInDays measures posting age against a reference', () => {
    const ref = new Date('2026-01-20T00:00:00Z');
    expect(ageInDays('2026-01-06T00:00:00Z', ref)).toBe(14);
    expect(ageInDays('bad', ref)).toBeNull();
  });

  it('isStale flags postings older than maxDays', () => {
    const ref = new Date('2026-01-20T00:00:00Z');
    expect(isStale('2026-01-01T00:00:00Z', 14, ref)).toBe(true); // 19 days
    expect(isStale('2026-01-10T00:00:00Z', 14, ref)).toBe(false); // 10 days
    // Unknown date is treated as NOT stale.
    expect(isStale('unknown', 14, ref)).toBe(false);
  });

  it('dateStamp produces YYYYMMDD in UTC', () => {
    expect(dateStamp('2026-06-04T12:00:00Z')).toBe('20260604');
  });
});

describe('freshness display helpers', () => {
  const ref = new Date('2026-06-20T12:00:00Z');

  it('isWithinLast24Hours is true for recent or future postings only', () => {
    expect(isWithinLast24Hours('2026-06-20T00:00:00Z', ref)).toBe(true); // 12h ago
    expect(isWithinLast24Hours('2026-06-19T13:00:00Z', ref)).toBe(true); // 23h ago
    expect(isWithinLast24Hours('2026-06-19T11:00:00Z', ref)).toBe(false); // 25h ago
    expect(isWithinLast24Hours('2026-06-21T00:00:00Z', ref)).toBe(true); // future feed timestamp
    expect(isWithinLast24Hours(null, ref)).toBe(false);
    expect(isWithinLast24Hours('not-a-date', ref)).toBe(false);
  });

  it('formatPostedRelative matches the required short formats', () => {
    expect(formatPostedRelative('2026-06-20T01:00:00Z', ref)).toBe('Today'); // < 24h
    expect(formatPostedRelative('2026-06-19T01:00:00Z', ref)).toBe('1d ago');
    expect(formatPostedRelative('2026-06-17T01:00:00Z', ref)).toBe('3d ago');
    expect(formatPostedRelative('2026-06-06T01:00:00Z', ref)).toBe('Jun 6'); // 14d -> month/day
    expect(formatPostedRelative(null, ref)).toBe('Unknown');
    expect(formatPostedRelative('garbage', ref)).toBe('Unknown');
  });
});
