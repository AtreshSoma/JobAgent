import { describe, it, expect } from 'vitest';
import { compareJobsForQueue, sortJobsForQueue } from '../../src/scoring/jobRanking.js';

const now = new Date('2026-06-20T12:00:00Z');
const fresh = '2026-06-20T06:00:00Z'; // 6h ago -> within 24h
const stale = '2026-06-10T06:00:00Z'; // 10d ago

describe('jobRanking.compareJobsForQueue', () => {
  it('puts last-24h postings ahead of older ones regardless of score', () => {
    const older = { postedAt: stale, sponsorship: 'Confirmed', score: 99, source: 'greenhouse' };
    const newer = { postedAt: fresh, sponsorship: 'Unconfirmed', score: 40, source: 'indeed' };
    const sorted = sortJobsForQueue([older, newer], now);
    expect(sorted[0]).toBe(newer);
  });

  it('breaks 24h ties by sponsorship feasibility', () => {
    const likely = { postedAt: fresh, sponsorship: 'Likely', score: 50, source: 'indeed' };
    const confirmed = { postedAt: fresh, sponsorship: 'Confirmed', score: 50, source: 'indeed' };
    const unconfirmed = { postedAt: fresh, sponsorship: 'Unconfirmed', score: 50, source: 'indeed' };
    const sorted = sortJobsForQueue([unconfirmed, likely, confirmed], now);
    expect(sorted.map((j) => j.sponsorship)).toEqual(['Confirmed', 'Likely', 'Unconfirmed']);
  });

  it('then by score, then by direct-ATS source quality', () => {
    const lowScore = { postedAt: fresh, sponsorship: 'Confirmed', score: 60, source: 'greenhouse' };
    const highScore = { postedAt: fresh, sponsorship: 'Confirmed', score: 80, source: 'indeed' };
    expect(sortJobsForQueue([lowScore, highScore], now)[0]).toBe(highScore);

    const ats = { postedAt: fresh, sponsorship: 'Confirmed', score: 70, source: 'lever' };
    const aggregator = { postedAt: fresh, sponsorship: 'Confirmed', score: 70, source: 'indeed' };
    expect(sortJobsForQueue([aggregator, ats], now)[0]).toBe(ats);
  });

  it('reads either postedAt or posted_at', () => {
    const cmp = compareJobsForQueue(now);
    const camel = { postedAt: fresh, sponsorship: 'Unconfirmed', score: 1, source: 'x' };
    const snake = { posted_at: stale, sponsorship: 'Confirmed', score: 99, source: 'greenhouse' };
    expect(cmp(camel, snake)).toBeLessThan(0); // fresh camel ranks first
  });

  it('is stable for fully-equal jobs', () => {
    const a = { postedAt: fresh, sponsorship: 'Confirmed', score: 70, source: 'lever' };
    const b = { postedAt: fresh, sponsorship: 'Confirmed', score: 70, source: 'lever' };
    expect(compareJobsForQueue(now)(a, b)).toBe(0);
  });
});
