/**
 * The score's gaps are the packet's gaps (audit R13/D3).
 *
 * The scorer used to ask candidate.json with `includes()` ("java" shown by
 * "javascript", "r" by any word) while the tailor used word boundaries over the
 * resume file, so a job could show no gaps in its score and gaps in its packet.
 * Both now ask the one evidence check (src/resume/evidence.js and its Python
 * twin) about the same lines, with the same vocabulary and the same notion of
 * what can be a gap. This runs the real scorer and the real Python tailor on
 * the shipped example master resume and requires the two lists to be equal.
 *
 * Skips when the Python environment cannot run the tailor.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTestRoot } from './globalSetup.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { masterResumeLines } from '../../src/resume/evidenceMap.js';
import { tailorResumeForJob } from '../../src/resume/tailorRunner.js';
import { scoreJob } from '../../src/scoring/scorer.js';

const POSTINGS = {
  everyday: 'Required: Go, R, Excel and Spark. You will own the go-live of each release and partner with R&D.',
  plurals: 'Required qualifications: building data pipelines in Airflow, REST APIs, data quality checks and dashboards in Power BI.',
  credentials: 'Requirements: active CPA certification, SOX experience, Python and SQL. Preferred: Snowflake and dbt.',
  titled: 'Senior Data Engineer. Must have Kafka, Kubernetes, Terraform and Microsoft Fabric. Nice to have: Java.',
  aliases: 'Required: ADF, Synapse, lakehouse design, PySpark and Delta Lake. Preferred: Scala and Golang.',
};

let root;
let config;
let lines;
let out;
let pythonOk = true;

beforeAll(async () => {
  root = buildTestRoot();
  config = loadConfig({ root, loadEnv: false });
  lines = masterResumeLines(root);
  out = mkdtempSync(join(tmpdir(), 'jobagent-gaps-'));
  const probe = await tailorResumeForJob({
    job: { company: 'Probe', title: 'Data Engineer', jdText: 'Required: Python.' },
    score: { matchedKeywords: ['python'], missingKeywords: [] },
    config, options: { exportPdf: false, outputDir: out },
  });
  pythonOk = probe.tailored === true;
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

const norm = (list) => [...new Set(list.map((t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim()))].sort();

describe('score gaps and packet gaps agree', { timeout: 60_000 }, () => {
  it('the scorer reads the master resume, not candidate.json', () => {
    expect(lines.length).toBeGreaterThan(20);
  });

  const CASES = [
    ...Object.entries(POSTINGS).map(([name, jdText]) => [name, 'Data Engineer', jdText]),
    // A skill named only in the title is still asked for, on both sides.
    ['a skill only in the title', 'Lead Data Engineer - Snowflake/Python/AWS', 'Build pipelines for the finance team.'],
    // No description yet: the title is all either side can read.
    ['no description', 'Data Engineer - Kubernetes', ''],
  ];
  for (const [name, title, jdText] of CASES) {
    it(`on a posting with ${name}`, async (ctx) => {
      if (!pythonOk) return ctx.skip();
      const job = { company: 'Example Co', title, jdText, source: 'greenhouse' };
      const score = scoreJob(job, {
        scoring: config.scoring, sponsorship: { status: 'Unconfirmed' }, candidate: config.candidate, evidenceLines: lines,
      });
      const tailored = await tailorResumeForJob({
        job: { company: job.company, title: job.title, jdText }, score, config,
        options: { exportPdf: false, outputDir: join(out, name) },
      });
      expect(tailored.tailored, tailored.warning ?? '').toBe(true);
      expect(norm(tailored.gaps.map((g) => g.keyword))).toEqual(norm(score.missingKeywords));
      if (name === 'a skill only in the title') expect(score.missingKeywords).toContain('snowflake');
      if (name === 'no description') expect(score.missingKeywords).toEqual(['kubernetes']);
    });
  }

  it('an everyday word in prose is neither asked for nor a gap', async (ctx) => {
    if (!pythonOk) return ctx.skip();
    const job = { company: 'Example Co', title: 'Data Engineer', jdText: POSTINGS.everyday, source: 'greenhouse' };
    const score = scoreJob(job, {
      scoring: { ...config.scoring, marketSkills: [...(config.scoring.marketSkills ?? []), 'Go', 'R', 'Excel'] },
      sponsorship: { status: 'Unconfirmed' }, candidate: config.candidate, evidenceLines: lines,
    });
    // The posting lists Go, R and Excel as skills, and the example resume shows none of them.
    expect(score.missingKeywords).toEqual(expect.arrayContaining(['go', 'r', 'excel']));
    const prose = scoreJob({ ...job, jdText: 'You will own the go-live and partner with R&D. I excel at it.' }, {
      scoring: { ...config.scoring, marketSkills: ['Go', 'R', 'Excel'] },
      sponsorship: { status: 'Unconfirmed' }, candidate: config.candidate, evidenceLines: lines,
    });
    expect(prose.missingKeywords).toEqual([]);
  });
});
