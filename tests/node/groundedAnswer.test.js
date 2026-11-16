/**
 * Grounded draft answers to free-text questions (audit A4).
 *
 * "Why do you want to work here?" has no saved answer by design, so each one
 * was typed by hand. The optional model can now DRAFT one from the master
 * resume and the posting, citing the resume lines it used. The draft goes
 * through the same claim verifier as a cover letter, and then waits: the person
 * edits and approves it, per answer, for THAT job only.
 *
 * What must hold: an unbacked claim is dropped; nothing is drafted for
 * sensitive, eligibility, pay or skill-years questions; the model is never sent
 * the person's name or contact lines; an approved answer is used for the one job
 * it was approved for, never another; and nothing is ever submitted by this.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { draftGroundedAnswer, draftRefusal } from '../../src/apply/groundedAnswer.js';
import { approveAnswer, readApprovedAnswers, removeApprovedAnswer, withApprovedAnswers } from '../../src/apply/approvedAnswers.js';
import { answerScreeningQuestion } from '../../src/apply/screeningQA.js';

const ROLE = 'Data Engineer, Contoso | 2021 - Present';
const UNITS = [
  { id: 'u1', kind: 'bullet', role: ROLE, text: 'Built medallion pipelines on Azure Databricks with PySpark, cutting load time by 40%.' },
  { id: 'u2', kind: 'bullet', role: ROLE, text: 'Developed Power BI semantic models for 12 finance teams.' },
  { id: 'u0', kind: 'paragraph', text: 'Dana Okafor | dana@example.test | 555-0100' },
];
const ENV = { LLM_ASSIST: 'on', NVIDIA_API_KEY: 'k' };
const job = { id: 'j1', company: 'Globex', title: 'Senior Data Engineer' };
const config = { root: null, candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.test', phone: '555-0100' } }, scoring: {} };

function model(answer, seen = []) {
  return {
    readMasterUnitsFn: async () => UNITS,
    fetchImpl: async (_url, init) => {
      seen.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
    },
  };
}
const Q = 'Why do you want to work at this company?';

describe('draftRefusal', () => {
  it.each([
    'Do you require visa sponsorship?',
    'Are you legally authorized to work in the United States?',
    'What are your salary expectations?',
    'How many years of experience do you have with Python?',
    'Have you ever been convicted of a felony?',
    'What is your gender?',
    'Do you have a disability?',
  ])('is refused for: %s', (q) => {
    expect(draftRefusal(q)).toMatch(/\w/);
  });
  it('allows an open question', () => {
    expect(draftRefusal(Q)).toBeNull();
    expect(draftRefusal('Describe a project you are proud of.')).toBeNull();
  });
});

describe('draftGroundedAnswer', () => {
  it('returns a draft whose every claim comes from the cited lines', async () => {
    const r = await draftGroundedAnswer({ job, question: Q, config, env: ENV, deps: model({
      text: 'At Contoso I built Azure Databricks medallion pipelines in PySpark that cut load time by 40%, the kind of data platform work the Senior Data Engineer role at Globex needs.',
      evidence: ['u1'],
    }) });
    expect(r.ok).toBe(true);
    expect(r.evidence.map((e) => e.id)).toEqual(['u1']);
    expect(r.evidence[0].text).toMatch(/medallion/);
    expect(r.provenance.task).toMatch(/^free-text-answer@/);
  });

  it('drops a draft that claims something the resume does not', async () => {
    const r = await draftGroundedAnswer({ job, question: Q, config, env: ENV, deps: model({
      text: 'I led a Kafka streaming platform serving 50 million events a day at Contoso.', evidence: ['u1'],
    }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not backed|Kafka|50/i);
  });

  it('drops a draft that cites nothing', async () => {
    const r = await draftGroundedAnswer({ job, question: Q, config, env: ENV, deps: model({ text: 'I am passionate about data.', evidence: [] }) });
    expect(r.ok).toBe(false);
  });

  it('never calls the model for a refused question', async () => {
    const seen = [];
    const r = await draftGroundedAnswer({ job, question: 'Do you require visa sponsorship?', config, env: ENV, deps: model({ text: 'x', evidence: ['u1'] }, seen) });
    expect(r.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('does not send the name or contact lines to the model', async () => {
    const seen = [];
    await draftGroundedAnswer({ job, question: Q, config, env: ENV, deps: model({ text: 'Built pipelines.', evidence: ['u1'] }, seen) });
    const sent = JSON.stringify(seen);
    for (const secret of ['Dana', 'Okafor', 'dana@example.test', '555-0100']) expect(sent).not.toContain(secret);
  });

  it('is unavailable, with the reason, when the model is off', async () => {
    const r = await draftGroundedAnswer({ job, question: Q, config, env: {}, deps: model({ text: 'x', evidence: ['u1'] }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/LLM assist/i);
  });
});

describe('approved answers', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jobagent-approved-')); mkdirSync(join(root, 'data'), { recursive: true }); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('are kept for the one job they were approved for', () => {
    approveAnswer(root, 'j1', { question: Q, text: 'I built pipelines at Contoso.', evidence: ['u1'], source: 'draft' });
    expect(readApprovedAnswers(root, 'j1')).toHaveLength(1);
    expect(readApprovedAnswers(root, 'j2')).toEqual([]);
  });

  it('answer that exact question on that job, and no other question', () => {
    approveAnswer(root, 'j1', { question: Q, text: 'I built pipelines at Contoso.', source: 'draft' });
    const answers = withApprovedAnswers({ answers: [] }, readApprovedAnswers(root, 'j1'));
    expect(answerScreeningQuestion(Q, answers)).toMatchObject({ answered: true, answer: 'I built pipelines at Contoso.' });
    expect(answerScreeningQuestion('Why are you leaving your current role?', answers).answered).toBe(false);
    expect(answerScreeningQuestion(Q, withApprovedAnswers({ answers: [] }, readApprovedAnswers(root, 'j2'))).answered).toBe(false);
  });

  it('can be taken back', () => {
    approveAnswer(root, 'j1', { question: Q, text: 'x', source: 'written' });
    removeApprovedAnswer(root, 'j1', Q);
    expect(readApprovedAnswers(root, 'j1')).toEqual([]);
  });

  it('refuse an empty answer and a sensitive question even when typed by hand', () => {
    expect(() => approveAnswer(root, 'j1', { question: Q, text: '   ' })).toThrow(/empty/i);
    expect(() => approveAnswer(root, 'j1', { question: 'Do you require visa sponsorship?', text: 'No' })).toThrow(/screening answers/i);
  });
});
