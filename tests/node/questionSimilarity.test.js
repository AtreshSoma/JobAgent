/**
 * "Same as this earlier question?" (audit A5).
 *
 * A saved answer matches by pattern, so the same question worded differently by
 * another employer is asked again. When a new question closely resembles one
 * the person already answered, the profile page offers it: "same as 'X'?". One
 * confirmation adds the new wording to that answer. Nothing is applied
 * automatically.
 *
 * The risk is a near-miss that means something else, so the check is strict and
 * sensitive topics keep exact matching only: sponsorship and work
 * authorization, pay, years of experience with a named skill, anything about
 * history, health, age or demographics, another country, and questions that
 * depend on the employer. A question that differs in a number or a negation is
 * not the same question.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { similarAnswered } from '../../src/apply/questionSimilarity.js';
import { markQuestionAnswered, recordUnansweredQuestions } from '../../src/apply/questionQueue.js';
import { upsertScreeningAnswer } from '../../src/config/profileStore.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { openDatabase } from '../../src/logging/db.js';
import { buildTestRoot } from './globalSetup.js';

const answered = (label, id = 'onsite') => [{ label, answeredWith: id, status: 'answered' }];

describe('similarAnswered', () => {
  it('finds the same question in other words', () => {
    const hit = similarAnswered('Are you willing to work onsite in our office?', answered('Are you willing to work onsite in the office?'));
    expect(hit).toMatchObject({ answerId: 'onsite', label: 'Are you willing to work onsite in the office?' });
    expect(hit.score).toBeGreaterThanOrEqual(0.75);
  });

  it('ignores case, punctuation and filler', () => {
    expect(similarAnswered('ARE YOU WILLING TO WORK ONSITE IN THE OFFICE', answered('Are you willing to work onsite in the office?'))).not.toBeNull();
  });

  it('does not match a different question that shares words', () => {
    expect(similarAnswered('Are you willing to work nights?', answered('Are you willing to work weekends?'))).toBeNull();
    expect(similarAnswered('Are you willing to travel 25% of the time?', answered('Are you willing to travel 50% of the time?'))).toBeNull();
  });

  it('does not treat a negated question as the same', () => {
    expect(similarAnswered('Are you unwilling to work onsite in the office?', answered('Are you willing to work onsite in the office?'))).toBeNull();
    expect(similarAnswered('Would you not be willing to work onsite in the office?', answered('Are you willing to work onsite in the office?'))).toBeNull();
  });

  it.each([
    ['sponsorship', 'Will you now or in the future require visa sponsorship?', 'Do you now or in the future require visa sponsorship?'],
    ['work authorization', 'Are you legally authorized to work in the United States?', 'Are you authorized to work in the United States legally?'],
    ['pay', 'What are your salary expectations per year?', 'What salary do you expect per year?'],
    ['a named skill', 'How many years of experience do you have with Python?', 'How many years of experience do you have using Python?'],
    ['criminal history', 'Have you ever been convicted of a felony?', 'Have you ever been convicted of a felony offense?'],
    ['disability', 'Do you have a disability or need an accommodation?', 'Do you have a disability or require an accommodation?'],
    ['another country', 'Are you authorized to work in Canada?', 'Are you legally authorized to work in Canada?'],
    ['the employer', 'Have you ever worked for this company before?', 'Have you previously worked for this company before?'],
  ])('never suggests for %s, even when the wording is nearly identical', (_topic, asked, earlier) => {
    expect(similarAnswered(asked, answered(earlier))).toBeNull();
  });

  it('suggests only answers that were really saved, and the closest one', () => {
    const resolved = [
      { label: 'Are you willing to work onsite in the office?', answeredWith: 'onsite', status: 'answered' },
      { label: 'Are you willing to work onsite in the office daily?', answeredWith: 'onsite2', status: 'answered' },
      { label: 'Are you willing to work onsite in the office?', answeredWith: null, status: 'dismissed' },
    ];
    expect(similarAnswered('Are you willing to work onsite in our office?', resolved).answerId).toBe('onsite');
    expect(similarAnswered('Are you willing to work onsite in our office?', [{ ...resolved[2] }])).toBeNull();
  });
});

describe('confirming it in the dashboard', () => {
  let root; let db; let dash;
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const get = (p) => fetch(dash.url + p).then((r) => r.json());

  beforeEach(async () => {
    root = buildTestRoot();
    upsertScreeningAnswer(root, { id: 'onsite', patterns: ['willing to work onsite'], answer: 'Yes', type: 'text' }, { question: 'Are you willing to work onsite in the office?' });
    recordUnansweredQuestions(root, { jobId: 'a', company: 'Acme', questions: [{ label: 'Are you willing to work onsite in the office?' }] });
    markQuestionAnswered(root, 'are you willing to work onsite in the office', { answerId: 'onsite' });
    recordUnansweredQuestions(root, { jobId: 'b', company: 'Globex', questions: [{ label: 'Are you willing to work onsite in our office?' }] });
    db = openDatabase({ path: ':memory:' });
    const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
    dash = await startDashboard({ config: load(), db, logger: null, port: 0, deps: { loadConfigImpl: load } });
  });
  afterEach(async () => { await dash.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

  it('the profile page shows the earlier question next to the new one', async () => {
    const q = (await get('/api/profile')).questions.open.find((x) => /our office/.test(x.label));
    expect(q.similarTo).toMatchObject({ answerId: 'onsite', label: 'Are you willing to work onsite in the office?' });
  });

  it('one confirmation adds the new wording to that answer, and the question leaves the queue', async () => {
    const q = (await get('/api/profile')).questions.open.find((x) => /our office/.test(x.label));
    const res = await post('/api/profile/questions/same-as', { key: q.key, answerId: 'onsite' });
    expect(res.status).toBe(200);
    const state = await get('/api/profile');
    expect(state.questions.open.find((x) => /our office/.test(x.label))).toBeUndefined();
    const entry = state.screening.answers.find((a) => a.id === 'onsite');
    expect(entry.answer).toBe('Yes');
    expect(entry.patterns.length).toBeGreaterThan(1);
  });

  it('refuses an answer id that does not exist, and a question that is not in the queue', async () => {
    const q = (await get('/api/profile')).questions.open.find((x) => /our office/.test(x.label));
    expect((await post('/api/profile/questions/same-as', { key: q.key, answerId: 'nope' })).status).toBe(400);
    expect((await post('/api/profile/questions/same-as', { key: 'not a question', answerId: 'onsite' })).status).toBe(400);
  });
});
