import { describe, it, expect } from 'vitest';
import { applyFreshnessFilter } from '../../src/search/freshnessFilter.js';

const NOW = new Date('2026-06-07T12:00:00.000Z');

/** Build a job posted `daysAgo` days before NOW (or undated when null). */
function job(id, daysAgo) {
  const postedAt = daysAgo === null
    ? null
    : new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return { id, title: `Job ${id}`, postedAt };
}

const baseSettings = {
  jobFreshnessMode: 'LAST_24_HOURS',
  includeLast3DaysFallback: true,
  minResultsBeforeFallback: 10,
  includeUnknownDateJobs: true,
};

describe('applyFreshnessFilter', () => {
  it('keeps only jobs within the 24-hour window (dated)', () => {
    const jobs = [job('a', 0), job('b', 0.5), job('c', 2), job('d', 5)];
    const r = applyFreshnessFilter(jobs, { ...baseSettings, includeLast3DaysFallback: false }, { now: NOW });
    expect(r.kept.map((j) => j.id).sort()).toEqual(['a', 'b']);
    expect(r.fallbackUsed).toBe(false);
    expect(r.effectiveWindowDays).toBe(1);
    expect(r.counts.stale).toBe(2);
  });

  it('widens to a 3-day window when below the fallback threshold', () => {
    // Only 1 job within 24h, but several within 3 days -> fallback kicks in.
    const jobs = [job('a', 0), job('b', 2), job('c', 2.5), job('d', 6)];
    const r = applyFreshnessFilter(jobs, { ...baseSettings, minResultsBeforeFallback: 3 }, { now: NOW });
    expect(r.fallbackUsed).toBe(true);
    expect(r.effectiveWindowDays).toBe(3);
    expect(r.kept.map((j) => j.id).sort()).toEqual(['a', 'b', 'c']);
    expect(r.kept.find((j) => j.id === 'd')).toBeUndefined();
  });

  it('does NOT widen when the strict window already meets the threshold', () => {
    const jobs = [job('a', 0), job('b', 0.2), job('c', 0.9), job('d', 5)];
    const r = applyFreshnessFilter(jobs, { ...baseSettings, minResultsBeforeFallback: 2 }, { now: NOW });
    expect(r.fallbackUsed).toBe(false);
    expect(r.effectiveWindowDays).toBe(1);
    expect(r.kept.map((j) => j.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('routes undated jobs to the review bucket (never kept) when includeUnknownDateJobs is true', () => {
    const jobs = [job('a', 0), job('u', null)];
    const r = applyFreshnessFilter(jobs, baseSettings, { now: NOW });
    expect(r.kept.map((j) => j.id)).toEqual(['a']);
    expect(r.review.map((j) => j.id)).toEqual(['u']);
    expect(r.counts.undatedReview).toBe(1);
  });

  it('drops undated jobs when includeUnknownDateJobs is false', () => {
    const jobs = [job('a', 0), job('u', null)];
    const r = applyFreshnessFilter(jobs, { ...baseSettings, includeUnknownDateJobs: false }, { now: NOW });
    expect(r.kept.map((j) => j.id)).toEqual(['a']);
    expect(r.dropped.map((d) => d.job.id)).toEqual(['u']);
    expect(r.counts.undatedDropped).toBe(1);
  });

  it('ALL mode keeps every dated job regardless of age', () => {
    const jobs = [job('a', 0), job('b', 30), job('c', 400)];
    const r = applyFreshnessFilter(jobs, { ...baseSettings, jobFreshnessMode: 'ALL' }, { now: NOW });
    expect(r.kept).toHaveLength(3);
    expect(r.windowDays).toBe(Infinity);
    expect(r.fallbackUsed).toBe(false);
  });

  it('LAST_7_DAYS does not trigger the 3-day fallback (window already >= 3)', () => {
    const jobs = [job('a', 5)];
    const r = applyFreshnessFilter(jobs, { ...baseSettings, jobFreshnessMode: 'LAST_7_DAYS', minResultsBeforeFallback: 99 }, { now: NOW });
    expect(r.fallbackUsed).toBe(false);
    expect(r.effectiveWindowDays).toBe(7);
    expect(r.kept.map((j) => j.id)).toEqual(['a']);
  });
});
