import { describe, it, expect } from 'vitest';

import {
  APP_STATUS, LIFECYCLE_TO_APP_STATUS, deriveAppStatus, fitBucket, gradeFromScore, FIT_LABELS,
  APP_STATUS_LABELS,
} from '../../src/domain/appStatus.js';
import * as dataModule from '../../src/dashboard/data.js';
import { LIFECYCLE_VALUES } from '../../src/lifecycle.js';

describe('domain/appStatus — deriveAppStatus is driven by LIFECYCLE_TO_APP_STATUS', () => {
  it('maps EVERY lifecycle value (exhaustiveness)', () => {
    for (const status of LIFECYCLE_VALUES) {
      expect(LIFECYCLE_TO_APP_STATUS, `lifecycle "${status}" has no board mapping`).toHaveProperty(status);
      expect(Object.values(APP_STATUS)).toContain(LIFECYCLE_TO_APP_STATUS[status]);
    }
  });

  it('never returns a value outside APP_STATUS for any lifecycle value, with or without a score', () => {
    const valid = new Set(Object.values(APP_STATUS));
    for (const status of LIFECYCLE_VALUES) {
      expect(valid.has(deriveAppStatus({ status, score: 70, tier: 'Queue' }))).toBe(true);
      expect(valid.has(deriveAppStatus({ status }))).toBe(true);
    }
  });

  it('hard_discarded reads DISCARDED (it used to fall through to Scored)', () => {
    expect(deriveAppStatus({ status: 'hard_discarded', score: 40, tier: 'Discard' })).toBe(APP_STATUS.DISCARDED);
  });

  it('pipeline verdicts and assist outcomes agree with the map', () => {
    for (const status of ['discarded', 'hard_discarded', 'needs_description', 'unknown_date_review',
      'assist_blocked', 'failed', 'cancelled', 'skipped', 'submit_unverified', 'ready_for_submit']) {
      expect(deriveAppStatus({ status, score: 60, tier: 'Queue' })).toBe(LIFECYCLE_TO_APP_STATUS[status]);
    }
  });

  it('keeps precedence: applied > user decision > assist outcome > approval > shortlist', () => {
    expect(deriveAppStatus({ applied: 1, user_decision: 'rejected', status: 'failed' })).toBe(APP_STATUS.SUBMITTED);
    expect(deriveAppStatus({ user_decision: 'archived', status: 'failed' })).toBe(APP_STATUS.ARCHIVED);
    expect(deriveAppStatus({ status: 'assist_blocked' }, { approval_status: 'approved' })).toBe(APP_STATUS.BLOCKED);
    expect(deriveAppStatus({ status: 'prepared' }, { approval_status: 'approved' })).toBe(APP_STATUS.APPROVED);
    expect(deriveAppStatus({ status: 'discarded', user_decision: 'shortlisted' })).toBe(APP_STATUS.SHORTLISTED);
    // `submitted` without applied=1 cannot claim a submission
    expect(deriveAppStatus({ status: 'submitted', score: 80 })).toBe(APP_STATUS.SCORED);
  });

  it('has a label for every board status', () => {
    for (const s of Object.values(APP_STATUS)) expect(APP_STATUS_LABELS[s]).toBeTruthy();
  });

  it('is re-exported unchanged by the dashboard data layer', () => {
    expect(dataModule.deriveAppStatus).toBe(deriveAppStatus);
    expect(dataModule.APP_STATUS).toBe(APP_STATUS);
    expect(dataModule.fitBucket).toBe(fitBucket);
    expect(dataModule.gradeFromScore).toBe(gradeFromScore);
  });
});

describe('domain/appStatus — grade label and fit chip come from one vocabulary', () => {
  const TIERS = ['Priority', 'Apply', 'Queue', 'Near miss', 'Discard', null];
  const SPONSORSHIP = ['Confirmed', 'Unconfirmed', 'Denied', null];

  it('never shows a grade label that contradicts the fit bucket', () => {
    for (const tier of TIERS) {
      for (const sponsorship of SPONSORSHIP) {
        for (let score = 0; score <= 100; score += 1) {
          const fit = fitBucket(tier, score, sponsorship);
          const grade = gradeFromScore(score, fit);
          if (fit === 'unscored') continue;
          const expected = fit === 'strong' && grade.letter === 'A' ? 'Excellent fit' : FIT_LABELS[fit];
          expect(grade.label, `tier=${tier} score=${score} fit=${fit}`).toBe(expected);
        }
      }
    }
  });

  it('the reported case: a D-band Queue row reads "Possible fit", not "Weak fit"', () => {
    const fit = fitBucket('Queue', 58, 'Unconfirmed');
    expect(fit).toBe('medium');
    expect(gradeFromScore(58, fit)).toEqual({ letter: 'D', label: 'Possible fit', recommend: false });
  });

  it('keeps the score-only labels when no fit is known', () => {
    expect(gradeFromScore(90).label).toBe('Excellent fit');
    expect(gradeFromScore(55).label).toBe('Weak fit');
    expect(gradeFromScore(null)).toBeNull();
  });
});
