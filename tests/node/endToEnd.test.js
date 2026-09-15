/**
 * Fixture-only end-to-end pipeline test.
 *
 * Runs the REAL pipeline — discovery → exclusion → sponsorship → scoring →
 * resume tailoring → cover letter → ATS detection → form prefill → packet
 * (review bundle) → approval queue → tracker — entirely offline:
 *
 *   - discovery is a stubbed searchFn returning fixture jobs (no network)
 *   - tailoring is an injected tailorFn that writes a real file (no Python)
 *   - the DB is in-memory; all artifacts go to a temp root
 *
 * It asserts the safety invariants end to end: nothing is auto-approved,
 * nothing is submit-ready, every artifact traces back to its source job, and
 * candidate values in the prefill plan come from config (never fabricated).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPipeline } from '../../src/pipeline/index.js';
import { runAssist } from '../../src/cli/commands.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { listPending, approve } from '../../src/apply/approvalQueue.js';
import { writeJobTracker } from '../../src/reports/jobTracker.js';
import { loadTestConfig } from './helpers/testConfig.js';
import * as F from './fixtures/jobs.js';

const base = loadTestConfig({ loadEnv: false, env: {} });

/** A strong job carrying real ATS form fields so prefill/ATS mapping runs. */
const greenhouseJob = {
  ...F.azureFabricSenior,
  url: 'https://boards.greenhouse.io/acme/jobs/12345',
  html: '<html><body><div class="gh_jid">apply</div></body></html>',
  formFields: [
    { label: 'First name', selector: '#first_name' },
    { label: 'Last name', selector: '#last_name' },
    { label: 'Email', selector: '#email' },
    { label: 'Phone', selector: '#phone' },
    { label: 'City', selector: '#city' },
    { label: 'LinkedIn', selector: '#linkedin' },
    // No config answer exists for this -> must surface as needs-user, never guessed.
    { label: 'Describe your most complex outage', selector: '#essay' },
  ],
};

const sampleJobs = [greenhouseJob, F.confirmedSponsorship, F.noSponsorship, F.juniorRole];
const searchFn = async () => ({ jobs: sampleJobs, duplicates: [], errors: [] });

/** Deterministic offline stand-in for the Python tailor: writes a real file. */
async function tailorFn({ job, options = {} }) {
  const dir = options.outputDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, options.outputFilename ?? 'tailored.docx');
  writeFileSync(path, `tailored resume for ${job.company} ${job.title}`, 'utf8');
  return {
    tailored: true, output_path: path, pdf_path: null, emphasized: 3,
    validation: { ok: true, issues: [] }, warning: null, usedFallback: false,
  };
}

