import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runGuided, parseSelection } from '../../src/cli/guided.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { listPending } from '../../src/apply/approvalQueue.js';
import { loadTestConfig } from './helpers/testConfig.js';
import * as F from './fixtures/jobs.js';

const base = loadTestConfig({ loadEnv: false, env: {} });

function makeCtx(root) {
  const db = openDatabase({ path: ':memory:' });
  const { logger: pino } = createPinoLogger({ toFile: false });
  const logger = new JobLogger({ db, logger: pino });
  const config = { ...base, root };
  return { db, logger, config };
}

// Two strong, sponsorship-clear roles -> both prepare into packets.
const sampleJobs = [F.azureFabricSenior, F.confirmedSponsorship, F.noSponsorship, F.juniorRole];
const searchFn = async () => ({ jobs: sampleJobs, duplicates: [], errors: [] });

/** A scripted prompt that answers each question in order. */
function scriptedPrompt(answers) {
  let i = 0;
  const ask = async () => answers[i++] ?? '';
  ask.calls = () => i;
  return ask;
}

describe('parseSelection', () => {
  it('handles all / none / numbers / ranges', () => {
    expect(parseSelection('a', 3)).toEqual([0, 1, 2]);
    expect(parseSelection('all', 3)).toEqual([0, 1, 2]);
    expect(parseSelection('', 3)).toEqual([]);
    expect(parseSelection('none', 3)).toEqual([]);
    expect(parseSelection('1,3', 3)).toEqual([0, 2]);
    expect(parseSelection('1 2', 3)).toEqual([0, 1]);
    expect(parseSelection('1-3', 5)).toEqual([0, 1, 2]);
    expect(parseSelection('2-1', 5)).toEqual([0, 1]); // reversed range still works
  });
  it('ignores out-of-range and junk, dedupes', () => {
    expect(parseSelection('0,9,2,2,foo', 3)).toEqual([1]);
  });
});

describe('runGuided', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'guided-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('prepares packets and refreshes the tracker in one pass', async () => {
    const { db, logger, config } = makeCtx(root);
    const r = await runGuided({
      config, db, logger,
      options: { prepareOnly: true },
      deps: { searchFn, now: F.NOW, stamp: 'test', interactive: false },
    });
    expect(r.prepared.counters.jobs_prepared).toBeGreaterThanOrEqual(1);
    // Tracker file is written.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(root, 'data', 'job_tracker.csv'))).toBe(true);
    db.close();
  });

  it('approves the chosen packets via the interactive prompt (no assist)', async () => {
    const { db, logger, config } = makeCtx(root);
    const assistCalls = [];
    const assistFn = async (args) => { assistCalls.push(args); return { status: 'filled', submitted: false, blockers: [] }; };
    const r = await runGuided({
      config, db, logger,
      options: {},
      // Answer "approve packet 1", then "no" to opening the browser.
      deps: { searchFn, now: F.NOW, stamp: 'test', interactive: true, prompt: scriptedPrompt(['1', 'n']), assistFn },
    });
    expect(r.approvedIds.length).toBe(1);
    expect(r.assisted).toBeNull();
    expect(assistCalls.length).toBe(0);
    // The approved packet is no longer pending.
    expect(listPending(db).length).toBe(r.prepared.counters.jobs_prepared - 1);
    db.close();
  });

  it('--yes approves all and runs assist automatically', async () => {
    const { db, logger, config } = makeCtx(root);
    const assistFn = async () => ({ status: 'filled', submitted: false, blockers: [] });
    const r = await runGuided({
      config, db, logger,
      options: { yes: true },
      deps: { searchFn, now: F.NOW, stamp: 'test', interactive: false, assistFn },
    });
    expect(r.approvedIds.length).toBe(r.prepared.counters.jobs_prepared);
    expect(r.assisted).not.toBeNull();
    expect(listPending(db).length).toBe(0);
    db.close();
  });

  it('non-interactive without --yes stops at the approval gate', async () => {
    const { db, logger, config } = makeCtx(root);
    const r = await runGuided({
      config, db, logger,
      options: {},
      deps: { searchFn, now: F.NOW, stamp: 'test', interactive: false },
    });
    expect(r.approvedIds).toEqual([]);
    expect(r.assisted).toBeNull();
    // Packets remain pending for later approval.
    expect(listPending(db).length).toBe(r.prepared.counters.jobs_prepared);
    db.close();
  });
});
