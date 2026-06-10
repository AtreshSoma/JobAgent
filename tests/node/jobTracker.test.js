import { describe, it, expect } from 'vitest';

import { submitStatus } from '../../src/reports/jobTracker.js';

describe('submitStatus', () => {
  it('shows Submitted once a job is marked applied', () => {
    expect(submitStatus({ applied: 1 }, null)).toBe('Submitted');
    // Applied wins even if the status still says skipped/ready.
    expect(submitStatus({ applied: 1, status: 'skipped' }, null)).toBe('Submitted');
  });

  it('shows Skipped by you when the user skipped it', () => {
    expect(submitStatus({ status: 'skipped' }, null)).toBe('Skipped by you');
  });

  it('shows a filled-but-not-submitted state', () => {
    expect(submitStatus({ status: 'ready_for_submit' }, null)).toBe('Filled — ready to submit');
    expect(submitStatus({ status: 'assist_blocked' }, null))
      .toBe('Filled — needs you (login/extra fields)');
  });

  it('falls back to approval and pipeline states', () => {
    expect(submitStatus({}, { approval_status: 'approved' })).toBe('Approved — not yet submitted');
    expect(submitStatus({}, { approval_status: 'rejected' })).toBe('Rejected by you');
    expect(submitStatus({ application_packet_path: '/x' }, null))
      .toBe('Prepared — awaiting your approval');
    expect(submitStatus({ score: 80 }, null)).toBe('Scored');
    expect(submitStatus({}, null)).toBe('Found');
  });
});