describe('end-to-end pipeline (fixtures only, fully offline)', () => {
  let root;
  let db;
  let logger;
  let config;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'e2e-'));
    db = openDatabase({ path: ':memory:' });
    const { logger: pino } = createPinoLogger({ toFile: false });
    logger = new JobLogger({ db, logger: pino });
    config = { ...base, root };
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('discovery → scoring → tailoring → ATS prefill → review bundle', async () => {
    const result = await runPipeline({
      config, db, logger, mode: 'PREPARE',
      deps: { searchFn, tailorFn, now: F.NOW, stamp: 'e2e' },
    });

    // Discovery + scoring: counters reconcile with the fixture set.
    expect(result.counters.jobs_found).toBe(sampleJobs.length);
    expect(result.counters.jobs_scored).toBeGreaterThanOrEqual(2);
    expect(result.counters.jobs_prepared).toBeGreaterThanOrEqual(1);

    // All four pipeline artifacts exist and parse.
    for (const file of ['found_jobs.json', 'scored_jobs.json', 'queued_jobs.json', 'unknown_date_review.json']) {
      expect(existsSync(join(root, 'data', file))).toBe(true);
      JSON.parse(readFileSync(join(root, 'data', file), 'utf8'));
    }
    // Report bundle (json/csv/html) exists.
    expect(existsSync(result.report.files.json)).toBe(true);
    expect(existsSync(result.report.files.csv)).toBe(true);
    expect(existsSync(result.report.files.html)).toBe(true);

    // The greenhouse job produced a packet: load and inspect the review bundle.
    const jobRow = db.getJob(greenhouseJob.id);
    expect(jobRow.status).toBe('prepared');
    const packet = JSON.parse(readFileSync(jobRow.application_packet_path, 'utf8'));

    // Traceability: the packet points back at the exact source job.
    expect(packet.job.id).toBe(greenhouseJob.id);
    expect(packet.job.url).toBe(greenhouseJob.url);
    expect(packet.job.source).toBe('greenhouse');

    // ATS detection ran against the job URL/html.
    expect(packet.ats.platform).toBe('greenhouse');

    // Tailored resume was written inside this job's output folder and recorded.
    expect(packet.resumeTailored).toBe(true);
    expect(existsSync(packet.resumePath)).toBe(true);
    expect(packet.resumePath.startsWith(join(root, 'applications', 'output'))).toBe(true);

    // Prefill plan: every value comes from config/candidate.json, verbatim.
    const byField = Object.fromEntries(packet.prefill.plan.map((p) => [p.label, p.value]));
    expect(byField['First name']).toBe(base.candidate.identity.fullName.split(' ')[0]);
    expect(byField.Email).toBe(base.candidate.contact.email);
    expect(byField.Phone).toBe(base.candidate.contact.phone);
    expect(byField.City).toBe(base.candidate.location.city);
    expect(byField.LinkedIn).toBe(base.candidate.identity.links.linkedin);

    // The unanswerable essay question is surfaced for the human, never guessed.
    const needsUser = packet.prefill.needsUser.map((n) => n.label);
    expect(needsUser).toContain('Describe your most complex outage');
    expect(packet.blockers.some((b) => b.includes('screening field'))).toBe(true);

    // Safety invariants: pending review, never submit-ready.
    expect(packet.approvalStatus).toBe('pending_review');
    expect(packet.stopBeforeSubmit).toBe(true);
    expect(packet.submitReady).toBe(false);

    // The hard-excluded jobs were discarded with reasons, not silently dropped.
    expect(db.getJob(F.noSponsorship.id).status).toBe('discarded');
    expect(db.getJob(F.noSponsorship.id).discard_reason).toContain('sponsorship');
    expect(db.getJob(F.juniorRole.id).status).toBe('discarded');

    // Approval queue holds exactly the prepared packets, all pending.
    const pending = listPending(db);
    expect(pending.length).toBe(result.counters.jobs_prepared);
    expect(pending.every((p) => p.approved_by_user === 0)).toBe(true);

    // Tracker (review spreadsheet) reflects the prepared state.
    const tracker = writeJobTracker(db, root);
    expect(tracker.total).toBe(sampleJobs.length);
    expect(tracker.prepared).toBe(result.counters.jobs_prepared);
    expect(tracker.submitted).toBe(0);
    const csv = readFileSync(tracker.path, 'utf8');
    expect(csv).toContain('Prepared — awaiting your approval');
    expect(csv).not.toContain('Submitted\n'); // nothing reads as submitted

    // Human approves one packet; assist runs with a stubbed browser step and
    // still never submits.
    approve(db, pending[0].id);
    const assistFn = async ({ packet: p }) => ({
      status: 'ready_for_submit', blockers: p.blockers, jobId: p.job.id,
    });
    const assisted = await runAssist({ config, db, logger, deps: { assistFn } });
    expect(assisted.counters.jobs_assisted).toBe(1);
    expect(assisted.results[0].status).toBe('ready_for_submit');
    // The job is filled-but-not-submitted; applied stays 0.
    const after = db.getJob(pending[0].job_id);
    expect(after.status).toBe('ready_for_submit');
    expect(Number(after.applied)).toBe(0);
  });

  it('DRY_RUN never tailors, prepares, or touches the approval queue', async () => {
    let tailorCalls = 0;
    const countingTailor = async (args) => { tailorCalls += 1; return tailorFn(args); };
    const result = await runPipeline({
      config, db, logger, mode: 'DRY_RUN',
      deps: { searchFn, tailorFn: countingTailor, now: F.NOW, stamp: 'e2e' },
    });
    expect(tailorCalls).toBe(0);
    expect(result.counters.jobs_prepared).toBe(0);
    expect(listPending(db).length).toBe(0);
  });
});
