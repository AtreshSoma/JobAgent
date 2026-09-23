/**
 * LOCAL contract fixtures only — these tests do not claim live ATS parity and
 * never make a network request or submit an application. They prove the named
 * adapter selectors, file attachment verification, DOM scanning, and final-
 * submit stop gate against representative markup for each platform.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { detectAts } from '../../src/apply/atsDetector.js';
import { getPlatform } from '../../src/apply/platforms/index.js';
import { createBrowserSession, openApplicationPage } from '../../src/automation/browser.js';
import { scanFields } from '../../src/automation/domScanner.js';
import { fillFields, verifyFilledFields } from '../../src/automation/fieldResolver.js';
import { applyValue } from '../../src/automation/fieldFiller.js';
import { findAdvanceControl, findSubmitControl } from '../../src/automation/navigator.js';
import { uploadFiles } from '../../src/automation/uploadRunner.js';
import { browserUnavailable } from './helpers/browser.js';

const FIXTURE = pathToFileURL(join(process.cwd(), 'tests', 'node', 'fixtures', 'ats_application_forms.html')).href;
const RESUME = join(process.cwd(), 'tests', 'node', 'fixtures', 'sample_resume.txt');

const CASES = [
  { key: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1', fields: ['firstName', 'lastName', 'email'] },
  { key: 'lever', url: 'https://jobs.lever.co/acme/1', fields: ['fullName', 'email', 'phone'] },
  { key: 'ashby', url: 'https://jobs.ashbyhq.com/acme/1', fields: ['fullName', 'email', 'phone'] },
  { key: 'workday', url: 'https://acme.wd1.myworkdayjobs.com/en-US/jobs/job/1', fields: ['firstName', 'lastName', 'email'] },
  { key: 'smartrecruiters', url: 'https://jobs.smartrecruiters.com/Acme/1', fields: ['firstName', 'lastName', 'email'] },
  { key: 'generic', url: 'https://careers.example.test/jobs/1/apply', fields: ['firstName', 'lastName', 'email'] },
];

const VALUES = {
  firstName: 'Fixture',
  lastName: 'Candidate',
  fullName: 'Fixture Candidate',
  email: 'fixture@example.test',
  phone: '5550100',
};

describe('ATS application contract fixtures (real local browser, no submit)', () => {
  let session;
  let available = true;

  beforeAll(async () => {
    try { session = await createBrowserSession({ headless: true }); }
    catch (err) { available = browserUnavailable(err); }
  }, 60000);

  afterAll(async () => { await session?.close?.(); }, 30000);

  for (const fixture of CASES) {
    it(`${fixture.key}: detects/prepares/fills/verifies upload and stops at final review`, async (ctx) => {
      if (!available) return ctx.skip();
      expect(detectAts({ url: fixture.url }).platform).toBe(fixture.key);
      const platform = getPlatform(fixture.key);
      const plan = platform.prepare({
        prefill: {
          plan: fixture.fields.map((field) => ({
            field,
            label: field,
            value: VALUES[field],
            source: 'fixture-profile',
          })),
          needsUser: [],
        },
        uploads: { uploads: [{ type: 'resume', path: RESUME }] },
      });
      expect(plan.stopBeforeSubmit).toBe(true);
      expect(plan.submitReady).toBe(false);

      const { page } = session;
      const localUrl = `${FIXTURE}?ats=${fixture.key}`;
      const nav = await openApplicationPage(page, localUrl);
      expect(nav.guard.blocked).toBe(false);
      expect((await scanFields(page)).length).toBeGreaterThanOrEqual(4);

      const fill = await fillFields(page, plan);
      expect(fill.errors).toEqual([]);
      expect(fill.filled.map((field) => field.field).sort()).toEqual([...fixture.fields].sort());
      const accepted = await verifyFilledFields(page, fill.filled);
      expect(accepted.rejected).toEqual([]);
      expect(accepted.accepted).toHaveLength(fixture.fields.length);

      const uploads = await uploadFiles(page, plan);
      expect(uploads.blockers).toEqual([]);
      expect(uploads.uploaded).toHaveLength(1);
      expect(uploads.uploaded[0]).toMatchObject({ type: 'resume', verified: true, verificationMethod: 'input-file-list' });

      expect(await findAdvanceControl(page)).toBeNull();
      expect(await findSubmitControl(page)).not.toBeNull();
      expect(await page.evaluate(() => window.submitAttempts)).toBe(0);
    }, 60000);
  }

  it('generic fixture exercises select, checkbox, radio, searchable combobox, and a revealed conditional question', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, `${FIXTURE}?ats=generic`);

    expect(await applyValue(page, {
      kind: 'select', selector: '#country', options: [{ label: 'United States', value: 'US' }],
    }, 'United States')).toMatchObject({ ok: true, action: 'select' });
    expect(await page.inputValue('#country')).toBe('US');

    expect(await applyValue(page, { kind: 'checkbox', selector: '#consent' }, 'Yes'))
      .toMatchObject({ ok: true, action: 'check' });
    expect(await page.isChecked('#consent')).toBe(true);
    expect(await page.isVisible('#conditional')).toBe(true);
    expect((await scanFields(page)).some((field) => field.selector === '#conditional')).toBe(true);

    expect(await applyValue(page, {
      kind: 'radio', selector: 'input[name="relocate"]',
      options: [
        { label: 'Yes', value: 'Yes', selector: '#relocate_yes' },
        { label: 'No', value: 'No', selector: '#relocate_no' },
      ],
    }, 'Yes')).toMatchObject({ ok: true, action: 'radio' });
    expect(await page.isChecked('#relocate_yes')).toBe(true);

    expect(await applyValue(page, {
      kind: 'combobox', selector: '#location', listboxSelector: '#location-list',
    }, 'Boston, MA')).toMatchObject({ ok: true, action: 'combobox' });
    expect(await page.inputValue('#location')).toBe('Boston, MA');

    // The option click is a widget interaction, not a final submission.
    expect(await page.evaluate(() => window.submitAttempts)).toBe(1);
  }, 60000);
});
