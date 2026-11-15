/**
 * Does the profile's vocabulary cover the postings it is scoring? (audit D4)
 *
 * Fit is scored from configured words. A profession with a thin vocabulary
 * scores every posting alike, and nothing said so. This measures, over the
 * stored postings, the share in which at least five of the vocabulary's terms
 * appear, warns in System health when that is low, and names the phrases the
 * postings keep asking for that the vocabulary does not know (the same phrases
 * "Also asked for" offers on one job).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COVERAGE_MIN_SAMPLE, COVERAGE_WARN_BELOW, proposeTerms, vocabularyCoverage } from '../../src/scoring/vocabularyCoverage.js';
import { runDoctor } from '../../src/cli/doctor.js';
import { dashboardFix } from '../../src/dashboard/healthFixes.js';
import { openDatabase } from '../../src/logging/db.js';

const VOCAB = ['python', 'sql', 'spark', 'airflow', 'dbt', 'snowflake', 'tableau'];
const RICH = 'Requirements\n- Python and SQL\n- Spark, Airflow and dbt pipelines\n- Snowflake experience';
const THIN = 'Requirements\n- Clinical trial monitoring (GCP)\n- Regulatory submissions: 510(k) and PMA\n- Python';

describe('vocabularyCoverage', () => {
  it('counts the share of postings with at least five vocabulary terms', () => {
    const r = vocabularyCoverage({ vocabulary: VOCAB, texts: [RICH, RICH, THIN, THIN] });
    expect(r).toMatchObject({ sampled: 4, covered: 2, percent: 50 });
  });

  it('five terms exactly counts, four does not', () => {
    const five = 'python sql spark airflow dbt';
    const four = 'python sql spark airflow';
    expect(vocabularyCoverage({ vocabulary: VOCAB, texts: [five] }).covered).toBe(1);
    expect(vocabularyCoverage({ vocabulary: VOCAB, texts: [four] }).covered).toBe(0);
  });

  it('matches whole words, so "r" or "go" inside another word is nothing', () => {
    expect(vocabularyCoverage({ vocabulary: ['r', 'go', 'sql', 'dbt', 'spark', 'python'], texts: ['research and good design with sql'] }).covered).toBe(0);
  });

  it('has nothing to say about an empty sample', () => {
    expect(vocabularyCoverage({ vocabulary: VOCAB, texts: [] })).toMatchObject({ sampled: 0, covered: 0, percent: null });
  });
});

describe('proposeTerms', () => {
  it('names the phrases postings ask for that the vocabulary lacks, most-asked first', () => {
    const texts = [THIN, THIN, 'Requirements\n- Regulatory submissions: 510(k) and PMA\n- GCP'];
    const out = proposeTerms({ texts, vocabulary: VOCAB });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((t) => typeof t.phrase === 'string' && t.postings >= 1)).toBe(true);
    expect(out.map((t) => t.phrase.toLowerCase()).join(' ')).not.toMatch(/\bpython\b/);
    expect(out[0].postings).toBeGreaterThanOrEqual(out[out.length - 1].postings);
  });
});

describe('the System health check', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jobagent-vocab-')); mkdirSync(join(root, 'data'), { recursive: true }); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  function seed(rich, thin) {
    const db = openDatabase({ path: join(root, 'data', 'applied_jobs.db') });
    for (let i = 0; i < rich; i += 1) db.upsertJob({ id: `r${i}`, company: 'A', title: 'T', jd_text: `${RICH}\n${'filler '.repeat(60)}`, discovery_mode: 'profile' });
    for (let i = 0; i < thin; i += 1) db.upsertJob({ id: `t${i}`, company: 'B', title: 'T', jd_text: `${THIN}\n${'filler '.repeat(60)}`, discovery_mode: 'profile' });
    db.close();
  }
  const check = async (vocabulary) => {
    const report = await runDoctor({
      root, env: {},
      deps: { loadConfigImpl: () => ({ scoring: { marketSkills: vocabulary }, candidate: {} }), spawnImpl: async () => ({ code: 1, stdout: '', stderr: '' }) },
    });
    return report.checks.find((c) => c.id === 'vocabulary');
  };

  it('passes quietly when there are too few postings to measure', async () => {
    seed(3, 3);
    expect(COVERAGE_MIN_SAMPLE).toBeGreaterThan(6);
    expect(await check(VOCAB)).toMatchObject({ status: 'pass', detail: expect.stringMatching(/not enough/i) });
  });

  it('warns when few postings match the vocabulary, and names what they ask for', async () => {
    seed(5, COVERAGE_MIN_SAMPLE + 10);
    const c = await check(VOCAB);
    expect(c.status).toBe('warn');
    expect(c.detail).toMatch(/\d+%/);
    expect(c.detail).toMatch(/five/i);
  });

  it('passes when most postings match', async () => {
    seed(COVERAGE_MIN_SAMPLE + 10, 5);
    expect((await check(VOCAB)).status).toBe('pass');
  });

  it('points at a screen, not a command', () => {
    const fix = dashboardFix({ id: 'vocabulary', status: 'warn', fix: 'x' });
    expect(fix).toMatch(/Also asked for|Look for this skill/);
    expect(fix).not.toMatch(/npm|`/);
  });

  it('the warning threshold is stated', () => {
    expect(COVERAGE_WARN_BELOW).toBeGreaterThan(0);
    expect(COVERAGE_WARN_BELOW).toBeLessThan(100);
  });
});
