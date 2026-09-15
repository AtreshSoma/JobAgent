/**
 * Real-browser end-to-end validation of the field classifier + filler against a
 * Workday-style form that reproduces three production bugs seen in the wild:
 *
 *   1. "Legal First and Last Name" was filled with only the surname.
 *   2. A long sponsorship question ("…visa to work in the United States?") and a
 *      legal acknowledgement ("…understand the stated responsibilities…") were
 *      misclassified as the State field and filled with the candidate's State,
 *      because "state" matched inside "States"/"stated".
 *   3. The sponsorship dropdown was therefore never answered "Yes".
 *
 * Drives REAL Chromium against a LOCAL file:// fixture. Self-skips if Chromium
 * is unavailable. Never touches a real ATS and never submits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { createBrowserSession, openApplicationPage } from '../../src/automation/browser.js';
import { scanFields, resolveFormScope } from '../../src/automation/domScanner.js';
import { fillScannedFields } from '../../src/automation/fieldFiller.js';
import { loadTestConfig } from './helpers/testConfig.js';

const FIXTURES = join(process.cwd(), 'tests', 'node', 'fixtures');
const FORM_URL = pathToFileURL(join(FIXTURES, 'workday_style_form.html')).href;

const { candidate, screeningAnswers } = loadTestConfig({ loadEnv: false, env: {} });

describe('Workday-style form filling (real browser)', () => {
  let session;
  let available = true;

  beforeAll(async () => {
    try {
      session = await createBrowserSession({ headless: true });
    } catch {
      available = false;
    }
  }, 60000);

  afterAll(async () => { await session?.close?.(); }, 30000);

  it('fills a combined name with the FULL name, answers sponsorship Yes, and never leaks the State', async (ctx) => {
    if (!available) return ctx.skip();
    const { page } = session;
    await openApplicationPage(page, FORM_URL);
    const scope = await resolveFormScope(page);
    const scanned = await scanFields(scope);
    const dyn = await fillScannedFields(scope, scanned, { candidate, screeningAnswers });

    // 1. Combined "Legal First and Last Name" gets the candidate's full name.
    expect(await scope.locator('#legal_name').inputValue()).toBe(candidate.identity.fullName);

    // 2. Long sponsorship question is answered "Yes" (mapped to the select option).
    expect(await scope.locator('#sponsor').inputValue()).toBe('Yes');

    // 3. The work-authorization question is answered truthfully from config.
    expect(await scope.locator('#work_auth').inputValue().then((v) => v.toLowerCase()))
      .toMatch(/authorized to work/);

    // 4. The genuine State field still fills correctly.
    expect(await scope.locator('#state').inputValue()).toBe(candidate.location.state);

    // 5. The acknowledgement must be LEFT BLANK — never filled with the State or
    //    any other profile value (the core regression).
    expect(await scope.locator('#ack').inputValue()).toBe('');

    // The acknowledgement (no confident answer) is reported for the human.
    const ackNeedsUser = dyn.needsUser.some((nu) => /acknowledge/i.test(nu.label));
    expect(ackNeedsUser).toBe(true);

    // Defense-in-depth: the candidate's State appears in the real State field ONLY.
    for (const sel of ['#legal_name', '#work_auth', '#ack', '#sponsor']) {
      expect(await scope.locator(sel).inputValue().then((v) => v.toLowerCase()))
        .not.toContain(candidate.location.state.toLowerCase());
    }
  }, 60000);
});
