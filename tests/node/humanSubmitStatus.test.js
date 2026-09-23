import { describe, it, expect } from 'vitest';
import { explainStatus, APP_STATUS } from '../../src/dashboard/data.js';
import { canTransition, LIFECYCLE } from '../../src/lifecycle.js';

// A job lands in submit_unverified two ways: our own click without proof, or
// the human finishing the form in the window the runner left open (the
// hand-off watch saw a confirmation page). The page must not tell the second
// person that "auto-submit clicked Submit" — that never happened.
describe('submit_unverified explanation', () => {
  it('says the human appears to have submitted when the hand-off watch saw a confirmation', () => {
    const text = explainStatus(
      { submitted_confirmation: 'you appear to have submitted it — confirmation page seen' },
      APP_STATUS.SUBMIT_UNVERIFIED,
    );
    expect(text).toMatch(/You appear to have submitted this yourself/);
    expect(text).not.toMatch(/Auto-submit clicked/);
    expect(text).toMatch(/NOT counted as submitted until you confirm/);
  });

  it('keeps the auto-submit wording for our own unverified click', () => {
    const text = explainStatus({ submitted_confirmation: null }, APP_STATUS.SUBMIT_UNVERIFIED);
    expect(text).toMatch(/Auto-submit clicked Submit/);
  });
});

describe('lifecycle: a blocked fill the human finished', () => {
  it('may move assist_blocked -> submit_unverified (hand-off watch), never straight to applied by itself', () => {
    expect(canTransition(LIFECYCLE.ASSIST_BLOCKED, LIFECYCLE.SUBMIT_UNVERIFIED)).toBe(true);
    expect(canTransition(LIFECYCLE.SUBMIT_UNVERIFIED, LIFECYCLE.SUBMITTED)).toBe(true);
  });
});
