/**
 * "Years of experience with X", worked out from your work history (audit A6).
 *
 * A qualified duration question used to need a saved answer per skill. The
 * number can be worked out from dated roles that mention the skill. It is only
 * ever SUGGESTED: it is shown with the roles it came from and saved once the
 * person confirms, and a saved number is what later forms are answered with.
 *
 * What must hold: overlapping roles are counted once; a role that does not
 * mention the skill adds nothing; a partial date never overstates; and nothing
 * here ever answers a form on its own.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { skillYearsFromHistory } from '../../src/apply/skillYears.js';
import { answerScreeningQuestion } from '../../src/apply/screeningQA.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { openDatabase } from '../../src/logging/db.js';
import { deriveFromProfile } from '../../src/profile/derive.js';
import { normalizeProfile } from '../../src/profile/model.js';
import { activateProfile, saveProfile } from '../../src/profile/store.js';
import { buildTestRoot } from './globalSetup.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const history = [
  { employer: 'Contoso', title: 'Data Engineer', startDate: 'March 2019', endDate: 'February 2022', current: false,
    highlights: ['Built Airflow pipelines in Python', 'Cut warehouse cost 30%'] },
  { employer: 'Northwind', title: 'Senior Data Engineer', startDate: 'January 2022', endDate: '', current: true,
    highlights: ['Led a Python and Spark migration'] },
  { employer: 'Fabrikam', title: 'Analyst', startDate: 'June 2015', endDate: 'May 2018', current: false,
    highlights: ['Wrote Excel reports'] },
];

describe('skillYearsFromHistory', () => {
  it('counts only the roles that mention the skill, once where they overlap, up to now', () => {
    const r = skillYearsFromHistory('python', history, { now: NOW });
    // March 2019 to November 2026 = 7 years 8 months; Jan–Feb 2022 overlap is counted once.
    expect(r.months).toBe(92);
    expect(r.answer).toBe('7 years');
    expect(r.roles.map((x) => x.employer)).toEqual(['Contoso', 'Northwind']);
  });

  it('is null when no role mentions it, so nothing is suggested', () => {
    expect(skillYearsFromHistory('kubernetes', history, { now: NOW })).toBeNull();
    expect(skillYearsFromHistory('java', [{ title: 'Dev', startDate: '2020', endDate: '2022', highlights: ['Wrote JavaScript'] }], { now: NOW })).toBeNull();
  });

  it('floors, and says "less than a year" rather than rounding up', () => {
    const r = skillYearsFromHistory('excel', [{ employer: 'A', title: 'Analyst', startDate: 'January 2024', endDate: 'August 2024', highlights: ['Excel models'] }], { now: NOW });
    expect(r.answer).toBe('Less than 1 year');
  });

  it('counts a year-only date conservatively, so it never overstates', () => {
    const r = skillYearsFromHistory('sql', [{ employer: 'A', title: 'Dev', startDate: '2020', endDate: '2022', highlights: ['SQL'] }], { now: NOW });
    expect(r.months).toBeLessThanOrEqual(24);
    expect(r.months).toBeGreaterThan(0);
  });

  it('ignores a role whose dates cannot be read', () => {
    expect(skillYearsFromHistory('python', [{ employer: 'A', title: 'Dev', startDate: 'sometime', endDate: 'later', highlights: ['Python'] }], { now: NOW })).toBeNull();
  });
});

describe('a qualified duration question', () => {
  const candidate = { workHistory: history };
  const q = 'How many years of experience do you have with Python?';

  it('is still asked, never answered, but carries the suggestion and where it came from', () => {
    const r = answerScreeningQuestion(q, { answers: [] }, { candidate });
    expect(r.answered).toBe(false);
    expect(r.action).toBe('ask_user');
    expect(r.suggestion).toMatchObject({ answer: expect.stringMatching(/years/), roles: expect.any(Array) });
  });

  it('is answered from a saved number, as before', () => {
    const r = answerScreeningQuestion(q, { answers: [] }, { candidate: { ...candidate, skillExperience: { python: '7 years' } } });
    expect(r).toMatchObject({ answered: true, answer: '7 years', matchedId: 'skill_experience' });
  });

  it('has no suggestion when the history does not mention the skill', () => {
    const r = answerScreeningQuestion('How many years of experience do you have with Kubernetes?', { answers: [] }, { candidate });
    expect(r.suggestion).toBeUndefined();
  });
});

describe('a confirmed number', () => {
  const PROFILE = normalizeProfile({
    id: 'casey-data', label: 'Casey — Data Engineer',
    identity: { fullName: 'Casey Fixture' }, contact: { email: 'casey@fixture.test' },
    location: { city: 'Durham', state: 'North Carolina', zip: '27701', country: 'United States' },
    background: { currentRoles: ['Data Engineer'], seniority: 'senior', skills: ['Python', 'SQL'], workHistory: history },
    searchIntent: {
      targetRoles: ['Data Engineer'], seniority: 'senior', skillsToKeep: ['Python', 'SQL'], employmentTypes: ['fulltime'],
      workAuthorization: { status: 'US Citizen', requiresSponsorship: false },
    },
  });

  it('is carried into the generated candidate config, so activating a profile does not lose it', () => {
    const withNumber = { ...PROFILE, background: { ...PROFILE.background, skillExperience: { python: '7 years' } } };
    const derived = deriveFromProfile(withNumber, { root: buildTestRoot() });
    expect(derived.candidate.skillExperience).toEqual({ python: '7 years' });
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
      const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
      dash = await startDashboard({ config: load(), db, logger: null, port: 0, deps: { loadConfigImpl: load } });
    });
    afterEach(async () => { await dash.close(); db.close(); rmSync(root, { recursive: true, force: true }); });

    it('saves into the profile and the candidate file, and survives re-activation', async () => {
      const { status } = await post('/api/profile/skill-experience', { subject: 'Python', answer: '7 years' });
      expect(status).toBe(200);
      const profile = JSON.parse(readFileSync(join(root, 'config', 'profiles', `${PROFILE.id}.json`), 'utf8'));
      expect(profile.background.skillExperience).toEqual({ python: '7 years' });
      activateProfile(root, PROFILE.id);
      const candidate = JSON.parse(readFileSync(join(root, 'config', 'candidate.json'), 'utf8'));
      expect(candidate.skillExperience).toEqual({ python: '7 years' });
    });

    it('refuses an empty or absurd number', async () => {
      for (const answer of ['', '   ', 'x'.repeat(80)]) {
        expect((await post('/api/profile/skill-experience', { subject: 'Python', answer })).status, answer).toBe(400);
      }
      expect((await post('/api/profile/skill-experience', { subject: '', answer: '3 years' })).status).toBe(400);
    });

    it('the profile page offers the suggestion for an open years question', async () => {
      const { recordUnansweredQuestions } = await import('../../src/apply/questionQueue.js');
      recordUnansweredQuestions(root, { jobId: 'j1', company: 'Acme', questions: [{ label: 'How many years of experience do you have with Python?' }] });
      const state = await get('/api/profile');
      const q = state.questions.open.find((x) => /Python/.test(x.label));
      expect(q.suggestedExperience).toMatchObject({ subject: 'python', answer: expect.stringMatching(/years/), roles: expect.any(Array) });
    });
  });
});
