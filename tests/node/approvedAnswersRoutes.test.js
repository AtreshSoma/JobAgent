/**
 * Draft and approve a free-text answer from the dashboard (audit A4), and the
 * run using the approved answer for that job only.
 */
import { rmSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { assistApply } from '../../src/automation/applyRunner.js';
import { approveAnswer } from '../../src/apply/approvedAnswers.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { openDatabase } from '../../src/logging/db.js';
import { buildTestRoot } from './globalSetup.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';

const Q = 'Why do you want to work at this company?';

describe('the dashboard routes', () => {
  let root; let db; let dash; let drafts;
  const post = (p, body) => fetch(dash.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const get = (p) => fetch(dash.url + p).then((r) => r.json());

  beforeEach(async () => {
    root = buildTestRoot();
    db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Globex', title: 'Senior Data Engineer', status: 'prepared', score: 80, jd_text: 'Requirements\n- Python' });
    db.upsertJob({ id: 'j2', company: 'Initech', title: 'Data Engineer', status: 'prepared', score: 70, jd_text: 'Requirements\n- SQL' });
    drafts = [];
    const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
    dash = await startDashboard({
      config: load(), db, logger: null, port: 0,
      deps: {
        loadConfigImpl: load,
        draftAnswerFn: async (args) => { drafts.push(args.question); return args.question.includes('sponsorship')
          ? { ok: false, reason: 'refused' }
          : { ok: true, text: 'I built pipelines at Contoso.', evidence: [{ id: 'u1', text: 'Built pipelines.' }], provenance: { task: 'free-text-answer@1' } }; },
      },
    });
  });
  afterEach(async () => { await dash.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

  it('drafts without saving anything', async () => {
    const r = await post('/api/jobs/j1/draft-answer', { question: Q });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, text: 'I built pipelines at Contoso.', evidence: [{ id: 'u1' }] });
    expect((await get('/api/jobs/j1/approved-answers')).answers).toEqual([]);
  });

  it('saves only what the person approves, for that job, and lists and removes it', async () => {
    const a = await post('/api/jobs/j1/approved-answers', { question: Q, text: 'I built pipelines at Contoso, and I like Globex\'s data work.', source: 'draft', evidence: ['u1'] });
    expect(a.status).toBe(200);
    expect((await get('/api/jobs/j1/approved-answers')).answers).toHaveLength(1);
    expect((await get('/api/jobs/j2/approved-answers')).answers).toEqual([]);
    const gone = await fetch(`${dash.url}/api/jobs/j1/approved-answers`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: Q }) });
    expect(gone.status).toBe(200);
    expect((await get('/api/jobs/j1/approved-answers')).answers).toEqual([]);
  });

  it('refuses an empty approval and a sensitive question', async () => {
    expect((await post('/api/jobs/j1/approved-answers', { question: Q, text: '  ' })).status).toBe(400);
    expect((await post('/api/jobs/j1/approved-answers', { question: 'Do you require visa sponsorship?', text: 'No' })).status).toBe(400);
  });

  it('says so when a draft cannot be made', async () => {
    const r = await post('/api/jobs/j1/draft-answer', { question: 'Do you require visa sponsorship?' });
    expect(r.body.ok).toBe(false);
  });
});

describe('a run with an approved answer', () => {
  let browser; let root;
  beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch({ headless: true })); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  beforeEach(() => { root = buildTestRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  skipWithoutBrowser(() => browser);

  const FORM = '<form><label for="why">Why do you want to work at this company?</label><textarea id="why"></textarea><button type="button" id="next">Next</button></form>';
  async function run(jobId) {
    const context = await browser.newContext();
    await context.route('https://jobs.example.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: FORM }));
    const page = await context.newPage();
    const result = await assistApply({
      packet: { job: { id: jobId, url: 'https://jobs.example.test/apply' }, blockers: [], owner: {}, fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] } },
      config: { root, candidate: {}, screeningAnswers: { answers: [] }, runtime: {} },
      options: { headless: true, statePath: false, maxSteps: 1 },
      deps: { createSession: async () => ({ page, close: async () => {} }) },
    });
    const typed = await page.locator('#why').inputValue();
    await context.close();
    return { result, typed };
  }

  it('types the approved answer on the job it was approved for', async () => {
    approveAnswer(root, 'job-a', { question: Q, text: 'I built pipelines at Contoso.', source: 'draft' });
    expect((await run('job-a')).typed).toBe('I built pipelines at Contoso.');
  }, 90_000);

  it('does not type it on another job, which still asks', async () => {
    approveAnswer(root, 'job-a', { question: Q, text: 'I built pipelines at Contoso.', source: 'draft' });
    const { typed, result } = await run('job-b');
    expect(typed).toBe('');
    expect(result.status).toBe('assist_blocked');
  }, 90_000);
});
