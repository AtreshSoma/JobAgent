/**
 * The auto-fill coverage probe (audit A1, A13), on local fixtures only.
 *
 * A1 asked for a live dry-run probe that records, per ATS, what auto-fill finds
 * and can map. The probe is built and tested here against saved pages; running
 * it on a real employer's site is a separate step that needs the owner's
 * go-ahead, so the probe REFUSES any URL that is not local. It builds on the
 * dry run that types and clicks nothing (N2), records only labels, kinds and
 * statuses (never a value), and stores them per ATS so the dashboard can show a
 * measured table instead of "fixture-tested". A13: a prepared packet knows the
 * questions a form asks before auto-fill starts, from the latest probe of it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import {
  assertProbeAllowed, coverageTable, formFieldsFor, probeForm, readCoverage, recordCoverage,
} from '../../src/automation/coverageProbe.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { openDatabase } from '../../src/logging/db.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';

const FIX = (name) => readFileSync(join(process.cwd(), 'tests', 'node', 'fixtures', 'ats', name), 'utf8');
const config = {
  candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@example.test', phone: '5550100' } },
  screeningAnswers: { answers: [] }, runtime: {},
};

describe('what a probe may open', () => {
  it('allows saved pages and local or reserved test hosts', () => {
    for (const url of ['file:///tmp/form.html', 'http://localhost:3000/apply', 'http://127.0.0.1/apply',
      'https://jobs.example.test/apply', 'https://acme.localhost/apply']) {
      expect(() => assertProbeAllowed(url), url).not.toThrow();
    }
  });

  it('refuses a real site, whoever asks', () => {
    for (const url of ['https://boards.greenhouse.io/acme/jobs/1', 'https://acme.wd1.myworkdayjobs.com/x',
      'https://jobs.lever.co/acme', 'not a url']) {
      expect(() => assertProbeAllowed(url), url).toThrow(/refusing to probe|owner|local/i);
    }
  });
});

describe('probing a form', () => {
  let browser;
  beforeAll(async () => { browser = await launchOrSkip(() => chromium.launch({ headless: true })); }, 30_000);
  afterAll(async () => { await browser?.close(); }, 30_000);
  skipWithoutBrowser(() => browser);

  async function probe(html, url = 'https://jobs.jobvite.example.test/acme/apply', cfg = config, ats = 'jobvite') {
    const context = await browser.newContext();
    await context.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    const page = await context.newPage();
    const record = await probeForm({ page, url, config: cfg, ats });
    return { record, page, context };
  }

  it('reports what would be filled, what needs the person, and the upload slot', async () => {
    const { record, page, context } = await probe(FIX('jobvite_form.html'));
    expect(record).toMatchObject({ ats: 'jobvite', found: 5, mapped: 4, needsYou: 0, uploads: 1 });
    expect(record.fields.map((f) => [f.label, f.status])).toEqual(expect.arrayContaining([
      ['First Name', 'mapped'], ['Last Name', 'mapped'], ['Email', 'mapped'], ['Phone', 'mapped'],
    ]));
    // A probe is a dry run: nothing was typed.
    expect(await page.locator('#jv-first').inputValue()).toBe('');
    await context.close();
  }, 60_000);

  it('counts a question nobody has answered as needing you, and a required one separately', async () => {
    const html = FIX('jobvite_form.html').replace('<button type="submit"',
      '<div class="jv-field"><label for="why">Why do you want to work here?</label><textarea id="why" required></textarea></div><button type="submit"');
    const { record, context } = await probe(html);
    expect(record.needsYou).toBe(1);
    expect(record.requiredNeedsYou).toBe(1);
    expect(record.fields.find((f) => f.label === 'Why do you want to work here?')).toMatchObject({ status: 'needs_you', required: true });
    await context.close();
  }, 60_000);

  it('records no value, anywhere', async () => {
    const { record, context } = await probe(FIX('jobvite_form.html'));
    const text = JSON.stringify(record);
    for (const secret of ['Dana', 'Okafor', 'dana@example.test', '5550100']) expect(text).not.toContain(secret);
    await context.close();
  }, 60_000);

  it('names the control it would press next, without pressing it', async () => {
    const { record, page, context } = await probe(
      '<form><label for="a">Email</label><input id="a" type="email"><button type="button" id="n" onclick="window.__clicked=1">Next</button></form>',
    );
    expect(record.advance).toMatch(/Next/);
    expect(await page.evaluate(() => window.__clicked)).toBeUndefined();
    await context.close();
  }, 60_000);

  it('refuses a live URL before opening anything', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await expect(probeForm({ page, url: 'https://boards.greenhouse.io/acme/jobs/1', config })).rejects.toThrow(/refusing to probe/);
    expect(page.url()).toBe('about:blank');
    await context.close();
  });
});

describe('the coverage store and table', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jobagent-coverage-')); mkdirSync(join(root, 'data'), { recursive: true }); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const rec = (over = {}) => ({
    at: '2026-11-16T10:00:00.000Z', ats: 'jobvite', host: 'jobs.jobvite.example.test', path: '/acme/apply',
    found: 5, mapped: 4, needsYou: 1, requiredNeedsYou: 1, uploads: 1, advance: null,
    fields: [{ label: 'Email', kind: 'text', required: true, status: 'mapped' }, { label: 'Why us?', kind: 'textarea', required: true, status: 'needs_you' }],
    ...over,
  });

  it('keeps the newest records first and bounded', () => {
    for (let i = 0; i < 230; i += 1) recordCoverage(root, rec({ at: `2026-11-16T10:${String(i % 60).padStart(2, '0')}:00.000Z`, found: i }));
    const all = readCoverage(root);
    expect(all).toHaveLength(200);
    expect(all[0].found).toBe(229);
  });

  it('summarises each platform, and says it is measured on local fixtures', () => {
    recordCoverage(root, rec());
    recordCoverage(root, rec({ ats: 'taleo', found: 4, mapped: 4, needsYou: 0, requiredNeedsYou: 0, host: 'acme.taleo.example.test' }));
    recordCoverage(root, rec({ found: 3, mapped: 3, needsYou: 0, requiredNeedsYou: 0 }));
    const table = coverageTable(readCoverage(root));
    expect(table.rows.map((r) => r.ats).sort()).toEqual(['jobvite', 'taleo']);
    expect(table.rows.find((r) => r.ats === 'jobvite')).toMatchObject({ forms: 2, found: 8, mapped: 7, needsYou: 1, percent: 88 });
    expect(table.basis).toMatch(/local fixtures|saved pages/i);
    expect(table.live).toBe(false);
  });

  it('A13: gives a prepared packet the questions a form asks, from its latest probe', () => {
    recordCoverage(root, rec());
    const fields = formFieldsFor(root, 'https://jobs.jobvite.example.test/acme/apply?utm=1');
    expect(fields).toEqual([
      { label: 'Email', kind: 'text', required: true },
      { label: 'Why us?', kind: 'textarea', required: true },
    ]);
    expect(formFieldsFor(root, 'https://jobs.jobvite.example.test/other/apply')).toEqual([]);
  });
});

describe('GET /api/coverage', () => {
  it('serves the table', async () => {
    const root = mkdtempSync(join(tmpdir(), 'jobagent-coverage-api-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    recordCoverage(root, {
      at: '2026-11-16T10:00:00.000Z', ats: 'icims', host: 'x.icims.example.test', path: '/a', found: 3, mapped: 3,
      needsYou: 0, requiredNeedsYou: 0, uploads: 0, advance: 'Next', fields: [],
    });
    const db = openDatabase({ path: ':memory:' });
    const dash = await startDashboard({ config: { root }, db, logger: null, port: 0 });
    try {
      const body = await fetch(`${dash.url}/api/coverage`).then((r) => r.json());
      expect(body.rows).toEqual([expect.objectContaining({ ats: 'icims', forms: 1, found: 3, percent: 100 })]);
      expect(body.live).toBe(false);
    } finally {
      await dash.close(); db.close(); rmSync(root, { recursive: true, force: true });
    }
  });
});
