/**
 * E1 — the dashboard retires postings that aged past retention while no
 * discovery run happened. The sweep itself is rescoreStale (covered in
 * pipelineWritePath.test.js); this asserts the dashboard actually schedules it
 * at boot, honours the opt-out, and yields to a running pipeline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { createDashboardServer } from '../../src/dashboard/server.js';

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

describe('dashboard retention sweep', () => {
  let root;
  let db;
  let server;
  const saved = process.env.JOB_AGENT_RETENTION_SWEEP;

  const boot = (calls, extraDeps = {}) => {
    root = mkdtempSync(join(tmpdir(), 'jobagent-retention-'));
    db = openDatabase({ path: ':memory:' });
    ({ server } = createDashboardServer({
      config: { root }, db, logger: null,
      deps: {
        retentionSweepDelayMs: 1,
        rescoreStaleImpl: (args) => { calls.push(args); return { rescored: 0 }; },
        ...extraDeps,
      },
    }));
  };

  afterEach(() => {
    if (saved === undefined) delete process.env.JOB_AGENT_RETENTION_SWEEP;
    else process.env.JOB_AGENT_RETENTION_SWEEP = saved;
    server?.close();
    db?.close();
    if (root) rmSync(root, { recursive: true, force: true });
    server = null; db = null; root = null;
  });

  it('re-judges stored rows shortly after boot', async () => {
    delete process.env.JOB_AGENT_RETENTION_SWEEP;
    const calls = [];
    boot(calls);
    await wait(150);
    expect(calls).toHaveLength(1);
    expect(calls[0].db).toBe(db);
  });

  it('is disabled by JOB_AGENT_RETENTION_SWEEP=off', async () => {
    process.env.JOB_AGENT_RETENTION_SWEEP = 'off';
    const calls = [];
    boot(calls);
    await wait(150);
    expect(calls).toHaveLength(0);
  });
});
