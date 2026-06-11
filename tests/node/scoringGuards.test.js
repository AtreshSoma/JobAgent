/**
 * Scoring guardrails — the board must never over-rank roles the candidate
 * cannot or should not pursue: no-sponsorship roles, contract-only (C2C)
 * postings, unrelated management roles, and unrelated stacks.
 */
import { describe, it, expect } from 'vitest';

import { runPipeline } from '../../src/pipeline/index.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { normalizeJob } from '../../src/search/normalize.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as F from './fixtures/jobs.js';

const base = loadConfig({ loadEnv: false, env: {} });

const noSponsorship = F.noSponsorship; // "US citizens only; we are unable to sponsor visas"

const c2cOnly = normalizeJob({
  source: 'manual', company: 'StaffCo', title: 'Senior Data Engineer',
  sourceJobId: 'C2C-1', postedAt: '2026-06-01T00:00:00Z',
  jdText: 'Corp to corp only. C2C contract position, 3 months. Azure, PySpark, SQL.',
});

const unrelatedManager = normalizeJob({
  source: 'manual', company: 'BigCo', title: 'Engineering Manager, Mobile Apps',
  sourceJobId: 'MGR-1', postedAt: '2026-06-01T00:00:00Z',
  jdText: 'Lead a team of iOS and Android engineers. People management, Swift, Kotlin, roadmaps.',
});

async function runWith(jobs) {
  const root = mkdtempSync(join(tmpdir(), 'guards-'));
  const db = openDatabase({ path: ':memory:' });
  const { logger: pino } = createPinoLogger({ toFile: false });
  const logger = new JobLogger({ db, logger: pino });
  const config = { ...base, root };
  try {
    await runPipeline({
      config, db, logger, mode: 'DRY_RUN',
      deps: { searchFn: async () => ({ jobs, duplicates: [], errors: [] }), now: F.NOW, stamp: 'g' },
    });
    return { db, cleanup: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
  } catch (err) {
    db.close(); rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

describe('scoring guardrails', () => {
  it('a no-sponsorship role is hard-excluded, never queued', async () => {
    const { db, cleanup } = await runWith([noSponsorship]);
    try {
      const row = db.getJob(noSponsorship.id);
      expect(row.status).toBe('discarded');
      expect(row.discard_reason).toContain('sponsorship');
    } finally { cleanup(); }
  });

  it('a contract-only (C2C) role is hard-excluded', async () => {
    const { db, cleanup } = await runWith([c2cOnly]);
    try {
      const row = db.getJob(c2cOnly.id);
      expect(row.status).toBe('discarded');
    } finally { cleanup(); }
  });

  it('an unrelated mobile-engineering manager role never reaches an actionable tier', async () => {
    const { db, cleanup } = await runWith([unrelatedManager]);
    try {
      const row = db.getJob(unrelatedManager.id);
      // Whatever path it takes (excluded or scored low), it must NOT be
      // Priority/Apply/Queue — those drive packets and assisted applies.
      expect(['Priority', 'Apply', 'Queue']).not.toContain(row.tier);
    } finally { cleanup(); }
  });

  it('a genuinely strong Azure DE role still ranks at the top (no over-correction)', async () => {
    const { db, cleanup } = await runWith([F.azureFabricSenior, unrelatedManager, c2cOnly]);
    try {
      const strong = db.getJob(F.azureFabricSenior.id);
      expect(['Priority', 'Apply']).toContain(strong.tier);
      expect(strong.score).toBeGreaterThanOrEqual(75);
    } finally { cleanup(); }
  });
});
