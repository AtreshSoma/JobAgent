import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { assistApply } from '../../src/automation/applyRunner.js';
import {
  APPLICATION_PHASE,
  createApplicationState,
  markApplicationUserSubmitted,
  markApplicationVerified,
  transitionApplicationState,
} from '../../src/apply/applicationState.js';
import { LIFECYCLE } from '../../src/lifecycle.js';

const RESUME = join(process.cwd(), 'tests', 'node', 'fixtures', 'sample_resume.txt');

function packet() {
  return {
    id: 'resume-packet',
    job: { id: 'resume-job', url: 'https://example.test/apply?job=7', company: 'Example', title: 'Engineer' },
    ats: { platform: 'generic' },
    blockers: [],
    screeningPlan: { answered: [], needsUser: [] },
    fillPlan: {
      steps: [
        { field: 'email', label: 'Email', value: 'candidate@example.test', source: 'profile', selector: '#email' },
      ],
      uploads: [{ type: 'resume', path: RESUME, selector: '#resume' }],
      submitSelector: '#submit',
    },
  };
}

function memoryStore() {
  let state = null;
  return {
    path: 'memory://resume-job',
    loads: 0,
    saves: 0,
    async load() { this.loads += 1; return state ? structuredClone(state) : null; },
    async save(next) { this.saves += 1; state = structuredClone(next); },
    snapshot() { return state ? structuredClone(state) : null; },
  };
}

function pageAt(url) {
  const known = new Set(['#email', '#resume', '#submit']);
  const record = { fills: [], uploads: [], clicks: [], closed: 0 };
  return {
    record,
    url: () => url,
    locator(selector) {
      const exists = known.has(selector);
      return {
        count: async () => (exists ? 1 : 0),
        first: () => ({
          fill: async (value) => { record.fills.push({ selector, value }); },
          setInputFiles: async (path) => { record.uploads.push({ selector, path }); },
          click: async () => { record.clicks.push({ selector }); },
        }),
      };
    },
  };
}

function args(store, page, opened) {
  return {
    packet: packet(),
    config: { runtime: {}, candidate: {}, screeningAnswers: {} },
    mode: 'LIVE_ASSIST',
    options: { headless: true },
    deps: {
      stateStore: store,
      createSession: async () => ({ page, close: async () => { page.record.closed += 1; } }),
      openPage: async (_page, url) => {
        opened.push(url);
        return { status: 200, url, html: '<form></form>', guard: { blocked: false } };
      },
    },
  };
}

describe('safe application resume', () => {
  it('resumes an interrupted advancing checkpoint at its saved step and URL', async () => {
    const store = memoryStore();
    let interrupted = createApplicationState(packet());
    interrupted = transitionApplicationState(interrupted, APPLICATION_PHASE.ADVANCING, {
      currentStep: 2,
      lastUrl: 'https://example.test/apply/step/2?job=7',
      completedFields: [{ field: 'email', label: 'Email', source: 'profile', verified: true, step: 1 }],
      uploadVerification: [{ type: 'resume', fileName: 'sample_resume.txt', verified: true, step: 1 }],
    });
    await store.save(interrupted);

    const opened = [];
    const resumed = await assistApply(args(store, pageAt('https://example.test/apply/step/2?job=7'), opened));
    expect(resumed.resumed).toBe(true);
    expect(opened).toEqual(['https://example.test/apply/step/2?job=7']);
    expect(resumed.currentStep).toBe(2);
    expect(resumed.applicationState.resumeCount).toBe(1);
    expect(resumed.submitted).toBe(false);
  });

  it('reopens the last checkpoint, refills idempotently, persists no values, and cleans up headless sessions', async () => {
    const store = memoryStore();
    const opened = [];
    const firstPage = pageAt('https://example.test/apply?job=7');
    const first = await assistApply(args(store, firstPage, opened));
    expect(first.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(first.applicationState.phase).toBe(APPLICATION_PHASE.READY_FOR_REVIEW);
    expect(first.applicationState.currentStep).toBe(1);
    expect(firstPage.record.closed).toBe(1);

    const persistedText = JSON.stringify(store.snapshot());
    expect(persistedText).not.toContain('candidate@example.test');
    expect(persistedText).not.toContain(RESUME);
    expect(store.snapshot().completedFields).toHaveLength(1);
    expect(store.snapshot().unresolvedQuestions).toEqual([]);

    const resumedPage = pageAt('https://example.test/apply?job=7');
    const resumed = await assistApply(args(store, resumedPage, opened));
    expect(resumed.resumed).toBe(true);
    expect(resumed.applicationState.resumeCount).toBe(1);
    expect(opened).toEqual([
      'https://example.test/apply?job=7',
      'https://example.test/apply?job=7',
    ]);
    expect(resumedPage.record.fills).toHaveLength(1);
    expect(resumedPage.record.clicks).toEqual([]);
    expect(resumedPage.record.closed).toBe(1);
    // Same step/field overwrites its audit record instead of duplicating it.
    expect(resumed.applicationState.completedFields).toHaveLength(1);
  });

  it('never reopens User Submitted or Verified checkpoints', async () => {
    const store = memoryStore();
    const opened = [];
    const first = await assistApply(args(store, pageAt('https://example.test/apply?job=7'), opened));
    expect(first.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);

    await markApplicationUserSubmitted({ store, packet: packet(), evidence: ['human clicked final Submit'] });
    let createCalls = 0;
    const submitted = await assistApply({
      ...args(store, pageAt('https://example.test/apply?job=7'), opened),
      deps: {
        stateStore: store,
        createSession: async () => { createCalls += 1; throw new Error('must not open'); },
      },
    });
    expect(submitted.status).toBe(LIFECYCLE.SUBMIT_UNVERIFIED);
    expect(submitted.duplicatePrevented).toBe(true);
    expect(createCalls).toBe(0);

    await markApplicationVerified({ store, packet: packet(), evidence: ['ATS confirmation page'] });
    const verified = await assistApply({
      ...args(store, pageAt('https://example.test/apply?job=7'), opened),
      deps: {
        stateStore: store,
        createSession: async () => { createCalls += 1; throw new Error('must not open'); },
      },
    });
    expect(verified.status).toBe(LIFECYCLE.SUBMITTED);
    expect(verified.duplicatePrevented).toBe(true);
    expect(createCalls).toBe(0);
  });

  it('fails before opening a browser when the initial checkpoint cannot be persisted', async () => {
    let createCalls = 0;
    const result = await assistApply({
      packet: packet(),
      config: { runtime: {} },
      options: { headless: true },
      deps: {
        stateStore: {
          load: async () => null,
          save: async () => { throw new Error('disk full'); },
        },
        createSession: async () => { createCalls += 1; throw new Error('must not open'); },
      },
    });
    expect(result.status).toBe(LIFECYCLE.FAILED);
    expect(result.blockers.join(' ')).toContain('disk full');
    expect(createCalls).toBe(0);
  });
});
