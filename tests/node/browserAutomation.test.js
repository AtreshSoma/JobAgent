import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { createBrowserSession, openApplicationPage } from '../../src/automation/browser.js';
import { fillFields, requiredFieldsSatisfied } from '../../src/automation/fieldResolver.js';
import { uploadFiles } from '../../src/automation/uploadRunner.js';

const FIXTURES = join(process.cwd(), 'tests', 'node', 'fixtures');
const FORM_URL = pathToFileURL(join(FIXTURES, 'apply_form.html')).href;
const CAPTCHA_URL = pathToFileURL(join(FIXTURES, 'captcha_page.html')).href;
const RESUME = join(FIXTURES, 'sample_resume.txt');
const COVER = join(FIXTURES, 'sample_cover.txt');

const FILL_PLAN = {
  steps: [
    { field: 'first_name', label: 'First name', value: 'Atresh', source: 'profile', selector: '#first_name' },
    { field: 'last_name', label: 'Last name', value: 'Somayajula', source: 'profile', selector: '#last_name' },
    { field: 'email', label: 'Email', value: 'atresh@example.com', source: 'profile', selector: '#email' },
    { field: 'phone', label: 'Phone', value: '555-0100', source: 'profile', selector: '#phone' },
    { field: 'nope', label: 'Missing', value: 'x', source: 'profile', selector: '#does_not_exist' },
  ],
  uploads: [
    { type: 'resume', path: RESUME, selector: '#resume' },
    { type: 'coverLetter', path: COVER, selector: '#cover_letter' },
  ],
  submitSelector: '#submit_app',
};

// These tests drive a REAL Chromium against LOCAL file:// fixtures only.
// They never touch a real ATS. If Chromium is unavailable, they self-skip.
describe('browser automation against a local fixture form', () => {
  let session;
  let available = true;

  beforeAll(async () => {
    try {
      session = await createBrowserSession({ headless: true });
    } catch {
      available = false;
    }
  }, 60000);

  afterAll(async () => { await session?.close?.(); });

  it('opens a clean form page without a guard block', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    const nav = await openApplicationPage(page, FORM_URL);
    expect(nav.guard.blocked).toBe(false);
  }, 60000);

  it('fills resolved text fields and reports the unresolved one', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, FORM_URL);
    const fill = await fillFields(page, FILL_PLAN);
    expect(fill.filled.map((f) => f.field).sort()).toEqual(['email', 'first_name', 'last_name', 'phone']);
    expect(fill.unresolved.map((u) => u.field)).toContain('nope');
    expect(await page.inputValue('#email')).toBe('atresh@example.com');
    expect(await page.inputValue('#first_name')).toBe('Atresh');

    const req = requiredFieldsSatisfied(fill.filled, FILL_PLAN);
    expect(req.ok).toBe(true);
  }, 60000);

  it('uploads the resume and cover letter to the file inputs', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, FORM_URL);
    const up = await uploadFiles(page, FILL_PLAN);
    expect(up.uploaded.map((u) => u.type).sort()).toEqual(['coverLetter', 'resume']);
    expect(up.uploaded.every((u) => u.verified === true)).toBe(true);
    expect(up.uploaded.every((u) => u.verificationMethod === 'input-file-list')).toBe(true);
    expect(up.blockers).toEqual([]);
  }, 60000);

  it('reports a blocker when an upload file is missing', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, FORM_URL);
    const plan = { uploads: [{ type: 'resume', path: join(FIXTURES, 'missing.pdf'), selector: '#resume' }] };
    const up = await uploadFiles(page, plan);
    expect(up.uploaded).toEqual([]);
    expect(up.blockers[0]).toMatch(/file not found/);
  }, 60000);

  it('flags a CAPTCHA page as a guard block (never proceeds)', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    const nav = await openApplicationPage(page, CAPTCHA_URL);
    expect(nav.guard.blocked).toBe(true);
    expect(nav.guard.kind).toBe('captcha');
  }, 60000);

  it('reuses ONE live persistent context per profile — a new TAB per assist, so consecutive auto-applies never fight over the profile lock', async (ctx) => {
    if (!available) return ctx.skip();
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'ja-profile-'));
    const s1 = await createBrowserSession({ headless: true, userDataDir: dir });
    try {
      // Leave s1 "open for review" (exactly what assist does), then start the
      // next job: it must attach to the SAME context with a fresh tab instead
      // of a doomed second launch on the locked profile.
      const s2 = await createBrowserSession({ headless: true, userDataDir: dir });
      expect(s2.context).toBe(s1.context);
      expect(s2.page).not.toBe(s1.page);
      const nav = await openApplicationPage(s2.page, FORM_URL); // and it can navigate
      expect(nav.guard.blocked).toBe(false);
      await s2.close();                                   // closes only its tab
      expect(s1.page.isClosed()).toBe(false);             // review tab untouched
    } finally {
      try { await s1.context.close(); } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, 60000);
});
