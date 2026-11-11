/**
 * Application profile + question-queue tests.
 *
 * Covers the learning loop end to end against a real temp project root:
 * a run that cannot answer a question puts it in the queue, answering it once
 * writes a validated screening answer, and the filler then answers it by itself.
 *
 * The truthfulness invariants get their own cases: the editor must refuse to
 * store an answer that would misstate work authorization, including the
 * inverted-sponsorship case whose ANSWER text is innocuous and only the
 * QUESTION reveals as false.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PROFILE_FIELDS, readProfile, writeProfile, readScreeningAnswers,
  upsertScreeningAnswer, validateAnswerEntry, validateScreeningAnswers, writeScreeningAnswers,
} from '../../src/config/profileStore.js';
import {
  dismissQuestion, loadQuestionQueue, markQuestionAnswered, questionKey,
  recordUnansweredQuestions, suggestAnswerId, suggestPatterns, summarizeQuestionQueue,
} from '../../src/apply/questionQueue.js';
import { answerScreeningQuestion } from '../../src/apply/screeningQA.js';

const REPO = process.cwd();
const NOW = new Date('2026-08-16T10:00:00Z');

/** A temp project root with the config files the stores expect. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-profile-'));
  mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.example.json'));
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
  copyFileSync(join(REPO, 'config', 'schemas', 'candidate.schema.json'), join(root, 'config', 'schemas', 'candidate.schema.json'));
  copyFileSync(
    join(REPO, 'config', 'screening_answers.example.json'),
    join(root, 'config', 'screening_answers.json'),
  );
  return root;
}

describe('profile store', () => {
  let root;
  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads every field through the same resolver the filler uses', () => {
    const profile = readProfile(root);
    expect(profile.exists).toBe(true);
    expect(profile.fields.map((f) => f.field)).toEqual(PROFILE_FIELDS.map((f) => f.field));
    // The template has a city but no street, so the page must say so.
    expect(profile.fields.find((f) => f.field === 'city').filled).toBe(true);
    expect(profile.fields.find((f) => f.field === 'addressLine1').filled).toBe(false);
  });

  it('saves only the profile fields and leaves the rest of candidate.json intact', () => {
    const before = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
    const result = writeProfile(root, {
      'identity.fullName': 'Ada Lovelace',
      'contact.email': 'ada@example.com',
      'location.street': '12 Analytical Way',
    });
    expect(result.changed).toContain('identity.fullName');

    const after = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
    expect(after.identity.fullName).toBe('Ada Lovelace');
    expect(after.location.street).toBe('12 Analytical Way');
    // Everything tailoring and scoring depend on must survive a profile save.
    expect(after.workHistory).toEqual(before.workHistory);
    expect(after.education).toEqual(before.education);
    expect(after.targetTitles).toEqual(before.targetTitles);
    expect(after.technicalStack).toEqual(before.technicalStack);
  });

  it('refuses a value that would make candidate.json fail to load', () => {
    expect(() => writeProfile(root, { 'contact.email': 'not-an-email' }))
      .toThrow(/would not load/i);
    // The bad value must not have reached disk.
    expect(readProfile(root).fields.find((f) => f.field === 'email').value)
      .toBe('you@example.com');
  });

  it('refuses to write a field the filler cannot use', () => {
    expect(() => writeProfile(root, { 'workHistory.0.employer': 'Nope' }))
      .toThrow(/not an editable profile field/i);
  });

  it('keeps the previous version when saving', () => {
    writeProfile(root, { 'identity.fullName': 'Ada Lovelace' });
    const backup = JSON.parse(readFileSync(join(root, 'config', 'candidate.json.bak'), 'utf8'));
    expect(backup.identity.fullName).toBe('Jane Doe');
  });
});

describe('screening answer validation', () => {
  let root;
  beforeEach(() => { root = makeRoot(); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts the shipped example answers unchanged', () => {
    const current = readScreeningAnswers(root);
    expect(validateScreeningAnswers({ defaults: current.defaults, answers: current.answers }).valid).toBe(true);
  });

  it('rejects an answer that would misstate work authorization', () => {
    // Judged against a candidate who DOES require sponsorship, so "No
    // sponsorship required" is a false claim about them.
    const check = validateAnswerEntry({
      id: 'sponsorship', patterns: ['require sponsorship'], answer: 'No sponsorship required',
    }, { requiresSponsorship: true });
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/contradicts the work authorization in your profile/i);
  });

  it('accepts the SAME answer for a candidate who genuinely needs no sponsorship', () => {
    // The other half of the rule. With one absolute blocklist this was refused,
    // so a US citizen could not save the single most common screening answer
    // there is — and every sponsorship question fell through to manual.
    const check = validateAnswerEntry({
      id: 'sponsorship', patterns: ['require sponsorship'],
      answer: 'No, I do not require sponsorship to work in the United States.',
    }, { requiresSponsorship: false });
    expect(check.valid).toBe(true);
  });

  it('rejects the previous candidate\'s answer after a profile switch', () => {
    // The leak this exists to close: profile says no sponsorship is needed,
    // while an inherited answer still claims an H-1B transfer.
    const check = validateAnswerEntry({
      id: 'sponsorship', patterns: ['require sponsorship'],
      answer: 'Yes, I will require sponsorship (H-1B transfer).',
    }, { requiresSponsorship: false });
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/contradicts/i);
  });

  it('rejects an affirmative answer to a REVERSED sponsorship question', () => {
    // The answer text ("Yes") is innocuous; only the question makes it false.
    const check = validateAnswerEntry(
      { id: 'auth', patterns: ['authorized to work'], answer: 'Yes' },
      { question: 'Are you able to work in the US without sponsorship?' },
    );
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/inverted sponsorship question/i);
  });

  it('rejects a pattern that could never match', () => {
    const check = validateAnswerEntry({
      id: 'x', patterns: ['how many years of experience?'], answer: '10+ years',
    });
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/ends in punctuation/i);
  });

  it('rejects a pattern that is itself a reversed sponsorship question', () => {
    const check = validateAnswerEntry({
      id: 'x', patterns: ['work without sponsorship'], answer: 'No',
    });
    expect(check.valid).toBe(false);
    expect(check.error).toMatch(/reversed sponsorship question/i);
  });

  it('rejects duplicate ids in a whole-document save', () => {
    const doc = {
      defaults: { unknownAction: 'ask_user' },
      answers: [
        { id: 'dup', patterns: ['one thing'], answer: 'a' },
        { id: 'dup', patterns: ['another thing'], answer: 'b' },
      ],
    };
    expect(validateScreeningAnswers(doc).valid).toBe(false);
    expect(() => writeScreeningAnswers(root, doc)).toThrow(/unique/i);
  });

  it('refuses to overwrite an existing id unless asked to', () => {
    expect(() => upsertScreeningAnswer(root, {
      id: 'start_date', patterns: ['when could you begin'], answer: 'Immediately',
    })).toThrow(/already exists/i);
    const replaced = upsertScreeningAnswer(root, {
      id: 'start_date', patterns: ['when could you begin'], answer: 'Immediately',
    }, { replace: true });
    expect(replaced.replaced).toBe(true);
    expect(readScreeningAnswers(root).answers.find((a) => a.id === 'start_date').answer).toBe('Immediately');
  });
});

describe('question queue', () => {
  let root;
  beforeEach(() => { root = makeRoot(); mkdirSync(join(root, 'data'), { recursive: true }); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ask = (label, extra = {}) => ({ label, required: true, kind: 'text', ...extra });

  it('records a question once and counts how often it is asked', () => {
    recordUnansweredQuestions(root, {
      jobId: 'j1', company: 'Acme', title: 'Data Engineer', questions: [ask('How did you hear about us?')], now: NOW,
    });
    recordUnansweredQuestions(root, {
      jobId: 'j2', company: 'Globex', title: 'BI Engineer', questions: [ask('How did you hear about us')], now: NOW,
    });

    const summary = summarizeQuestionQueue(root);
    expect(summary.openCount).toBe(1);
    expect(summary.open[0].seenCount).toBe(2);
    expect(summary.open[0].jobs.map((j) => j.company)).toEqual(['Globex', 'Acme']);
  });

  it('sorts required questions above optional ones', () => {
    recordUnansweredQuestions(root, {
      jobId: 'j1',
      questions: [ask('Middle name', { required: false }), ask('Are you 18 or older?')],
      now: NOW,
    });
    const summary = summarizeQuestionQueue(root);
    expect(summary.open[0].label).toBe('Are you 18 or older?');
    expect(summary.requiredCount).toBe(1);
  });

  it('carries the live form choices through so the answer form can offer them', () => {
    recordUnansweredQuestions(root, {
      jobId: 'j1',
      questions: [ask('Are you 18 or older?', { options: [{ value: 'y', label: 'Yes' }, { value: 'n', label: 'No' }] })],
      now: NOW,
    });
    expect(summarizeQuestionQueue(root).open[0].options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('reopens an answered question that the saved patterns did not match', () => {
    recordUnansweredQuestions(root, { jobId: 'j1', questions: [ask('Do you have a valid drivers license?')], now: NOW });
    const key = questionKey('Do you have a valid drivers license?');
    markQuestionAnswered(root, key, { answerId: 'license', now: NOW });
    expect(summarizeQuestionQueue(root).openCount).toBe(0);

    recordUnansweredQuestions(root, { jobId: 'j2', questions: [ask('Do you have a valid drivers license?')], now: NOW });
    const summary = summarizeQuestionQueue(root);
    expect(summary.openCount).toBe(1);
    expect(summary.open[0].note).toMatch(/did not match/i);
  });

  it('a dismissed question leaves the list but is not re-added as new', () => {
    recordUnansweredQuestions(root, { jobId: 'j1', questions: [ask('Upload a portfolio')], now: NOW });
    dismissQuestion(root, questionKey('Upload a portfolio'), { now: NOW });
    const again = recordUnansweredQuestions(root, { jobId: 'j2', questions: [ask('Upload a portfolio')], now: NOW });
    expect(again.added).toBe(0);
    expect(summarizeQuestionQueue(root).openCount).toBe(0);
    expect(summarizeQuestionQueue(root).resolved).toHaveLength(1);
  });

  it('never overwrites a corrupt queue file', () => {
    writeFileSync(join(root, 'data', 'question_queue.json'), '{ this is not json', 'utf8');
    const result = recordUnansweredQuestions(root, { jobId: 'j1', questions: [ask('Anything')], now: NOW });
    expect(result.added).toBe(0);
    expect(result.error).toMatch(/not valid JSON/i);
    expect(readFileSync(join(root, 'data', 'question_queue.json'), 'utf8')).toBe('{ this is not json');
    expect(loadQuestionQueue(root).error).toBeTruthy();
    expect(summarizeQuestionQueue(root).error).toBeTruthy();
  });

  it('suggests patterns the matcher can actually use', () => {
    const patterns = suggestPatterns('How many years of Python experience do you have?');
    // No trailing punctuation — the matcher wraps patterns in word boundaries.
    for (const p of patterns) expect(p).toMatch(/[a-z0-9]$/);
    expect(patterns[0]).toBe('how many years of python experience do you have');
    // The DISTINCTIVE phrase, not the longest one. "how many years" is the
    // longest run of non-filler words here, and it is exactly the wrong
    // suggestion: it says nothing about the subject and is already claimed by
    // the shipped years_experience entry.
    expect(patterns[1]).toBe('python experience');
    expect(suggestAnswerId('How many years of Python experience do you have?')).toBe('python_experience');
  });

  it('drops interrogatives so the phrase survives a reworded question', () => {
    expect(suggestPatterns('Which Databricks certifications do you currently hold?')[1])
      .toBe('databricks certifications');
    // "us" is a pronoun the matcher already treats as filler, so the suggestion
    // stops at "hear about" — which also covers "…hear about this position?".
    expect(suggestPatterns('How did you hear about us?')[1]).toBe('hear about');
  });
});

describe('the learning loop closes', () => {
  let root;
  beforeEach(() => { root = makeRoot(); mkdirSync(join(root, 'data'), { recursive: true }); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a question the filler could not answer is answered by it after one save', () => {
    // Deliberately NOT a duration question: the shipped answers already cover
    // "how many years", so one would prove nothing about the loop.
    const question = 'Which Databricks certifications do you currently hold?';

    // 1. Before: the matcher has nothing for it, so the runner would stop.
    const before = answerScreeningQuestion(question, readScreeningAnswers(root));
    expect(before.answered).toBe(false);
    expect(before.action).toBe('ask_user');

    // 2. The run queues it.
    recordUnansweredQuestions(root, {
      jobId: 'j1', company: 'Acme', questions: [{ label: question, required: true, kind: 'text' }], now: NOW,
    });
    const queued = summarizeQuestionQueue(root).open[0];
    expect(queued.label).toBe(question);

    // 3. You answer it once, using exactly what the server suggests.
    upsertScreeningAnswer(root, {
      id: suggestAnswerId(question),
      patterns: suggestPatterns(question),
      answer: 'Databricks Certified Data Engineer Associate',
    }, { question });
    markQuestionAnswered(root, queued.key, { answerId: suggestAnswerId(question), now: NOW });

    // 4. After: the filler answers it — and answers a differently-worded
    //    version at another employer too, which is the point of the loop.
    const after = answerScreeningQuestion(question, readScreeningAnswers(root));
    expect(after.answered).toBe(true);
    expect(after.answer).toBe('Databricks Certified Data Engineer Associate');
    const variant = answerScreeningQuestion(
      'Please list any Databricks certifications you hold.', readScreeningAnswers(root),
    );
    expect(variant.answered).toBe(true);
    expect(variant.answer).toBe('Databricks Certified Data Engineer Associate');

    expect(summarizeQuestionQueue(root).openCount).toBe(0);
  });
});
