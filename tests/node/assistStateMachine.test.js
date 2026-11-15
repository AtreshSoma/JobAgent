/**
 * The assist run is a state machine (audit A14).
 *
 * assistApply used to be one 1,000-line function. Its states now live in
 * src/automation/assistStages.js, its helpers in assistSupport.js, and the
 * submit gate stays in applyRunner.js (where `npm run verify` checks it). The
 * behaviour is pinned by the ~170 existing assistApply tests; these pin the
 * machine itself: the order of states a run walks, that every transition is
 * declared, and that the stage module cannot submit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assistApply } from '../../src/automation/applyRunner.js';
import { DONE, TRANSITIONS } from '../../src/automation/assistStages.js';
import { LIFECYCLE } from '../../src/lifecycle.js';

const ROOT = join(import.meta.dirname, '..', '..');
const RESUME = join(ROOT, 'tests', 'node', 'fixtures', 'sample_resume.txt');
const read = (file) => readFileSync(join(ROOT, 'src', 'automation', file), 'utf8');

function fakePage(known) {
  const set = new Set(known);
  const record = { fills: [], clicks: [] };
  return {
    record,
    locator(selector) {
      const count = set.has(selector) ? 1 : 0;
      return {
        count: async () => count,
        first: () => ({
          fill: async (v) => { record.fills.push({ selector, value: v }); },
          setInputFiles: async () => {},
          click: async () => { record.clicks.push({ selector }); },
        }),
      };
    },
  };
}

const packet = (over = {}) => ({
  job: { id: 'sm-1', url: 'https://example.com/apply', company: 'Acme', title: 'SDE' },
  blockers: [],
  screeningPlan: { answered: [], needsUser: [] },
  fillPlan: {
    steps: [{ field: 'email', label: 'Email', value: 'a@b.com', source: 'profile', selector: '#email' }],
    uploads: [{ type: 'resume', path: RESUME, selector: '#resume' }],
    submitSelector: '#submit_app',
  },
  resumePath: RESUME,
  ...over,
});

/** Run assistApply and return the result with the states it entered, in order. */
async function walk({ page = fakePage(['#email', '#resume', '#submit_app']), over = {}, deps = {}, options = {} } = {}) {
  const trail = [];
  const result = await assistApply({
    packet: packet(over),
    config: { runtime: {}, scoring: {}, candidate: {} },
    options: { headless: true, statePath: false, ...options },
    deps: {
      createSession: async () => ({ page, close: async () => {} }),
      openPage: async (_p, url) => ({ status: 200, html: '<form></form>', guard: { blocked: false }, url }),
      onState: (name) => trail.push(name),
      ...deps,
    },
  });
  return { result, trail };
}

describe('the states a run walks', () => {
  it('a one-page form: setup, one page, then the decision', async () => {
    const { result, trail } = await walk();
    expect(trail).toEqual(['begin', 'launch', 'openApplication', 'stepStart', 'fill', 'upload', 'validate', 'decide']);
    expect(result.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
  });

  it('a packet with no URL ends in begin, before a browser exists', async () => {
    const { result, trail } = await walk({ over: { job: { id: 'x' } } });
    expect(trail).toEqual(['begin']);
    expect(result.blockers).toContain('packet has no application URL');
  });

  it('a page wall ends in openApplication, before any page is filled', async () => {
    const { result, trail } = await walk({
      deps: { openPage: async (_p, url) => ({ status: 200, html: '', url, guard: { blocked: true, kind: 'captcha', reason: 'robot check' } }) },
    });
    expect(trail).toEqual(['begin', 'launch', 'openApplication']);
    expect(result.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
  });

  it('a missing browser ends in launch', async () => {
    const { result, trail } = await walk({
      deps: { createSession: async () => { throw new Error("Executable doesn't exist at /x. Please run: npx playwright install"); } },
    });
    expect(trail).toEqual(['begin', 'launch']);
    expect(result.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
  });

  it('a dry run stops in decide, before any click, whatever the form offers', async () => {
    const page = fakePage(['#email', '#resume', '#submit_app']);
    const { result, trail } = await walk({ page, options: { dryRun: true, autoSubmit: true } });
    expect(trail.at(-1)).toBe('decide');
    expect(result.status).toBe('dry_run');
    expect(page.record.fills).toEqual([]);
    expect(page.record.clicks).toEqual([]);
  });

  it('a cancelled run stops at the start of a page, with its state saved', async () => {
    const { result, trail } = await walk({ deps: { shouldCancel: () => true } });
    expect(trail).toEqual(['begin', 'launch', 'openApplication', 'stepStart']);
    expect(result.status).toBe(LIFECYCLE.CANCELLED);
  });
});

describe('the transition table', () => {
  it('declares every state, and every target is a declared state', () => {
    const states = Object.keys(TRANSITIONS);
    expect(states).toEqual(['begin', 'launch', 'openApplication', 'stepStart', 'fill', 'upload', 'validate',
      'decide', 'advance', 'exhausted']);
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) expect(states, `${from} -> ${to}`).toContain(to);
    }
    expect(DONE).toBe('done');
  });

  it('every path from begin can reach the end', () => {
    const reach = new Set(['begin']);
    for (let i = 0; i < 12; i += 1) for (const s of [...reach]) TRANSITIONS[s].forEach((t) => reach.add(t));
    expect([...reach].sort()).toEqual(Object.keys(TRANSITIONS).sort());
    // A page loop is the only cycle: advance goes back to stepStart.
    expect(TRANSITIONS.advance).toEqual(['stepStart', 'exhausted']);
  });
});

describe('who can submit', () => {
  it('the stage module has no way to click Submit or record a submission', () => {
    const stages = read('assistStages.js');
    expect(stages).not.toMatch(/options\.autoSubmit|autoSubmit\s*=/);
    // It may READ a saved phase (begin refuses to reopen a submitted application),
    // but never writes one that records a submission.
    expect(stages).not.toMatch(/checkpoint\(\s*APPLICATION_PHASE\.(SUBMITTING|VERIFYING|VERIFIED|USER_SUBMITTED)/);
    expect(stages).not.toMatch(/selectorOnly/);
    // Its one door to a submit is the gate applyRunner.js injects.
    expect(stages).toMatch(/tryAutoSubmit\(/);
  });

  it('the gate and its opt-in stay in applyRunner.js, where verify reads them', () => {
    const runner = read('applyRunner.js');
    expect(runner).toMatch(/const autoSubmit = options\.autoSubmit === true;/);
    expect(runner).toMatch(/if \(!autoSubmit\) return false;/);
    expect(runner).toMatch(/r\.tryAutoSubmit = tryAutoSubmit;/);
  });
});
