import { describe, it, expect } from 'vitest';

import {
  answerScreeningQuestion,
  assertTruthfulSponsorship,
  isInvertedSponsorshipQuestion,
} from '../../src/apply/screeningQA.js';
import { buildPrefillPlan } from '../../src/apply/formPrefill.js';

/**
 * Mirrors the shipped config shape: the stored answer states the candidate's
 * REAL need ("Yes, I require sponsorship"). The danger is a question that asks
 * for the opposite.
 */
const SCREENING = {
  defaults: { unknownAction: 'ask_user' },
  answers: [
    {
      id: 'require_sponsorship',
      type: 'text',
      patterns: [
        'require sponsorship', 'need sponsorship', 'visa sponsorship',
        'now or in the future require sponsorship', 'sponsorship to work',
      ],
      answer: 'Yes. I am on an H-1B visa and will need sponsorship to transfer it.',
    },
    {
      id: 'work_authorization',
      type: 'text',
      patterns: ['work authorization', 'authorized to work', 'legally authorized'],
      answer: 'Authorized to work in the US on H-1B; will need the visa transferred with sponsorship.',
    },
  ],
};

const YESNO = ['Yes', 'No'];

describe('inverted sponsorship questions are detected', () => {
  const inverted = [
    'Are you able to work in the US without requiring visa sponsorship?',
    'Will you now or in the future NOT require sponsorship to work in the US?',
    'Are you legally authorized to work in the United States without sponsorship?',
    'Can you work in the US with no visa sponsorship needed?',
    "Do you not require sponsorship?",
    'Are you authorized to work here independent of sponsorship?',
  ];
  for (const q of inverted) {
    it(`flags: ${q}`, () => expect(isInvertedSponsorshipQuestion(q)).toBe(true));
  }

  const direct = [
    'Do you now or in the future require sponsorship to work in the United States?',
    'Do you require visa sponsorship?',
    'Are you legally authorized to work in the United States?',
    // Not a sponsorship question at all — must not be flagged.
    'Do you have a driver license? (If no, choose No)',
    'Are you willing to relocate?',
  ];
  for (const q of direct) {
    it(`does not flag: ${q}`, () => expect(isInvertedSponsorshipQuestion(q)).toBe(false));
  }
});

describe('the matcher refuses to answer an inverted sponsorship question', () => {
  it('defers to the human rather than asserting the opposite of the truth', () => {
    const q = 'Are you able to work in the US without requiring visa sponsorship now or in the future?';
    const r = answerScreeningQuestion(q, SCREENING, { choices: YESNO });
    expect(r.answered).toBe(false);
    expect(r.action).toBe('ask_user');
  });

  it('still answers the DIRECT form truthfully', () => {
    const q = 'Do you now or in the future require sponsorship to work in the United States?';
    const r = answerScreeningQuestion(q, SCREENING, { choices: YESNO });
    expect(r.answered).toBe(true);
    expect(r.answer).toMatch(/^Yes/);
  });

  it('reaches the human even when unknownAction is "skip"', () => {
    // A skipped field is left blank and does NOT block the run. That is fine for
    // a middle name; it is not fine for a factual immigration question.
    const skipping = { ...SCREENING, defaults: { unknownAction: 'skip' } };
    const r = answerScreeningQuestion(
      'Can you work in the US without sponsorship?', skipping, { choices: YESNO },
    );
    expect(r.action).toBe('ask_user');
  });

  it('surfaces as needsUser through the prefill planner', () => {
    const { plan, needsUser } = buildPrefillPlan(
      [{ label: 'Are you able to work in the US without visa sponsorship?', selector: '#s', choices: YESNO }],
      { candidate: {}, screeningAnswers: SCREENING },
    );
    expect(plan).toHaveLength(0);
    expect(needsUser).toHaveLength(1);
  });
});

describe('the submit gate catches an affirmative answer to an inverted question', () => {
  it('rejects "Yes" to an inverted question even though the text looks innocent', () => {
    const check = assertTruthfulSponsorship([{
      label: 'Are you able to work in the US without visa sponsorship?',
      answer: 'Yes',
    }]);
    expect(check.truthful).toBe(false);
    expect(check.violations[0]).toMatch(/inverted sponsorship question/i);
  });

  it('accepts "No" to an inverted question (the truthful answer)', () => {
    expect(assertTruthfulSponsorship([{
      label: 'Are you able to work in the US without visa sponsorship?',
      answer: 'No',
    }]).truthful).toBe(true);
  });

  it('accepts "Yes" to the direct question', () => {
    expect(assertTruthfulSponsorship([{
      label: 'Do you require visa sponsorship?',
      answer: 'Yes',
    }]).truthful).toBe(true);
  });

  it('still catches the original forbidden phrases with no label present', () => {
    expect(assertTruthfulSponsorship([
      { answer: 'I do not require sponsorship' },
    ]).truthful).toBe(false);
  });
});

describe('scattered word matching cannot outrank a real phrase match', () => {
  it('does not let stopword-padded patterns hijack an unrelated question', () => {
    // "sponsorship to work" previously scored a perfect 1.0 against any
    // sentence containing those three tokens in any arrangement.
    const r = answerScreeningQuestion(
      'Describe your approach to work you are most proud of.',
      SCREENING,
      {},
    );
    expect(r.answered).toBe(false);
  });
});
