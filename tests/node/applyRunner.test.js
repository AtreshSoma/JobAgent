import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { assistApply } from '../../src/automation/applyRunner.js';
import { APPROVAL_STATUS } from '../../src/apply/approvalQueue.js';
import { LIFECYCLE } from '../../src/lifecycle.js';

const RESUME = join(process.cwd(), 'tests', 'node', 'fixtures', 'sample_resume.txt');

/**
 * Fake Playwright page. `known` is the set of selectors that resolve to exactly
 * one element. Records every fill/upload/click for assertions.
 */
function makeFakePage(known) {
  const set = new Set(known);
  const record = { fills: [], uploads: [], clicks: [] };
  const page = {
    record,
    locator(selector) {
      const count = set.has(selector) ? 1 : 0;
      return {
        count: async () => count,
        first: () => ({
          fill: async (v) => { record.fills.push({ selector, value: v }); },
          setInputFiles: async (p) => { record.uploads.push({ selector, path: p }); },
          click: async () => { record.clicks.push({ selector }); },
        }),
      };
    },
  };
  return page;
}

function basePacket(overrides = {}) {
  return {
    job: { id: 'job-1', url: 'https://example.com/apply', company: 'Acme', title: 'SDE' },
    score: 90,
    resumePath: RESUME,
    resumeTailored: true,
    blockers: [],
    screeningPlan: { answered: [{ answer: 'Yes, I require sponsorship (H-1B)' }], needsUser: [] },
    fillPlan: {
      steps: [
        { field: 'email', label: 'Email', value: 'a@b.com', source: 'profile', selector: '#email' },
        { field: 'first_name', label: 'First', value: 'Atresh', source: 'profile', selector: '#first_name' },
      ],
      uploads: [{ type: 'resume', path: RESUME, selector: '#resume' }],
      submitSelector: '#submit_app',
    },
    ...overrides,
  };
}

const KNOWN = ['#email', '#first_name', '#resume', '#submit_app'];

function sessionDeps(page) {
  return {
    createSession: async () => ({ page, close: async () => { page.record.closed = true; } }),
    openPage: async (_p, url) => ({ status: 200, html: '<form></form>', guard: { blocked: false }, url }),
  };
}

