/**
 * F9 — adopted resume evidence must survive the next activation.
 * F10 — activating a profile re-judges stored verdicts when given a database.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { adoptResumeEvidence } from '../../src/config/profileStore.js';
import { migrateLegacyCandidate, activateProfile, readActiveProfile } from '../../src/profile/store.js';

const REPO = process.cwd();

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-writethrough-'));
  mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  for (const file of ['scoring.json', 'exclusions.json', 'jobboards.json', 'humanizer_patterns.json', 'ats_resume.json', 'role_families.json']) {
    copyFileSync(join(REPO, 'config', file), join(root, 'config', file));
  }
  copyFileSync(join(REPO, 'config', 'cover_letter.example.json'), join(root, 'config', 'cover_letter.json'));
  copyFileSync(join(REPO, 'tests', 'node', 'fixtures', 'config', 'candidate.json'), join(root, 'config', 'candidate.json'));
  copyFileSync(join(REPO, 'tests', 'node', 'fixtures', 'config', 'screening_answers.json'), join(root, 'config', 'screening_answers.json'));
  for (const schema of ['candidate', 'scoring', 'exclusions', 'jobboards', 'cover_letter', 'ats_resume']) {
    copyFileSync(join(REPO, 'config', 'schemas', `${schema}.schema.json`), join(root, 'config', 'schemas', `${schema}.schema.json`));
  }
  writeFileSync(join(root, '.env'), '');
  return root;
}


let root;
beforeEach(() => { root = makeRoot(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('adoptResumeEvidence writes through the active profile', () => {
  it('an adopted title survives re-activation', () => {
    const id = migrateLegacyCandidate(root).id ?? readActiveProfile(root).id;
    activateProfile(root, id);
    const out = adoptResumeEvidence(root, { titles: ['Lakehouse Developer'], skills: ['Delta Lake'] });
    expect(out.profileId).toBe(id);
    expect(readActiveProfile(root).searchIntent.targetRoles).toContain('Lakehouse Developer');
    activateProfile(root, id);
    const candidate = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
    expect(candidate.targetTitles).toContain('Lakehouse Developer');
  });
});

describe('activateProfile re-judges the board when given a database', () => {
  it('rescored stale verdicts from stored text', () => {
    const id = migrateLegacyCandidate(root).id ?? readActiveProfile(root).id;
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({
      id: 'gh:1', source: 'greenhouse', company: 'Northwind', title: 'Senior Data Engineer',
      location: 'Remote, United States', url: 'https://x/1', posted_at: new Date().toISOString(),
      jd_text: 'Databricks and PySpark pipelines. '.repeat(10), status: 'scored', score: 10, tier: 'Discard',
      scoring_fingerprint: 'old',
    });
    const summary = activateProfile(root, id, { db });
    expect(summary.rescoreError).toBeUndefined();
    expect(summary.rescored).toBe(1);
    expect(db.getJob('gh:1').scoring_fingerprint).not.toBe('old');
    db.close();
  });
});
