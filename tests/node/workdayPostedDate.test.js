/**
 * P8 — a relative "Posted N Days Ago" label must yield a STABLE date.
 *
 * It returned now − N days with the current time of day, so every run gave
 * the same unchanged requisition a new posted_at (23,614 rows rewritten per
 * run) and defeated the incremental skip.
 */
import { describe, it, expect } from 'vitest';

import { parseWorkdayPostedOn, postedOnAgrees, mapJob } from '../../src/search/adapters/workday.js';

describe('parseWorkdayPostedOn', () => {
  it('returns a UTC date with no time of day', () => {
    expect(parseWorkdayPostedOn('Posted 5 Days Ago', new Date('2026-07-12T12:34:56Z'))).toBe('2026-07-07');
    expect(parseWorkdayPostedOn('Posted Today', new Date('2026-07-12T23:59:00Z'))).toBe('2026-07-12');
  });

  it('is identical across two runs on the same day', () => {
    const morning = parseWorkdayPostedOn('Posted 3 Days Ago', new Date('2026-07-12T01:00:00Z'));
    const evening = parseWorkdayPostedOn('Posted 3 Days Ago', new Date('2026-07-12T22:00:00Z'));
    expect(morning).toBe(evening);
    const a = mapJob({ title: 'T', externalPath: '/job/X/T_1', postedOn: 'Posted 3 Days Ago' }, { host: 'h', tenant: 't', site: 's' }, { now: new Date('2026-07-12T01:00:00Z') });
    const b = mapJob({ title: 'T', externalPath: '/job/X/T_1', postedOn: 'Posted 3 Days Ago' }, { host: 'h', tenant: 't', site: 's' }, { now: new Date('2026-07-12T22:00:00Z') });
    expect(a.postedAt).toBe(b.postedAt);
  });
});

describe('postedOnAgrees', () => {
  const now = new Date('2026-07-12T12:00:00Z');
  it('accepts a stored date the label still describes', () => {
    expect(postedOnAgrees('Posted 5 Days Ago', '2026-07-07', now)).toBe(true);
    // A day of slack: the label rolls over at the tenant's midnight.
    expect(postedOnAgrees('Posted 6 Days Ago', '2026-07-07T09:00:00.000Z', now)).toBe(true);
    expect(postedOnAgrees('Posted 30+ Days Ago', '2026-05-01', now)).toBe(true);
  });

  it('rejects a stored date the label contradicts', () => {
    expect(postedOnAgrees('Posted Today', '2026-07-01', now)).toBe(false);
    expect(postedOnAgrees('Posted 30+ Days Ago', '2026-07-10', now)).toBe(false);
    expect(postedOnAgrees('', '2026-07-10', now)).toBe(false);
    expect(postedOnAgrees('Posted Today', null, now)).toBe(false);
  });
});
