/**
 * Incremental discovery: "Find New Jobs" must not repeat deterministic scoring
 * work for records that are materially unchanged since the last run — and must
 * re-score a job whose description (or other material field) actually changed.
 * Pins the jobs_skipped_unchanged counter and the change-detection boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runPipeline } from '../../src/pipeline/index.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { loadTestConfig } from './helpers/testConfig.js';
import * as F from './fixtures/jobs.js';

const base = loadTestConfig({ loadEnv: false, env: {} });

describe('incremental discovery (skip materially-unchanged jobs)', () => {
  let root;
  let db;
  let logger;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'incremental-'));
    db = openDatabase({ path: ':memory:' });
    const { logger: pino } = createPinoLogger({ toFile: false });
    logger = new JobLogger({ db, logger: pino });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  const config = () => ({ ...base, root });
  const run = (jobs) => runPipeline({
    config: config(), db, logger, mode: 'DRY_RUN',
    deps: { searchFn: async () => ({ jobs, duplicates: [], errors: [] }), now: F.NOW, stamp: 't' },
  });

  it('second identical run skips scoring; a changed JD is re-scored', async () => {
    const first = await run([F.azureFabricSenior]);
    expect(first.counters.jobs_scored).toBe(1);
    expect(first.counters.jobs_skipped_unchanged).toBe(0);
    const scoredRow = db.getJob(F.azureFabricSenior.id);
    expect(scoredRow.score).not.toBeNull();

    // Identical rediscovery -> deterministic scoring is NOT repeated.
    const second = await run([F.azureFabricSenior]);
    expect(second.counters.jobs_skipped_unchanged).toBe(1);
    expect(second.counters.jobs_scored).toBe(0);

    // A materially changed description IS re-scored (content drives the score).
    const changed = { ...F.azureFabricSenior, jdText: `${F.azureFabricSenior.jdText} Now requires Airflow and dbt.` };
    const third = await run([changed]);
    expect(third.counters.jobs_skipped_unchanged).toBe(0);
    expect(third.counters.jobs_scored).toBe(1);
    const rescored = db.getJob(F.azureFabricSenior.id);
    expect(rescored.jd_text).toContain('Airflow');
  });

  it('never skips a job that was found but not yet scored', async () => {
    // Simulate a row persisted by a run that stopped before scoring.
    db.upsertJob({
      id: F.azureFabricSenior.id, source: F.azureFabricSenior.source,
      company: F.azureFabricSenior.company, title: F.azureFabricSenior.title,
      location: F.azureFabricSenior.location, url: F.azureFabricSenior.url,
      jd_text: F.azureFabricSenior.jdText, posted_at: F.azureFabricSenior.postedAt,
      employment_type: F.azureFabricSenior.employmentType, status: 'discovered',
    });
    const result = await run([F.azureFabricSenior]);
    expect(result.counters.jobs_skipped_unchanged).toBe(0);
    expect(result.counters.jobs_scored).toBe(1);
  });
});
