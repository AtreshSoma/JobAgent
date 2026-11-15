/**
 * Adding a posting's requirement to what JobAgent looks for (audit R12).
 * Only a phrase the job's own posting contains is accepted; it widens the
 * market vocabulary and claims nothing about the person.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { activateProfile, saveProfile } from '../../src/profile/store.js';
import { normalizeProfile } from '../../src/profile/model.js';
import { deriveFromProfile } from '../../src/profile/derive.js';
import { buildTestRoot } from './globalSetup.js';

const PROFILE = normalizeProfile({
  id: 'casey-data', label: 'Casey — Data Engineer',
  identity: { fullName: 'Casey Fixture' },
  contact: { email: 'casey@fixture.test' },
  location: { city: 'Durham', state: 'North Carolina', zip: '27701', country: 'United States' },
  background: { currentRoles: ['Data Engineer'], seniority: 'senior', skills: ['Python', 'SQL', 'Airflow'] },
  searchIntent: {
    targetRoles: ['Data Engineer'], seniority: 'senior', skillsToKeep: ['Python', 'SQL', 'Airflow', 'Spark', 'dbt'],
    employmentTypes: ['fulltime'], workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
  },
});

const JD = 'Requirements\n- Experience with Python\n- Hands-on experience with Dagster\nBenefits\n- Health insurance';

describe('watch skills', () => {
  it('a watched skill joins the market vocabulary', () => {
    const plain = deriveFromProfile(PROFILE, { root: buildTestRoot() });
    const watched = deriveFromProfile({ ...PROFILE, searchIntent: { ...PROFILE.searchIntent, watchSkills: ['Dagster'] } },
      { root: buildTestRoot() });
    expect(plain.marketSkills).not.toContain('Dagster');
    expect(watched.marketSkills).toContain('Dagster');
  });

  describe('the dashboard', () => {
    let root; let db; let dash;
    const post = (p, body) => fetch(dash.url + p, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const get = (p) => fetch(dash.url + p).then((r) => r.json());

    beforeEach(async () => {
      root = buildTestRoot();
      saveProfile(root, PROFILE);
      activateProfile(root, PROFILE.id);
      db = openDatabase({ path: ':memory:' });
      db.upsertJob({ id: 'w1', company: 'Acme', title: 'Data Engineer', status: 'scored', score: 70, jd_text: JD });
      const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
      dash = await startDashboard({ config: load(), db, logger: null, port: 0, deps: { loadConfigImpl: load } });
    });
    afterEach(async () => {
      await dash.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    });

    it('the job detail lists what the posting asks for outside the vocabulary', async () => {
      const detail = await get('/api/jobs/w1');
      expect(detail.unlistedRequirements.map((p) => p.phrase)).toEqual(['Dagster']);
    });

    it('adds a phrase from the posting, and the vocabulary follows', async () => {
      const { status, body } = await post('/api/search-profiles/watch-skill', { jobId: 'w1', phrase: 'Dagster' });
      expect(status).toBe(200);
      expect(body).toMatchObject({ added: true, watchSkills: ['Dagster'] });
      const saved = JSON.parse(readFileSync(join(root, 'config', 'profiles', `${PROFILE.id}.json`), 'utf8'));
      expect(saved.searchIntent.watchSkills).toEqual(['Dagster']);
      const scoring = JSON.parse(readFileSync(join(root, 'config', 'scoring.json'), 'utf8'));
      expect(scoring.marketSkills).toContain('Dagster');
      expect((await get('/api/jobs/w1')).unlistedRequirements).toEqual([]);
      expect((await post('/api/search-profiles/watch-skill', { jobId: 'w1', phrase: 'Dagster' })).body.added).toBe(false);
    });

    it('refuses a phrase the posting does not contain', async () => {
      const { status, body } = await post('/api/search-profiles/watch-skill', { jobId: 'w1', phrase: 'Kubernetes' });
      expect(status).toBe(400);
      expect(body.error).toMatch(/not in this job/);
    });
  });
});
