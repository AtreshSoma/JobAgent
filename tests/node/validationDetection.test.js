/**
 * Regression: the runner must DETECT an ATS step rejection instead of blindly
 * looping. The fixture simulates the classic case — clicking "Next" does not
 * navigate; the same page re-renders with the field marked aria-invalid and a
 * visible role="alert" error (here: a salary question the agent correctly
 * refuses to guess).
 *
 * Expected workflow: Fill -> Advance -> detect validation errors -> BLOCKED
 * with the exact error text, browser session preserved for the human.
 *
 * Drives REAL Chromium against a LOCAL file:// fixture. Self-skips when
 * Chromium is unavailable. Never touches a real ATS and never submits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { createBrowserSession, openApplicationPage } from '../../src/automation/browser.js';
import { detectValidationErrors } from '../../src/automation/domScanner.js';
import { assistApply } from '../../src/automation/applyRunner.js';
import { packetOwner } from '../../src/apply/applicationPacket.js';
import { loadTestConfig } from './helpers/testConfig.js';

const FIXTURES = join(process.cwd(), 'tests', 'node', 'fixtures');
const FORM_URL = pathToFileURL(join(FIXTURES, 'validation_error_form.html')).href;

const config = loadTestConfig({ loadEnv: false, env: {} });

describe('validation-error detection (real browser)', () => {
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

  it('detectValidationErrors sees nothing on a pristine form, then the exact rejection after Next', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, FORM_URL);
    expect(await detectValidationErrors(page)).toEqual([]);

    await page.click('#next-btn');
    const errors = await detectValidationErrors(page);
    expect(errors.join(' ')).toContain('Salary expectation is required');
    expect(errors.some((e) => e.startsWith('invalid field:'))).toBe(true);
  }, 60000);

  it('assistApply ends BLOCKED with the validation error and a phase trail (never loops, never submits)', async (ctx) => {
    if (!available) return ctx.skip();

    const packet = {
      job: { id: 'fixture-validation', company: 'Acme', title: 'DE', url: FORM_URL },
      owner: packetOwner(config),
      blockers: [],
      screeningPlan: { answered: [], needsUser: [] },
      fillPlan: {
        fields: [
          { field: 'first_name', selector: '#first_name', value: 'Priya', required: true, source: 'profile' },
          { field: 'email', selector: '#email', value: 'a@example.com', required: true, source: 'profile' },
        ],
        uploads: [],
      },
    };

    const result = await assistApply({
      packet,
      // Real candidate profile (fills name/email), but NO screening answers —
      // so the agent correctly leaves the salary field empty and the fixture
      // rejects the step.
      config: {
        ...config,
        screeningAnswers: {},
        runtime: { ...config.runtime, headless: true },
      },
      mode: 'LIVE_ASSIST',
      // This test asserts a fresh-run phase trail; durable resume behavior has
      // dedicated temp/memory-store coverage in applicationResume.test.js.
      options: { headless: true, maxSteps: 4, statePath: false },
      deps: { createSession: async () => session },
    });

    // The step was rejected in place -> blocked with the ATS's own error text.
    expect(result.status).toBe('assist_blocked');
    expect(result.blockers.join(' ')).toContain('Salary expectation is required');
    expect(result.submitted).toBe(false);

    // The phase trail records the resumable workflow up to the block.
    const names = result.phases.map((p) => p.phase);
    expect(names[0]).toBe('queued');
    expect(names).toContain('precheck');
    expect(names).toContain('opening');
    expect(names).toContain('filling');
    expect(names).toContain('advancing');
    expect(names[names.length - 1]).toBe('blocked');
  }, 60000);
});
