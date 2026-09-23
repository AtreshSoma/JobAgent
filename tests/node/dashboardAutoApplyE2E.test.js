import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';

describe('dashboard Auto-fill browser flow', () => {
  let browser;

  beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
  // Full-suite Windows runs can take longer to reap Chromium after every
  // context has closed, especially while Python tests are running in parallel.
  afterAll(async () => { await browser?.close(); }, 30_000);

  it('fills an Unconfirmed-sponsorship job for review without entering Auto-submit precheck', async () => {
    const db = openDatabase({ path: ':memory:' });
    const packet = {
      id: 'packet-j1',
      job: { id: 'j1', company: 'Acme', title: 'Data Engineer', url: 'https://careers.acme.test/jobs/1' },
      ats: { platform: 'greenhouse' },
      blockers: [],
      resumePath: 'resumes/output/tailored.docx',
      resumeTailored: true,
      resumeValidation: { ok: true, word_count: 650 },
      tailoring: { changes: [{ type: 'emphasize' }], gaps: [] },
      atsReport: { match_score: 84, band: 'strong', ats_safety: { ok: true, issues: [] } },
      prefill: { plan: [], needsUser: [] },
      screeningPlan: { answered: [], needsUser: [] },
      uploads: { blockers: [] },
      stopBeforeSubmit: true,
      submitReady: false,
    };
    db.upsertJob({
      id: 'j1', company: 'Acme', title: 'Data Engineer',
      url: 'https://careers.acme.test/jobs/1', source: 'greenhouse',
      score: 86, tier: 'Priority', sponsorship: 'Unconfirmed', status: 'prepared',
      application_packet_path: 'packet-j1.json', resume_path: packet.resumePath,
      posted_at: '2026-07-22T12:00:00Z', created_at: '2026-07-22T12:00:00Z',
    });
    db.insertApproval({
      id: 'approval-j1', job_id: 'j1', packet_path: 'packet-j1.json',
      approval_status: 'pending_review', approved_by_user: 0,
    });

    let receivedOptions = null;
    const dash = await startDashboard({
      config: { root: process.cwd(), jobboards: { sources: [] } },
      db, logger: null, port: 0,
      deps: {
        now: () => new Date('2026-07-22T15:00:00Z'),
        readFileImpl: () => JSON.stringify(packet),
        loadPacketImpl: () => structuredClone(packet),
        assistFn: async ({ options }) => {
          receivedOptions = options;
          return { status: 'ready_for_submit', submitted: false, filled: [{ field: 'email' }], blockers: [] };
        },
        writeJobTrackerImpl: () => ({ path: 'job_tracker.csv' }),
      },
    });

    const page = await browser.newPage();
    const dialogs = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    try {
      await page.goto(dash.url, { waitUntil: 'networkidle' });
      // The dashboard lands on Today; the board is the "All jobs" view.
      await page.getByRole('button', { name: 'All jobs', exact: true }).click();
      await page.getByRole('row', { name: /Acme.*Data Engineer/ }).click();
      await page.getByRole('button', { name: /Auto-fill application/ }).first().click();

      await expect.poll(() => receivedOptions).toMatchObject({ autoSubmit: false });
      await expect.poll(() => db.getJob('j1').status).toBe('ready_for_submit');
      expect(Number(db.getJob('j1').applied)).toBe(0);
      expect(db.getApprovalByJob('j1').approval_status).toBe('approved');
      // No native browser dialogs: confirmations use an in-page <dialog>, and
      // an ordinary Auto-fill must never prompt about auto-submit at all.
      expect(dialogs).toEqual([]);
      expect(await page.locator('#toasts').textContent()).not.toMatch(/Auto-submit precheck/i);
    } finally {
      await page.close();
      await dash.close();
      db.close();
    }
  }, 30_000);
});
