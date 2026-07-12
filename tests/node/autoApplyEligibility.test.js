import { describe, it, expect } from 'vitest';

import {
  evaluateAutoApplyEligibility, evaluateAutoApplyBatch,
  FIXTURE_VERIFIED_AUTO_APPLY_ATS,
} from '../../src/apply/autoApplyEligibility.js';

function eligible(overrides = {}) {
  return {
    job: {
      id: 'j1', company: 'Acme', title: 'Data Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1',
      source: 'greenhouse', sponsorship: 'Confirmed', status: 'prepared', applied: 0,
      ...overrides.job,
    },
    approval: { approval_status: 'pending_review' },
    packet: overrides.packet === null ? null : {
      id: 'p1', ats: { platform: 'greenhouse' }, blockers: [],
      resumePath: '/safe/tailored.docx', resumeWarning: null,
      prefill: { needsUser: [] }, screeningPlan: { needsUser: [] },
      uploads: { blockers: [] },
      ...(overrides.packet ?? {}),
    },
    autoSubmitAuthorized: overrides.autoSubmitAuthorized ?? true,
  };
}

describe('Auto-Apply eligibility', () => {
  it('allows a reviewed, fixture-supported, sponsorship-safe packet', () => {
    const result = evaluateAutoApplyEligibility(eligible());
    expect(result.eligible).toBe(true);
    expect(result.ats).toBe('greenhouse');
    expect(result.warnings.join(' ')).toMatch(/approve this reviewed packet/);
  });

  it.each([
    ['already applied', { job: { applied: 1, status: 'submitted' } }, /duplicate/],
    ['submit unverified', { job: { status: 'submit_unverified' } }, /duplicate/],
    ['rejected', { job: { user_decision: 'rejected' } }, /rejected/],
    ['sponsorship unknown', { job: { sponsorship: 'Unconfirmed' } }, /verify compatibility/],
    ['unknown ATS', { job: { source: 'apify' }, packet: { ats: { platform: 'unknown' } } }, /supported contract/],
    ['missing packet', { packet: null }, /Prepare the application first/],
    ['missing resume', { packet: { resumePath: null } }, /does not contain a resume/],
    ['unanswered required question', { packet: { screeningPlan: { needsUser: [{ label: 'Salary expectation' }] } } }, /Salary expectation/],
    ['upload blocker', { packet: { uploads: { blockers: ['resume input missing'] } } }, /resume input missing/],
  ])('blocks %s before a browser opens', (_name, override, expected) => {
    const result = evaluateAutoApplyEligibility(eligible(override));
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(expected);
  });

  it('keeps explicit per-run authorization visible without hiding otherwise eligible jobs', () => {
    const result = evaluateAutoApplyEligibility(eligible({ autoSubmitAuthorized: false }));
    expect(result.eligible).toBe(true);
    expect(result.autoSubmitAuthorized).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/explicitly enable/);
  });

  it('summarizes a mixed batch and publishes the fixture-tested ATS list', () => {
    const preview = evaluateAutoApplyBatch({
      autoSubmitAuthorized: true,
      items: [eligible(), eligible({ job: { id: 'j2', sponsorship: 'Unconfirmed' } })],
    });
    expect(preview).toMatchObject({ total: 2, eligible: 1, ineligible: 1 });
    expect(FIXTURE_VERIFIED_AUTO_APPLY_ATS).toEqual(expect.arrayContaining([
      'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'generic',
    ]));
  });
});
