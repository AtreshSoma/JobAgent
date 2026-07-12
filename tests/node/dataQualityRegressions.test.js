/**
 * Regression tests for the 2026-07 data-quality audit.
 *
 * Each block pins the fix for a defect that was reproduced on real data
 * (24,917 tracked jobs, 12 visible strong matches):
 *   1. computeMissing was alias-blind: a skill could appear in BOTH
 *      matchedKeywords and missingKeywords (e.g. JD says "ADF", profile says
 *      "Azure Data Factory").
 *   2. Greenhouse used updated_at as the posting date, so any board edit made
 *      months-old reqs look freshly posted.
 *   3. The default freshness window (3 days) hard-discarded >75% of scoreable
 *      jobs before ranking; default is now LAST_7_DAYS.
 *   4. The pipeline auto-prepared Queue-tier jobs (153 medium-fit packets vs
 *      8 strong); Queue is human-selected only now.
 *   5. The dashboard hid sponsorship-gated strong fits (75+ score parked in
 *      Queue by the gate) inside "medium", making 10k-job sources read as
 *      producing zero strong matches.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scoreJob, computeMissing } from '../../src/scoring/scorer.js';
import { mapJob } from '../../src/search/adapters/greenhouse.js';
import { applyFreshnessFilter } from '../../src/search/freshnessFilter.js';
import { runPipeline } from '../../src/pipeline/index.js';
import { openDatabase } from '../../src/logging/db.js';
import { JobLogger, createPinoLogger } from '../../src/logging/jobLogger.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import {
  fitBucket, isSponsorshipGated, dashboardStats, listBoardJobs, buildNextActions,
} from '../../src/dashboard/data.js';
import { normalizeJob } from '../../src/search/normalize.js';
import * as F from './fixtures/jobs.js';

const base = loadConfig({ loadEnv: false, env: {} });

describe('skill-alias evidence (matched vs missing contradiction)', () => {
  const candidate = {
    technicalStack: {
      dataEngineering: ['Azure Data Factory', 'Azure Databricks', 'Delta Lake', 'PySpark'],
      cloud: ['Microsoft Fabric', 'ADLS Gen2'],
      bi: ['Power BI', 'Semantic Models', 'SSAS Tabular'],
    },
  };
  const kw = base.scoring.keywords;
  const aliases = base.scoring.evidenceAliases;

  it('never reports a JD term as missing when the profile evidences it via an alias', () => {
    const jd = 'We need ADF, Fabric, lakehouse architecture, semantic model design and PySpark.';
    const missing = computeMissing(jd.toLowerCase(), candidate, kw, aliases);
    // ADF -> Azure Data Factory, Fabric -> Microsoft Fabric,
    // lakehouse -> Delta Lake/Databricks, semantic model -> Semantic Models.
    expect(missing).not.toContain('adf');
    expect(missing).not.toContain('fabric');
    expect(missing).not.toContain('lakehouse');
    expect(missing).not.toContain('semantic model');
  });

  it('still reports genuinely unevidenced JD skills', () => {
    const jd = 'Airflow and dbt orchestration on a data lake.';
    const missing = computeMissing(jd.toLowerCase(), candidate, kw, aliases);
    expect(missing).toContain('airflow');
    expect(missing).toContain('dbt');
    // data lake IS evidenced (ADLS Gen2 / Delta Lake aliases).
    expect(missing).not.toContain('data lake');
  });

  it('scoreJob no longer emits the same aliased skill as both matched and missing', () => {
    const job = normalizeJob({
      source: 'manual', company: 'AliasCo', title: 'Senior Data Engineer', sourceJobId: 'AL-1',
      postedAt: '2026-06-01T00:00:00Z',
      jdText: 'Senior Data Engineer: ADF, Microsoft Fabric, lakehouse, PySpark, semantic model.',
    });
    const result = scoreJob(job, {
      scoring: base.scoring,
      sponsorship: { status: 'Unconfirmed' },
      candidate,
      now: F.NOW,
    });
    const matched = new Set(result.matchedKeywords.map((s) => s.toLowerCase()));
    for (const gap of result.missingKeywords) {
      // Anything the profile evidences (directly or via alias) must not be a gap.
      expect(['airflow', 'dbt', 'kafka', 'scala', 'etl', 'elt', 'streaming', 'sql', 'python',
        'data pipeline', 'data warehouse', 'batch processing', 'dax', 'star schema',
        'dimensional modeling', 'tabular model', 'azure', 'databricks', 'delta lake',
        'onelake', 'synapse', 'azure synapse', 'azure databricks', 'azure data factory',
        'microsoft fabric', 't-sql', 'spark', 'data lake', 'power bi',
        'semantic modeling']).toContain(gap);
      // The specific historical contradiction: aliased core skills in both lists.
      if (['adf', 'fabric', 'lakehouse', 'semantic model', 'pyspark'].includes(gap)) {
        expect(matched.has(gap)).toBe(false);
      }
    }
    expect(result.missingKeywords).not.toContain('adf');
    expect(result.missingKeywords).not.toContain('fabric');
    expect(result.missingKeywords).not.toContain('lakehouse');
    expect(result.missingKeywords).not.toContain('pyspark');
  });
});

describe('greenhouse posting date', () => {
  it('prefers first_published (true posting date) over updated_at', () => {
    const job = mapJob({
      id: 1, title: 'Senior Data Engineer', absolute_url: 'https://boards.greenhouse.io/x/jobs/1',
      content: 'JD', location: { name: 'Remote' },
      first_published: '2026-05-01T00:00:00Z',
      updated_at: '2026-07-10T00:00:00Z', // board edit yesterday must NOT read as "posted yesterday"
    }, 'x');
    expect(job.postedAt).toContain('2026-05-01');
  });

  it('falls back to updated_at only when first_published is absent', () => {
    const job = mapJob({
      id: 2, title: 'Data Engineer', absolute_url: 'https://boards.greenhouse.io/x/jobs/2',
      content: 'JD', location: { name: 'Remote' },
      updated_at: '2026-07-10T00:00:00Z',
    }, 'x');
    expect(job.postedAt).toContain('2026-07-10');
  });
});

describe('freshness default window', () => {
  it('keeps a 5-day-old job by default (LAST_7_DAYS, not the old 3-day hard cut)', () => {
    const now = new Date('2026-07-11T00:00:00Z');
    const fiveDays = { id: 'f5', postedAt: '2026-07-06T00:00:00Z' };
    const nineDays = { id: 'f9', postedAt: '2026-07-02T00:00:00Z' };
    const { kept, dropped } = applyFreshnessFilter([fiveDays, nineDays], {}, { now });
    expect(kept.map((j) => j.id)).toContain('f5');
    expect(dropped.map((d) => d.job.id)).toContain('f9');
  });
});

describe('prepare gate (no auto-prepared Queue-tier packets)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'pipeline-gate-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  // Strong role fit but NO sponsorship signal: the sponsorship gate parks it
  // in Queue. It must not be auto-prepared — verifying sponsorship comes first.
  const gatedStrong = normalizeJob({
    source: 'greenhouse', company: 'GatedCo', title: 'Senior Data Engineer',
    location: 'Remote, US', sourceJobId: 'GS-1', postedAt: '2026-06-01T00:00:00Z',
    employmentType: 'Full-time',
    jdText: 'Senior Data Engineer building medallion lakehouses on Azure Databricks and ' +
      'Microsoft Fabric. Delta Lake, ADF, Synapse, PySpark, Python, SQL, T-SQL, Power BI ' +
      'semantic models, DAX. ETL/ELT data pipelines. Finance domain.',
  });

  it('PREPARE tailors packets for Apply/Priority only; Queue stays un-prepared', async () => {
    const db = openDatabase({ path: ':memory:' });
    const { logger: pino } = createPinoLogger({ toFile: false });
    const logger = new JobLogger({ db, logger: pino });
    const config = { ...base, root };
    const searchFn = async () => ({ jobs: [F.azureFabricSenior, gatedStrong], duplicates: [], errors: [] });

    const result = await runPipeline({ config, db, logger, mode: 'PREPARE', deps: { searchFn, now: F.NOW, stamp: 'test' } });

    const confirmed = db.getJob(F.azureFabricSenior.id);
    const gated = db.getJob(gatedStrong.id);
    // Sanity: the gated job really is a sponsorship-gated strong fit.
    expect(gated.score).toBeGreaterThanOrEqual(75);
    expect(gated.tier).toBe('Queue');
    // Confirmed-sponsorship strong fit is prepared; the gated one is NOT.
    expect(confirmed.status).toBe('prepared');
    expect(gated.status).toBe('scored');
    expect(gated.application_packet_path).toBeNull();
    expect(result.counters.jobs_prepared).toBe(1);
    db.close();
  });
});

describe('dashboard: sponsorship-gated strong fits are visible', () => {
  it('classifies a 75+ Queue job as a strong fit needing sponsorship verification', () => {
    expect(isSponsorshipGated({ tier: 'Queue', score: 80 })).toBe(true);
    expect(isSponsorshipGated({ tier: 'Queue', score: 70 })).toBe(false);
    expect(isSponsorshipGated({ tier: 'Apply', score: 80 })).toBe(false);
    expect(fitBucket('Queue', 80)).toBe('strong');
    expect(fitBucket('Queue', 70)).toBe('medium');
    expect(fitBucket('Queue')).toBe('medium'); // no score -> unchanged legacy behavior
  });

  it('stats count gated jobs as strong + needsSponsorshipCheck, and rows carry the flag', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'gated-1', source: 'greenhouse', company: 'GatedCo', title: 'Senior Data Engineer',
      location: 'Remote, US', url: 'https://example.com/1', score: 80, tier: 'Queue',
      sponsorship: 'Unconfirmed', status: 'scored',
    });
    db.upsertJob({
      id: 'medium-1', source: 'lever', company: 'MedCo', title: 'Data Engineer',
      location: 'Remote, US', url: 'https://example.com/2', score: 65, tier: 'Queue',
      sponsorship: 'Unconfirmed', status: 'scored',
    });
    const now = new Date('2026-07-11T00:00:00Z');

    const stats = dashboardStats(db, { now });
    expect(stats.totals.strongFit).toBe(1);
    expect(stats.totals.mediumFit).toBe(1);
    expect(stats.totals.needsSponsorshipCheck).toBe(1);
    // The gated job produces a concrete "verify sponsorship" next action.
    const gatedAction = stats.nextActions.find((a) => a.text.includes('sponsorship check'));
    expect(gatedAction).toBeDefined();
    expect(gatedAction.filter).toEqual({ fit: 'strong', sponsorship: 'Unconfirmed' });

    const rows = listBoardJobs(db, { fit: 'strong', now });
    expect(rows.map((r) => r.id)).toEqual(['gated-1']);
    expect(rows[0].sponsorshipGated).toBe(true);
    expect(rows[0].fit).toBe('strong');
    db.close();
  });

  it('buildNextActions omits the sponsorship action when nothing is gated', () => {
    const actions = buildNextActions({ needsSponsorshipCheck: 0, discoveredLast24h: 5 }, 0);
    expect(actions.find((a) => a.text.includes('sponsorship check'))).toBeUndefined();
  });
});

describe('db summary rows (board never loads jd_text)', () => {
  it('listJobsSummary returns every board field but not jd_text', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'j1', source: 'manual', company: 'A', title: 'T', location: 'L',
      url: 'https://example.com', jd_text: 'x'.repeat(10_000), score: 70, tier: 'Queue', status: 'scored',
    });
    const [row] = db.listJobsSummary();
    expect(row.id).toBe('j1');
    expect(row.score).toBe(70);
    expect(row).not.toHaveProperty('jd_text');
    // Full row (with jd_text) is still available for the detail view.
    expect(db.getJob('j1').jd_text.length).toBe(10_000);
    db.close();
  });
});
