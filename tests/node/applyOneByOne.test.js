import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runGuided } from '../../src/cli/guided.js';
import { runApply } from '../../src/cli/applyOneByOne.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { listPending, approve } from '../../src/apply/approvalQueue.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import * as F from './fixtures/jobs.js';

const base = loadConfig({ loadEnv: false, env: {} });

function makeCtx(root) {
  const db = openDatabase({ path: ':memory:' });
  const { logger: pino } = createPinoLogger({ toFile: false });
  const logger = new JobLogger({ db, logger: pino });
  const config = { ...base, root };
  return { db, logger, config };
}

const sampleJobs = [
  { ...F.azureFabricSenior, url: 'https://jobs.example.com/acme/senior-data-engineer' },
  { ...F.confirmedSponsorship, url: 'https://jobs.example.com/globex/lead-data-engineer' },
];
const searchFn = async () => ({ jobs: sampleJobs, duplicates: [], errors: [] });

/** A scripted prompt that answers each question in order. */
function scriptedPrompt(answers) {
  let i = 0;
  const ask = async () => answers[i++] ?? '';
  ask.calls = () => i;
  return ask;
}

/** Prepare packets and approve them all; returns the ctx. */
async function prepareAndApprove(root) {
  const ctx = makeCtx(root);
  await runGuided({
    config: ctx.config, db: ctx.db, logger: ctx.logger,
    options: { prepareOnly: true },
    deps: { searchFn, now: F.NOW, stamp: 'test', interactive: false },
  });
  for (const row of listPending(ctx.db)) approve(ctx.db, row.id);
  return ctx;
}

describe('runApply (one at a time)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'apply-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('opens approved applications sequentially, never two browsers at once', async () => {
    const { db, logger, config } = await prepareAndApprove(root);

    let live = 0; let maxLive = 0;
    const createSession = async () => {
      live += 1; maxLive = Math.max(maxLive, live);
      return { close: async () => { live -= 1; } };
    };
    const calls = [];
    const assistFn = async (args) => {
      // Mirror the real runner: it creates a session via the injected dep and
      // leaves it open for the human to review.
      await args.deps.createSession({});
      calls.push(args.packet.job.id);
      return {
        status: 'ready_for_submit', submitted: false, sessionLeftOpen: true,
        filled: [{ field: 'name' }], unresolved: [], uploads: { uploaded: ['resume'] }, blockers: [],
      };
    };

    const r = await runApply({
      config, db, logger,
      options: {},
      deps: {
        interactive: true,
        prompt: scriptedPrompt(['all', '', '']), // select all, then Enter per job
        assistFn, createSession,
      },
    });

    expect(calls.length).toBe(2);
    expect(r.results.length).toBe(2);
    expect(maxLive).toBe(1);   // never more than one browser open
    expect(live).toBe(0);      // every browser was closed afterwards
    db.close();
  });

  it('lets the user pick a subset by number', async () => {
    const { db, logger, config } = await prepareAndApprove(root);
    const calls = [];
    const assistFn = async (args) => {
      calls.push(args.packet.job.id);
      return { status: 'ready_for_submit', submitted: false, filled: [], unresolved: [], uploads: { uploaded: [] }, blockers: [] };
    };

    const r = await runApply({
      config, db, logger,
      options: {},
      deps: { interactive: true, prompt: scriptedPrompt(['2', '']), assistFn },
    });

    expect(calls.length).toBe(1);
    expect(r.results.length).toBe(1);
    db.close();
  });

  it('guides the user to approve first when nothing is approved', async () => {
    const ctx = makeCtx(root);
    await runGuided({
      config: ctx.config, db: ctx.db, logger: ctx.logger,
      options: { prepareOnly: true },
      deps: { searchFn, now: F.NOW, stamp: 'test', interactive: false },
    });
    let assisted = 0;
    const assistFn = async () => { assisted += 1; return { status: 'x' }; };

    const r = await runApply({
      config: ctx.config, db: ctx.db, logger: ctx.logger,
      options: {},
      deps: { interactive: true, prompt: scriptedPrompt(['all']), assistFn },
    });

    expect(assisted).toBe(0);       // nothing approved -> nothing opened
    expect(r.results).toEqual([]);
    ctx.db.close();
  });
});

describe('runApply records applied vs skipped', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'apply-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const assistFn = async (args) => {
    if (args.deps?.createSession) await args.deps.createSession({});
    return {
      status: 'ready_for_submit', submitted: false, sessionLeftOpen: true,
      filled: [{ field: 'name' }], unresolved: [], uploads: { uploaded: ['resume'] }, blockers: [],
    };
  };

  it('marks a job Submitted when the user answers "s"', async () => {
    const { db, logger, config } = await prepareAndApprove(root);

    await runApply({
      config, db, logger,
      options: {},
      deps: {
        interactive: true,
        // select first job, then "s" (submitted)
        prompt: scriptedPrompt(['1', 's']),
        assistFn,
        createSession: async () => ({ close: async () => {} }),
        now: () => new Date('2024-01-02T00:00:00.000Z'),
      },
    });

    const applied = db.listJobs({ status: 'submitted' });
    expect(applied.length).toBe(1);
    expect(applied[0].applied).toBe(1);
    expect(applied[0].applied_at).toContain('2024-01-02');
    db.close();
  });

  it('marks a job Skipped when the user answers "k"', async () => {
    const { db, logger, config } = await prepareAndApprove(root);

    await runApply({
      config, db, logger,
      options: {},
      deps: {
        interactive: true,
        prompt: scriptedPrompt(['1', 'k']),
        assistFn,
        createSession: async () => ({ close: async () => {} }),
      },
    });

    const skipped = db.listJobs({ status: 'skipped' });
    expect(skipped.length).toBe(1);
    expect(skipped[0].applied).toBeFalsy();
    db.close();
  });

  it('stops the walk when the user answers "q"', async () => {
    const { db, logger, config } = await prepareAndApprove(root);
    const calls = [];
    const counting = async (args) => { calls.push(args.packet.job.id); return assistFn(args); };

    const r = await runApply({
      config, db, logger,
      options: {},
      deps: {
        interactive: true,
        // select all, quit after the first job
        prompt: scriptedPrompt(['all', 'q']),
        assistFn: counting,
        createSession: async () => ({ close: async () => {} }),
      },
    });

    expect(calls.length).toBe(1);     // stopped after the first
    expect(r.results.length).toBe(1);
    db.close();
  });
});
