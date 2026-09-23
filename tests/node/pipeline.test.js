import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPipeline } from '../../src/pipeline/index.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { listPending } from '../../src/apply/approvalQueue.js';
import { loadTestConfig } from './helpers/testConfig.js';
import { parseArgs, resolveMode, main } from '../../src/index.js';
import * as F from './fixtures/jobs.js';

const base = loadTestConfig({ loadEnv: false, env: {} });

function makeCtx(root) {
  const db = openDatabase({ path: ':memory:' });
  const { logger: pino } = createPinoLogger({ toFile: false });
  const logger = new JobLogger({ db, logger: pino });
  const config = { ...base, root };
  return { db, logger, config };
}

describe('CLI arg parsing', () => {
  it('parses flags and options', () => {
    const parsed = parseArgs(['--mode=PREPARE', '--report']);
    expect(parsed.options.mode).toBe('PREPARE');
    expect(parsed.flags.has('report')).toBe(true);
  });
  it('resolves modes with fallback', () => {
    expect(resolveMode(parseArgs(['--mode=PREPARE']), {})).toBe('PREPARE');
    expect(resolveMode(parseArgs(['--report']), {})).toBe('REPORT');
    // An unknown mode is an error now, never a silent DRY_RUN (see cliEntry.test.js).
    expect(() => resolveMode(parseArgs(['--mode=BOGUS']), {})).toThrow(/unknown run mode/);
    expect(resolveMode(parseArgs([]), { RUN_MODE: 'LIVE_ASSIST' })).toBe('LIVE_ASSIST');
  });

  // Regression: a typo'd command used to fall through to a full legacy
  // DRY_RUN pipeline run. It must fail fast with the list of known commands.
  it('rejects unknown commands instead of silently running the pipeline', async () => {
    await expect(main(['scor'], {})).rejects.toThrow(/unknown command "scor"/);
    await expect(main(['scor'], {})).rejects.toThrow(/score/); // lists known commands
  });
});

describe('runPipeline', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pipeline-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const sampleJobs = [F.azureFabricSenior, F.confirmedSponsorship, F.noSponsorship, F.juniorRole, F.snowflakeMismatch, F.staleHighApplicants];
  const searchFn = async () => ({ jobs: sampleJobs, duplicates: [], errors: [] });

  it('runs with no logger at all instead of crashing on the first event', async () => {
    // `startDashboard({ logger })` threads whatever it is handed straight into
    // this function, and it made ten UNGUARDED `logger.event(...)` calls while
    // every other caller in the repo uses `logger?.event?.()`. Passing null
    // therefore killed discovery on its very first line with "Cannot read
    // properties of null (reading 'event')", reported as an RCA category of
    // "unknown" — found by clicking "Find new jobs" in a running dashboard.
    //
    // Event logging is diagnostics. Losing it must degrade the run, never end it.
    const { db, config } = makeCtx(root);
    const result = await runPipeline({
      config, db, logger: null, mode: 'DRY_RUN',
      deps: { searchFn, now: F.NOW, stamp: 'nolog' },
    });
    expect(result.counters.jobs_found).toBe(sampleJobs.length);
    expect(existsSync(result.report.files.json)).toBe(true);
    db.close();
  });

  it('DRY_RUN scores and reports without preparing packets', async () => {
    const { db, logger, config } = makeCtx(root);
    const result = await runPipeline({ config, db, logger, mode: 'DRY_RUN', deps: { searchFn, now: F.NOW, stamp: 'test' } });

    expect(result.counters.jobs_found).toBe(sampleJobs.length);
    // No-sponsorship + junior + stale are hard-excluded.
    expect(result.counters.jobs_discarded).toBeGreaterThanOrEqual(3);
    // DRY_RUN prepares nothing.
    expect(result.counters.jobs_prepared).toBe(0);
    expect(listPending(db).length).toBe(0);
    expect(existsSync(result.report.files.json)).toBe(true);
    // Discovery audit trail is written for visibility.
    const foundPath = join(root, 'data', 'found_jobs.json');
    expect(existsSync(foundPath)).toBe(true);
    const found = JSON.parse(readFileSync(foundPath, 'utf8'));
    expect(found.jobs.length).toBe(sampleJobs.length);
    expect(found.jobs.every((j) => ['strong', 'weak', 'no_match', 'unknown'].includes(j.discoveryMatch))).toBe(true);
    // Report carries a per-source breakdown.
    const summary = JSON.parse(readFileSync(result.report.files.json, 'utf8'));
    expect(summary.bySource).toBeDefined();
    db.close();
  });

  it('PREPARE builds packets for strong roles and enqueues them for approval', async () => {
    const { db, logger, config } = makeCtx(root);
    const result = await runPipeline({ config, db, logger, mode: 'PREPARE', deps: { searchFn, now: F.NOW, stamp: 'test' } });

    expect(result.counters.jobs_prepared).toBeGreaterThanOrEqual(1);
    const pending = listPending(db);
    expect(pending.length).toBe(result.counters.jobs_prepared);
    // Every queued packet is pending review (never auto-approved).
    expect(pending.every((p) => p.approval_status === 'pending_review')).toBe(true);
    expect(pending.every((p) => p.approved_by_user === 0)).toBe(true);

    // Packets are written into the professional applications/output tree, never
    // into the flat resumes/output folder.
    const prepared = db.getJob(pending[0].job_id);
    const packetRel = prepared.application_packet_path.replace(root, '');
    expect(packetRel).toContain(join('applications', 'output'));
    expect(packetRel).toMatch(/Application_Packet_.*\.json$/);
    expect(prepared.output_folder_path).toContain(join('applications', 'output'));
    expect(prepared.application_packet_path).not.toContain(join('resumes', 'output'));
    expect(existsSync(prepared.application_packet_path)).toBe(true);
    db.close();
  });

  it('never excludes a job that was hard-excluded from scoring', async () => {
    const { db, logger, config } = makeCtx(root);
    await runPipeline({ config, db, logger, mode: 'DRY_RUN', deps: { searchFn, now: F.NOW, stamp: 'test' } });
    const noSpon = db.getJob(F.noSponsorship.id);
    expect(noSpon.status).toBe('discarded');
    expect(noSpon.discard_reason).toContain('sponsorship_denial');
    db.close();
  });

  it('incremental discovery skips deterministic re-scoring for unchanged jobs', async () => {
    const { db, logger, config } = makeCtx(root);
    const first = await runPipeline({ config, db, logger, mode: 'DRY_RUN', deps: { searchFn, now: F.NOW, stamp: 'first' } });
    expect(first.counters.jobs_scored).toBeGreaterThan(0);

    const second = await runPipeline({ config, db, logger, mode: 'DRY_RUN', deps: { searchFn, now: F.NOW, stamp: 'second' } });
    expect(second.counters.jobs_scored).toBe(0);
    expect(second.counters.jobs_skipped_unchanged).toBe(first.counters.jobs_scored);
    db.close();
  });

  it('cancels before scoring and records the partial checkpoint', async () => {
    const { db, logger, config } = makeCtx(root);
    const result = await runPipeline({
      config, db, logger, mode: 'DRY_RUN',
      deps: { searchFn, now: F.NOW, stamp: 'cancelled', shouldCancel: () => true },
    });
    expect(result.counters.jobs_scored).toBe(0);
    expect(result.counters.jobs_cancelled).toBeGreaterThan(0);
    db.close();
  });
});
