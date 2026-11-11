/**
 * Search-profile API, driven over real loopback HTTP against a temp root.
 *
 * Two things a unit test of the store cannot show, and both are the whole point:
 *
 *   1. Activating a profile REBINDS the live config bundle. Without that, the
 *      board keeps serving the previous candidate's search until the process
 *      restarts — which is exactly the silent staleness this work exists to end.
 *   2. Uploading a different person's resume produces a DETECTION and three
 *      offered choices, and changes nothing until one is chosen.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { saveProfile } from '../../src/profile/store.js';
import { normalizeProfile } from '../../src/profile/model.js';

const REPO = process.cwd();

/** A temp project root holding the real shared config and schemas. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-search-profile-'));
  mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
  for (const file of [
    'scoring.json', 'exclusions.json', 'jobboards.json', 'humanizer_patterns.json',
    'cover_letter.example.json', 'ats_resume.json', 'role_families.json',
  ]) {
    copyFileSync(join(REPO, 'config', file), join(root, 'config', file));
  }
  copyFileSync(join(REPO, 'config', 'cover_letter.example.json'), join(root, 'config', 'cover_letter.json'));
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.example.json'));
  copyFileSync(join(REPO, 'config', 'screening_answers.example.json'), join(root, 'config', 'screening_answers.json'));
  for (const schema of ['candidate', 'scoring', 'exclusions', 'jobboards', 'cover_letter', 'ats_resume']) {
    copyFileSync(
      join(REPO, 'config', 'schemas', `${schema}.schema.json`),
      join(root, 'config', 'schemas', `${schema}.schema.json`),
    );
  }
  writeFileSync(join(root, '.env'), '');
  return root;
}

const ENGINEER = normalizeProfile({
  id: 'dana-data', label: 'Dana — Senior Data Engineer',
  identity: { fullName: 'Dana Okafor' },
  contact: { email: 'dana@example.com' },
  location: { city: 'Raleigh', state: 'North Carolina', zip: '27601', country: 'United States' },
  background: { currentRoles: ['Senior Data Engineer'], seniority: 'senior', skills: ['Databricks', 'PySpark'] },
  searchIntent: {
    targetRoles: ['Senior Data Engineer'], seniority: 'senior',
    skillsToKeep: ['Databricks', 'PySpark', 'Azure Data Factory', 'Power BI', 'Python', 'SQL'],
    employmentTypes: ['fulltime'], startDate: 'Two weeks from offer',
    workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  },
});

const NURSE = normalizeProfile({
  id: 'priya-nurse', label: 'Priya — Registered Nurse',
  identity: { fullName: 'Priya Raman' },
  contact: { email: 'priya@example.com' },
  location: { city: 'Durham', state: 'North Carolina', zip: '27701', country: 'United States' },
  background: { currentRoles: ['Registered Nurse'], seniority: 'mid', skills: ['ACLS', 'BLS', 'Epic'] },
  searchIntent: {
    targetRoles: ['Registered Nurse'], seniority: 'mid',
    skillsToKeep: ['ACLS', 'BLS', 'Epic', 'Triage', 'IV Therapy', 'Patient Assessment'],
    employmentTypes: ['fulltime'], startDate: 'Immediately',
    workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  },
});

describe('dashboard search-profile API', () => {
  let db;
  let dash;
  let root;

  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    root = makeRoot();
    db = openDatabase({ path: ':memory:' });
    const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
    dash = await startDashboard({
      config: load(), db, logger: null, port: 0,
      deps: { extensionKey: 'k'.repeat(32), loadConfigImpl: load },
    });
  });

  afterEach(async () => {
    await dash.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports no profile before one exists, and imports the existing config on request', async () => {
    const empty = await get('/api/search-profiles');
    expect(empty.status).toBe(200);
    expect(empty.body.profiles).toEqual([]);
    expect(empty.body.active).toBeNull();

    const migrated = await post('/api/search-profiles/migrate', {});
    expect(migrated.body.migrated).toBe(true);

    const after = await get('/api/search-profiles');
    expect(after.body.profiles).toHaveLength(1);
    expect(after.body.active.profile.id).toBe(migrated.body.id);
  });

  it('reports WHAT a profile makes the agent do, not just what it stores', async () => {
    saveProfile(root, ENGINEER);
    const { body } = await get(`/api/search-profiles/${ENGINEER.id}`);
    // The consequences are the point: these were previously invisible, which is
    // how a run could use the wrong person's titles with nothing saying so.
    expect(body.effect.searchPhrases).toEqual(['data engineer']);
    expect(body.effect.families.map((f) => f.id)).toContain('data-analytics');
    expect(body.effect.expandedRoles.length).toBeGreaterThan(0);
    expect(body.effect.targetTitles).toContain('Senior Data Engineer');
    // Evidence and preference are handed over separately, never merged.
    expect(body.background.currentRoles).toEqual(['Senior Data Engineer']);
    expect(body.searchIntent.targetRoles).toEqual(['Senior Data Engineer']);
  });

  it('activating REBINDS the live config, so the next run uses the new search', async () => {
    saveProfile(root, ENGINEER);
    saveProfile(root, NURSE);

    const first = await post('/api/search-profiles/activate', { id: ENGINEER.id });
    expect(first.status).toBe(200);
    expect(first.body.searchPhrases).toEqual(['data engineer']);
    expect(dash.currentConfig().candidate.targetTitles).toContain('Senior Data Engineer');

    const second = await post('/api/search-profiles/activate', { id: NURSE.id });
    expect(second.body.searchPhrases.join(' ')).toMatch(/nurse/i);
    // A failed reload is reported, never swallowed — if this is non-null the
    // live bundle is stale and every later run uses the wrong candidate.
    expect(second.body.warning ?? null).toBeNull();

    // The live bundle followed, with nothing of the engineer left in it.
    const live = dash.currentConfig().candidate;
    expect(live.targetTitles.join(' ')).toMatch(/Nurse/i);
    expect(JSON.stringify(live).toLowerCase()).not.toContain('databricks');
    expect(JSON.stringify(live).toLowerCase()).not.toContain('data engineer');

    // And so did the files on disk.
    const onDisk = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
    expect(onDisk.searchPhrases.join(' ')).toMatch(/nurse/i);
  });

  it('a dry run reports the effect and writes nothing', async () => {
    saveProfile(root, NURSE);
    const before = readFileSync(join(root, 'config', 'candidate.json'), 'utf8');
    const { body } = await post('/api/search-profiles/activate', { id: NURSE.id, dryRun: true });
    expect(body.dryRun).toBe(true);
    expect(body.written).toEqual([]);
    expect(readFileSync(join(root, 'config', 'candidate.json'), 'utf8')).toBe(before);
  });

  it('refuses to delete the active profile and 404s an unknown one', async () => {
    saveProfile(root, ENGINEER);
    await post('/api/search-profiles/activate', { id: ENGINEER.id });
    const del = await fetch(`${dash.url}/api/search-profiles/${ENGINEER.id}`, { method: 'DELETE' });
    expect(del.status).toBeGreaterThanOrEqual(400);
    const missing = await get('/api/search-profiles/no-such-profile');
    expect(missing.status).toBe(404);
  });

  it('"keep my current goals" is an explicit no-op, not a silent one', async () => {
    saveProfile(root, ENGINEER);
    await post('/api/search-profiles/activate', { id: ENGINEER.id });
    const before = readFileSync(join(root, 'config', 'candidate.json'), 'utf8');
    const { body } = await post('/api/search-profiles/from-resume', { choice: 'keep' });
    expect(body.changed).toBe(false);
    expect(body.message).toMatch(/unchanged/i);
    expect(readFileSync(join(root, 'config', 'candidate.json'), 'utf8')).toBe(before);
  });

  it('rejects an unknown choice rather than guessing', async () => {
    saveProfile(root, ENGINEER);
    await post('/api/search-profiles/activate', { id: ENGINEER.id });
    const { status } = await post('/api/search-profiles/from-resume', { choice: 'whatever' });
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('says plainly when there is no resume to read', async () => {
    const { status, body } = await get('/api/search-profiles/from-resume/preview');
    // `available: false` with a reason, never a crash and never a silent empty
    // panel — the user has to be able to tell "no resume" from "no match".
    //
    // Asserted STRICTLY on purpose. A lenient version of this test
    // (`body.available ?? false`) passed while the route was being swallowed by
    // the catch-all `/api/search-profiles/:id` matcher below it, which returned
    // a 404 body with no `available` field at all — the assertion defaulted to
    // false and the real bug shipped green.
    expect(status).toBe(200);
    expect(body).toHaveProperty('available', false);
    expect(body.reason).toMatch(/resume/i);
    expect(body.error).toBeUndefined();
  });

});
