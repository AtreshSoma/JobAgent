/**
 * The resume check on upload (audit F4): what tailoring will be able to work
 * with, said once when the master resume arrives instead of job by job.
 * The check itself is tests/python/test_readiness.py; these pin the route, the
 * cache, the upload response and the dialog.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { launchOrSkip, skipWithoutBrowser } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';
import { makeDocx } from './fixtures/docx.js';

const REPO = join(import.meta.dirname, '..', '..');
const EXAMPLE = join(REPO, 'resumes', 'base', 'MASTER_RESUME.example.docx');
const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

const STUB = {
  sections: ['professional experience'], unrecognized_headings: ['CAREER HISTORY'], roles: ['Engineer | Example | 2020 - Present'],
  bullets: 4, typed_bullets: 0, contact: { email: true, phone: false, linkedin: false, in_page_header: false },
  hyperlinks: 0, tables: 1, text_boxes: 0, estimated_pages: 1.4,
  findings: [
    { level: 'ok', code: 'structure', message: 'Found 1 section, 1 job and 4 bullets.' },
    { level: 'warn', code: 'no_phone', message: 'No phone number was found.' },
    { level: 'note', code: 'tables', message: '1 table. A tailored copy turns each row into a plain line.' },
  ],
};

async function withDashboard(fn, deps = {}) {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-readiness-'));
  mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
  copyFileSync(EXAMPLE, join(root, 'resumes', 'base', 'MASTER_RESUME.docx'));
  const db = openDatabase({ path: ':memory:' });
  const dash = await startDashboard({ config: { root }, db, logger: null, port: 0, deps });
  const get = (p) => fetch(dash.url + p).then((r) => r.json());
  const upload = (buffer) => fetch(`${dash.url}/api/master-resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename: 'MASTER_RESUME.docx', contentBase64: buffer.toString('base64') }),
  }).then((r) => r.json());
  try {
    return await fn({ get, upload });
  } finally {
    await dash.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('the resume check route', { timeout: 60_000 }, () => {
  it('reads the real master the way tailoring will', async (ctx) => {
    await withDashboard(async ({ get }) => {
      const report = await get('/api/master-resume/readiness');
      if (!report.available && /Python/.test(report.reason)) return ctx.skip();
      expect(report.available).toBe(true);
      expect(report.roles).toHaveLength(6);
      expect(report.findings.find((f) => f.code === 'structure')).toMatchObject({ level: 'ok' });
      expect(report.contact).toMatchObject({ email: true, phone: true });
    });
  });

  it('runs once per version of the file, and again after an upload', async () => {
    let calls = 0;
    const resumeReadinessImpl = async () => { calls += 1; return STUB; };
    await withDashboard(async ({ get, upload }) => {
      await get('/api/master-resume/readiness');
      await get('/api/master-resume/readiness');
      expect(calls).toBe(1);
      const lines = ['JORDAN EXAMPLE', 'EXPERIENCE', 'Engineer | Example | 2020 - Present',
        'Built streaming pipelines in Spark and Kafka moving twelve billion events a day for finance.',
        'Modelled the warehouse in dbt on Snowflake and cut the nightly batch from six hours to forty minutes.'];
      const result = await upload(makeDocx(lines));
      expect(result.replaced).toBe(true);
      // Said at once, on the upload itself.
      expect(result.readiness).toMatchObject({ available: true, bullets: 4 });
      expect(calls).toBe(2);
    }, { resumeReadinessImpl });
  });

  it('when the check cannot run, says so in plain words and the upload still succeeds', async () => {
    const resumeReadinessImpl = async () => { throw new Error('No module named docx'); };
    await withDashboard(async ({ get }) => {
      const report = await get('/api/master-resume/readiness');
      expect(report.available).toBe(false);
      expect(report.reason).toMatch(/could not run/);
      expect(report.reason).not.toMatch(/npm |pip install|\.json/);
    }, { resumeReadinessImpl });
  });
});

describe('the resume check in the Master resume dialog', { timeout: 90_000 }, () => {
  let browser;
  let dash;
  beforeAll(async () => {
    browser = await launchOrSkip(() => launchBrowser());
    if (browser) dash = await startTestDashboard({ deps: { resumeReadinessImpl: async () => STUB } });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await dash?.stop();
  }, 60_000);
  skipWithoutBrowser(() => browser);

  it('lists what to look at first, each with a mark and words, and passes axe', async () => {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, reducedMotion: 'reduce', bypassCSP: true });
      try {
        const page = await context.newPage();
        await page.goto(`${dash.url}/`);
        await waitUntilConnected(page);
        await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
        await page.locator('[data-action="toggle-account-menu"]').click();
        await page.getByRole('menuitem', { name: 'Master resume' }).click();
        const check = page.locator('#mrCheck');
        await check.locator('.mr-finding').first().waitFor();
        expect(await check.locator('.mr-note').innerText()).toBe('1 thing to look at before tailoring relies on this resume.');
        expect(await check.locator('.mr-finding').evaluateAll((nodes) => nodes.map((n) => n.dataset.code)))
          .toEqual(['no_phone', 'structure', 'tables']);
        expect(await check.locator('.mr-finding.is-warn').innerText()).toMatch(/Check:\s*No phone number was found\./);
        await page.addScriptTag({ path: AXE_PATH });
        const violations = await page.evaluate(async () => {
          // eslint-disable-next-line no-undef
          const r = await axe.run('#dlgMaster', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
          return r.violations.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
        });
        expect(violations, theme).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});