describe('assistApply', () => {
  it('fails fast when the packet has no URL', async () => {
    const r = await assistApply({ packet: basePacket({ job: { id: 'x' } }), config: { runtime: {}, scoring: {} } });
    expect(r.status).toBe(LIFECYCLE.FAILED);
    expect(r.blockers).toContain('packet has no application URL');
  });

  it('auto-submit (opt-in) clicks the final Submit on a completely clean form', async () => {
    const page = makeFakePage(KNOWN);
    const r = await assistApply({
      packet: basePacket(),
      config: { runtime: { maxApplicationsPerDay: 15 }, scoring: {} },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true, autoSubmit: true },
      deps: { ...sessionDeps(page), wait: async () => {} },
    });
    expect(r.status).toBe(LIFECYCLE.SUBMITTED);
    expect(r.submitted).toBe(true);
    expect(page.record.clicks).toEqual([{ selector: '#submit_app' }]);
  });

  it('auto-submit REFUSES when the form has blockers (falls back to ready_for_submit)', async () => {
    // Remove the resume upload target so uploads produce a blocker.
    const page = makeFakePage(['#email', '#first_name', '#submit_app']);
    const r = await assistApply({
      packet: basePacket(),
      config: { runtime: {}, scoring: {} },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true, autoSubmit: true },
      deps: { ...sessionDeps(page), wait: async () => {} },
    });
    expect(r.submitted).toBe(false);
    expect(page.record.clicks).toHaveLength(0); // never clicked Submit
  });

  it('auto-submit REFUSES beyond the daily application cap', async () => {
    const page = makeFakePage(KNOWN);
    const r = await assistApply({
      packet: basePacket(),
      config: { runtime: { maxApplicationsPerDay: 5 }, scoring: {} },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      dailyCount: 5, // cap already reached today
      options: { headless: true, autoSubmit: true },
      deps: { ...sessionDeps(page), wait: async () => {} },
    });
    expect(r.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(r.submitted).toBe(false);
    expect(page.record.clicks).toHaveLength(0);
    expect(r.note).toMatch(/daily application cap/);
  });

  it('WITHOUT the opt-in flag a clean form still stops before submit', async () => {
    const page = makeFakePage(KNOWN);
    const r = await assistApply({
      packet: basePacket(),
      config: { runtime: {}, scoring: {} },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true },
      deps: { ...sessionDeps(page), wait: async () => {} },
    });
    expect(r.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(r.submitted).toBe(false);
    expect(page.record.clicks).toHaveLength(0);
  });

  it('treats the human closing the browser as ready_for_submit, not blocked/failed', async () => {
    const page = makeFakePage(KNOWN);
    const r = await assistApply({
      packet: basePacket(),
      config: { runtime: {}, scoring: {} },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true },
      deps: {
        createSession: async () => ({ page, close: async () => {} }),
        openPage: async () => { throw new Error('Target page, context or browser has been closed'); },
      },
    });
    expect(r.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(r.browserClosedByUser).toBe(true);
    expect(r.blockers.some((b) => /assist error/.test(b))).toBe(false);
  });

  it('fills fields + uploads then STOPS at ready_for_submit (never submits)', async () => {
    const page = makeFakePage(KNOWN);
    const r = await assistApply({
      packet: basePacket(),
      config: { runtime: { maxApplicationsPerDay: 15 }, scoring: { submit: { minScore: 75 } } },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true },
      deps: sessionDeps(page),
    });
    expect(r.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(r.submitted).toBe(false);
    expect(page.record.fills).toHaveLength(2);
    expect(page.record.uploads).toHaveLength(1);
    expect(page.record.clicks).toHaveLength(0); // never clicked anything
    // The final submit control is identified for awareness but never clicked.
    expect(r.submitSelector).toBe('#submit_app');
  });

  it('STOPS at assist_blocked when the page is protected (CAPTCHA)', async () => {
    const page = makeFakePage(KNOWN);
    const deps = {
      createSession: async () => ({ page, close: async () => {} }),
      openPage: async () => ({ status: 200, html: 'recaptcha', guard: { blocked: true, kind: 'captcha', reason: 'captcha signal' } }),
    };
    const r = await assistApply({
      packet: basePacket(),
      config: { runtime: {}, scoring: {} },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true },
      deps,
    });
    expect(r.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
    expect(page.record.clicks).toHaveLength(0);
    expect(r.blockers.some((b) => b.includes('captcha'))).toBe(true);
  });

  it('blocks at assist_blocked when a screening question needs the user', async () => {
    const page = makeFakePage(KNOWN);
    const packet = basePacket();
    packet.screeningPlan.needsUser = [{ label: 'Why do you want to work here?' }];
    const r = await assistApply({
      packet,
      config: { runtime: { maxApplicationsPerDay: 15 }, scoring: { submit: { minScore: 75 } } },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true },
      deps: sessionDeps(page),
    });
    expect(r.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
    expect(page.record.clicks).toHaveLength(0);
  });

  it('refuses to advance/submit when sponsorship answer is untruthful', async () => {
    const page = makeFakePage(KNOWN);
    const packet = basePacket();
    packet.screeningPlan.answered = [{ answer: 'No sponsorship required' }];
    const r = await assistApply({
      packet,
      config: { runtime: { maxApplicationsPerDay: 15 }, scoring: { submit: { minScore: 75 } } },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true },
      deps: sessionDeps(page),
    });
    expect(r.sponsorshipTruthful).toBe(false);
    expect(r.submitted).toBe(false);
    expect(r.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
  });

  it('advances a multi-step form, then STOPS at the final page (never submits)', async () => {
    // Page 1 has only a "Continue" button; page 2 reveals the real submit, which
    // the assistant must NOT click — it stops for the human.
    let step = 0;
    const record = { fills: [], uploads: [], clicks: [] };
    const page1Known = new Set(['#email', '#first_name', '#resume', '#next']);
    const page = {
      record,
      locator(selector) {
        const exists = page1Known.has(selector) || (step >= 1 && selector === '#final_submit');
        return {
          count: async () => (exists ? 1 : 0),
          first: () => ({
            fill: async (v) => { record.fills.push({ selector, value: v }); },
            setInputFiles: async (p) => { record.uploads.push({ selector, path: p }); },
            click: async () => { record.clicks.push({ selector }); if (selector === '#next') step += 1; },
          }),
        };
      },
      evaluate: async (fn) => {
        const name = typeof fn === 'function' ? fn.name : '';
        if (name === 'collectFields') return [];
        if (name === 'collectClickables') {
          return step === 0
            ? [{ text: 'Continue', selector: '#next' }]
            : [{ text: 'Submit application', selector: '#final_submit' }];
        }
        return [];
      },
    };
    const packet = basePacket();
    packet.fillPlan.submitSelector = null; // no static submit; discovered (not clicked) on page 2

    const r = await assistApply({
      packet,
      config: {
        runtime: { maxApplicationsPerDay: 15, assistMaxSteps: 4 },
        scoring: { submit: { minScore: 75 } },
        candidate: {}, screeningAnswers: {},
      },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true },
      deps: {
        createSession: async () => ({ page, close: async () => {} }),
        openPage: async (_p, url) => ({ status: 200, html: '<form></form>', guard: { blocked: false }, url }),
        inspectPage: async (_p, url) => ({ status: null, html: '<form></form>', guard: { blocked: false }, url }),
        wait: async () => {}, // settles navigation
      },
    });
    expect(r.advancedSteps).toBe(1);
    expect(r.steps).toBe(2);
    expect(r.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(r.submitted).toBe(false);
    expect(record.clicks).toContainEqual({ selector: '#next' }); // advanced safely
    expect(record.clicks).not.toContainEqual({ selector: '#final_submit' }); // never submitted
  });

  it('fills into an EMBEDDED ATS iframe instead of the empty host page', async () => {
    // The host page (Dropbox/Samsara style) has no fields; the real Greenhouse
    // form lives in a child iframe. assistApply must descend into the frame.
    const hostRecord = { fills: [], uploads: [], clicks: [] };
    const frameRecord = { fills: [], uploads: [], clicks: [] };
    const known = new Set(['#email', '#first_name', '#resume', '#submit_app']);

    const mkLocator = (rec, resolves) => (selector) => ({
      count: async () => (resolves(selector) ? 1 : 0),
      first: () => ({
        fill: async (v) => { rec.fills.push({ selector, value: v }); },
        setInputFiles: async (p) => { rec.uploads.push({ selector, path: p }); },
        click: async () => { rec.clicks.push({ selector }); },
      }),
    });

    const mainFrame = {
      url: () => 'https://jobs.dropbox.com/listing/1',
      parentFrame: () => null,
      evaluate: async () => [],
    };
    const embedFrame = {
      url: () => 'https://boards.greenhouse.io/embed/job_app?token=1',
      parentFrame: () => mainFrame,
      evaluate: async (fn) => ((typeof fn === 'function' ? fn.name : '') === 'collectFields'
        ? [{ kind: 'text', type: 'email', selector: '#email', label: 'Email', name: 'email', required: true, options: [] }]
        : []),
      locator: mkLocator(frameRecord, (s) => known.has(s)),
    };
    const page = {
      record: hostRecord,
      frames: () => [mainFrame, embedFrame],
      // Host page resolves NOTHING fillable.
      locator: mkLocator(hostRecord, () => false),
      evaluate: async () => [],
    };

    const r = await assistApply({
      packet: basePacket(),
      config: {
        runtime: { maxApplicationsPerDay: 15, assistMaxSteps: 1 },
        scoring: { submit: { minScore: 75 } },
        candidate: { identity: { fullName: 'Atresh Somayajula' }, contact: { email: 'a@b.com' } },
        screeningAnswers: {},
      },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true },
      deps: {
        createSession: async () => ({ page, close: async () => {} }),
        openPage: async (_p, url) => ({ status: 200, html: '<iframe></iframe>', guard: { blocked: false }, url }),
      },
    });

    // Fills + the resume upload landed in the FRAME, never the host page.
    expect(frameRecord.fills.map((f) => f.selector)).toEqual(
      expect.arrayContaining(['#email', '#first_name']),
    );
    expect(frameRecord.uploads).toEqual([{ selector: '#resume', path: RESUME }]);
    expect(hostRecord.fills).toHaveLength(0);
    expect(hostRecord.uploads).toHaveLength(0);
    expect(r.submitted).toBe(false);
  });

  // Real Workday/Phenom forms (e.g. CenterWell) render many OPTIONAL fields the
  // agent can't answer — middle name, address line 2, "decline to answer" EEO
  // selects. Those must NOT stop the run; only REQUIRED unknowns do.
  function pageWithDynamicField(dynamicField) {
    const known = new Set(['#email', '#first_name', '#resume', '#submit_app']);
    const record = { fills: [], uploads: [], clicks: [] };
    const page = {
      record,
      locator(selector) {
        const exists = known.has(selector);
        return {
          count: async () => (exists ? 1 : 0),
          first: () => ({
            fill: async (v) => { record.fills.push({ selector, value: v }); },
            setInputFiles: async (p) => { record.uploads.push({ selector, path: p }); },
            click: async () => { record.clicks.push({ selector }); },
          }),
        };
      },
      evaluate: async (fn) => {
        const name = typeof fn === 'function' ? fn.name : '';
        if (name === 'collectFields') return [dynamicField];
        return [];
      },
    };
    return page;
  }

  function assistArgs(page) {
    return {
      packet: basePacket(),
      config: {
        runtime: { maxApplicationsPerDay: 15 },
        scoring: { submit: { minScore: 75 } },
        candidate: {}, screeningAnswers: {},
      },
      mode: 'LIVE_ASSIST',
      approval: { approval_status: APPROVAL_STATUS.APPROVED, approved_by_user: 1 },
      options: { headless: true },
      deps: {
        createSession: async () => ({ page, close: async () => {} }),
        openPage: async (_p, url) => ({ status: 200, html: '<form></form>', guard: { blocked: false }, url }),
      },
    };
  }

  it('leaves an OPTIONAL unknown field blank and still reaches ready_for_submit', async () => {
    const page = pageWithDynamicField({
      kind: 'text', type: 'text', selector: '#mid', label: 'Legal Middle Name', name: 'mid', required: false, options: [],
    });
    const r = await assistApply(assistArgs(page));
    expect(r.status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
    expect(r.submitted).toBe(false);
    expect(r.optionalSkipped).toContain('Legal Middle Name');
    expect(page.record.clicks).toHaveLength(0); // never submitted
  });

  it('STOPS when a REQUIRED unknown field cannot be answered (no fabrication)', async () => {
    const page = pageWithDynamicField({
      kind: 'text', type: 'textarea', selector: '#why', label: 'Why do you want to work here?', name: 'why', required: true, options: [],
    });
    const r = await assistApply(assistArgs(page));
    expect(r.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
    expect(r.submitted).toBe(false);
    expect(r.blockers.some((b) => /required field needs user/.test(b))).toBe(true);
    expect(page.record.clicks).toHaveLength(0);
  });
});

