import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { createBrowserSession, openApplicationPage } from '../../src/automation/browser.js';
import { scanFields, resolveFormScope } from '../../src/automation/domScanner.js';
import { fillFields } from '../../src/automation/fieldResolver.js';
import { fillScannedFields } from '../../src/automation/fieldFiller.js';
import { uploadFiles } from '../../src/automation/uploadRunner.js';
import { browserUnavailable } from './helpers/browser.js';

const FIXTURES = join(process.cwd(), 'tests', 'node', 'fixtures');
const HOST_URL = pathToFileURL(join(FIXTURES, 'embed_host.html')).href;
const TOP_FORM_URL = pathToFileURL(join(FIXTURES, 'apply_form.html')).href;
const RESUME = join(FIXTURES, 'sample_resume.txt');

const FILL_PLAN = {
  steps: [
    { field: 'first_name', label: 'First name', value: 'Priya', source: 'profile', selector: '#first_name' },
    { field: 'last_name', label: 'Last name', value: 'Raghunathan', source: 'profile', selector: '#last_name' },
    { field: 'email', label: 'Email', value: 'priya@example.com', source: 'profile', selector: '#email' },
    { field: 'phone', label: 'Phone', value: '555-0100', source: 'profile', selector: '#phone' },
  ],
  uploads: [{ type: 'resume', path: RESUME, selector: '#resume' }],
  submitSelector: '#submit_app',
};

const CANDIDATE = {
  identity: { fullName: 'Priya Raghunathan' },
  contact: { email: 'priya@example.com', phone: '9843127760' },
  location: { city: 'Morrisville', state: 'North Carolina', country: 'United States' },
};

// Drives REAL Chromium against LOCAL file:// fixtures that reproduce an ATS form
// embedded in an <iframe> (the Dropbox/Samsara case). Self-skips if Chromium is
// unavailable. Never touches a real ATS.
describe('embedded iframe form filling (real browser)', () => {
  let session;
  let available = true;

  beforeAll(async () => {
    try {
      session = await createBrowserSession({ headless: true });
    } catch (err) {
      available = browserUnavailable(err);
    }
  }, 60000);

  afterAll(async () => { await session?.close?.(); }, 30000);

  it('finds NO fields when scanning the top document (reproduces the bug)', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, HOST_URL);
    const topLevel = await scanFields(page);
    expect(topLevel).toEqual([]);
  }, 60000);

  it('resolveFormScope descends into the embedded ATS frame', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, HOST_URL);
    const scope = await resolveFormScope(page);
    // It must NOT be the page (it found a better frame).
    expect(scope).not.toBe(page);
    expect(scope.url()).toMatch(/grnhse_embed_form\.html$/);
    const fields = await scanFields(scope);
    expect(fields.map((f) => f.label)).toEqual(
      expect.arrayContaining(['First name', 'Last name', 'Email', 'Phone']),
    );
  }, 60000);

  it('fills the static plan INTO the iframe and values actually land', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, HOST_URL);
    const scope = await resolveFormScope(page);
    const fill = await fillFields(scope, FILL_PLAN);
    expect(fill.filled.map((f) => f.field).sort()).toEqual(['email', 'first_name', 'last_name', 'phone']);
    // Read values back from inside the frame to prove they were written there.
    expect(await scope.locator('#email').inputValue()).toBe('priya@example.com');
    expect(await scope.locator('#first_name').inputValue()).toBe('Priya');
    expect(await scope.locator('#phone').inputValue()).toBe('555-0100');
    // The top document still has no such fields.
    expect(await page.locator('#email').count()).toBe(0);
  }, 60000);

  it('dynamic scan+fill populates the iframe from the candidate profile', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, HOST_URL);
    const scope = await resolveFormScope(page);
    const scanned = await scanFields(scope);
    const dyn = await fillScannedFields(scope, scanned, { candidate: CANDIDATE, screeningAnswers: {} });
    const filledLabels = dyn.filled.map((f) => f.label);
    expect(filledLabels).toEqual(expect.arrayContaining(['First name', 'Last name', 'Email']));
    expect(await scope.locator('#first_name').inputValue()).toBe('Priya');
    expect(await scope.locator('#last_name').inputValue()).toBe('Raghunathan');
  }, 60000);

  it('uploads the resume to the file input INSIDE the iframe', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, HOST_URL);
    const scope = await resolveFormScope(page);
    const up = await uploadFiles(scope, FILL_PLAN);
    expect(up.uploaded.map((u) => u.type)).toEqual(['resume']);
    expect(up.blockers).toEqual([]);
  }, 60000);

  it('still returns the page unchanged for a top-level (non-embedded) form', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, TOP_FORM_URL);
    const scope = await resolveFormScope(page);
    // No embedded ATS frame -> scope is the page itself, and fields are top-level.
    expect(scope).toBe(page);
    const fields = await scanFields(scope);
    expect(fields.map((f) => f.label)).toEqual(expect.arrayContaining(['First name', 'Email']));
  }, 60000);
});
