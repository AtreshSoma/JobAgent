import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  runDoctor, requiredProfileGaps, optionalProfileGaps,
  REQUIRED_PROFILE_FIELDS, SEVERITY,
} from '../../src/cli/doctor.js';
import { quickPreflight } from '../../src/index.js';
import { PROJECT_ROOT } from '../../src/config/loadConfig.js';
import { loadTestConfig, FIXTURE_CONFIG_DIR } from './helpers/testConfig.js';

const base = loadTestConfig({ loadEnv: false, env: {} });

/** Candidate with every required field present. */
const fullCandidate = {
  identity: { fullName: 'Priya Raghunathan', links: { linkedin: 'https://linkedin.com/in/x', github: '', portfolio: '' } },
  contact: { email: 'a@example.com', phone: '5550100' },
  location: { street: '', city: 'Springfield', state: 'IL', zip: '62701', country: 'United States' },
  workAuthorization: { status: 'H-1B', requiresSponsorship: true },
  targetTitles: ['Senior Data Engineer'],
};

describe('profile gap detection', () => {
  it('finds no required gaps in a complete profile', () => {
    expect(requiredProfileGaps(fullCandidate)).toEqual([]);
  });

  it('reports each missing required field with its config path', () => {
    const gaps = requiredProfileGaps({});
    expect(gaps.length).toBe(REQUIRED_PROFILE_FIELDS.length);
    expect(gaps.map((g) => g.path)).toContain('contact.email');
    expect(gaps.map((g) => g.path)).toContain('workAuthorization.requiresSponsorship');
  });

  it('treats empty strings and empty arrays as missing', () => {
    const c = { ...fullCandidate, contact: { email: '  ', phone: '5550100' }, targetTitles: [] };
    const paths = requiredProfileGaps(c).map((g) => g.path);
    expect(paths).toContain('contact.email');
    expect(paths).toContain('targetTitles');
  });

  it('treats explicit false as present (requiresSponsorship: false is an answer)', () => {
    const c = { ...fullCandidate, workAuthorization: { status: 'Citizen', requiresSponsorship: false } };
    expect(requiredProfileGaps(c).map((g) => g.path)).not.toContain('workAuthorization.requiresSponsorship');
  });

  it('reports truthful optional gaps without ever inventing values', () => {
    const paths = optionalProfileGaps(fullCandidate).map((g) => g.path);
    expect(paths).toContain('location.street');
    expect(paths).toContain('identity.links.github');
    expect(paths).not.toContain('identity.links.linkedin');
  });

  it('the real config/candidate.json has no required gaps', () => {
    expect(requiredProfileGaps(base.candidate)).toEqual([]);
  });
});

describe('quickPreflight (npm start gate)', () => {
  it('passes against the real repo config', () => {
    expect(quickPreflight(base)).toEqual({ ok: true, problems: [] });
  });

  it('stops with exact missing fields and resume path', () => {
    const root = mkdtempSync(join(tmpdir(), 'preflight-'));
    try {
      const broken = { ...base, root, candidate: { ...base.candidate, contact: { email: '', phone: '' } } };
      const gate = quickPreflight(broken);
      expect(gate.ok).toBe(false);
      expect(gate.problems.some((p) => p.includes('contact.email'))).toBe(true);
      expect(gate.problems.some((p) => p.includes('contact.phone'))).toBe(true);
      expect(gate.problems.some((p) => p.includes('MASTER_RESUME.docx'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runDoctor', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'doctor-'));
    // Minimal healthy workspace: the repo's shared configs, the FIXTURE profile,
    // and a non-empty master resume.
    //
    // The profile has to be the fixture, not config/candidate.json. The shipped
    // config is the .example template, and a healthy workspace is precisely one
    // where the user has replaced that template with their own details — so
    // copying it here would assert that doctor passes on exactly the state
    // doctor now exists to reject.
    cpSync(join(PROJECT_ROOT, 'config'), join(root, 'config'), { recursive: true });
    cpSync(join(FIXTURE_CONFIG_DIR, 'candidate.json'), join(root, 'config', 'candidate.json'));
    cpSync(join(FIXTURE_CONFIG_DIR, 'screening_answers.json'), join(root, 'config', 'screening_answers.json'));
    // cover_letter.json is gitignored personal config too, so the repo copy is
    // a placeholder on a clean clone and would fail the sentinel check.
    cpSync(join(FIXTURE_CONFIG_DIR, 'cover_letter.json'), join(root, 'config', 'cover_letter.json'));
    mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
    writeFileSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'), 'stub docx bytes', 'utf8');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  /** spawnSync stub: every subprocess succeeds. */
  const spawnOk = () => ({ status: 0, stdout: 'Python 3.12.0\n', stderr: '' });
  /** spawnSync stub: every subprocess fails (no python anywhere). */
  const spawnFail = () => ({ status: 1, stdout: '', stderr: 'not found' });

  it('passes on a healthy workspace and reports structured checks', async () => {
    const result = await runDoctor({ root, env: {}, deps: { spawnImpl: spawnOk } });
    expect(result.ok).toBe(true);
    expect(result.summary.fail).toBe(0);
    const ids = result.checks.map((c) => c.id);
    for (const id of ['node', 'sqlite', 'db', 'config', 'profile', 'resume', 'python', 'browser', 'outputs', 'fixtures']) {
      expect(ids).toContain(id);
    }
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.node.status).toBe(SEVERITY.PASS);
    expect(byId.config.status).toBe(SEVERITY.PASS);
    expect(byId.profile.status).toBe(SEVERITY.PASS);
    expect(byId.resume.status).toBe(SEVERITY.PASS);
  });

  // REGRESSION GUARD (P0). Copying the .example files is the exact first step
  // doctor and the README tell a new user to take, and every gate used to pass
  // the result: doctor reported "✓ Preflight passed — the pipeline is ready to
  // run" for a profile named Jane Doe whose work-authorization status read
  // "US Citizen | Green Card | H-1B | OPT | ...". Those strings are typed
  // verbatim into an employer's work-authorization field.
  it('FAILS when the profile is still the shipped example template', async () => {
    cpSync(join(PROJECT_ROOT, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
    cpSync(join(PROJECT_ROOT, 'config', 'screening_answers.example.json'),
      join(root, 'config', 'screening_answers.json'));

    const result = await runDoctor({ root, env: {}, deps: { spawnImpl: spawnOk } });

    expect(result.ok).toBe(false);
    const check = result.checks.find((c) => c.id === 'profile-placeholders');
    expect(check.status).toBe(SEVERITY.FAIL);
    // The legally material ones specifically.
    expect(check.detail).toMatch(/work authorization status/i);
    expect(check.detail).toMatch(/require_sponsorship/i);
    // Presence-only checks still pass — which is exactly why this one is needed.
    const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
    expect(byId.profile.status).toBe(SEVERITY.PASS);
  });

  it('fails on an old Node version with an actionable message', async () => {
    // Node 20 has no node:sqlite, so it must fail preflight too.
    const result = await runDoctor({
      root, env: {}, deps: { spawnImpl: spawnOk, nodeVersion: 'v20.11.0' },
    });
    const node = result.checks.find((c) => c.id === 'node');
    expect(node.status).toBe(SEVERITY.FAIL);
    expect(node.fix).toContain('Node 22');
    expect(result.ok).toBe(false);
  });

  it('degrades to a WARNING (not failure) when Python is unavailable', async () => {
    const result = await runDoctor({ root, env: {}, deps: { spawnImpl: spawnFail } });
    const python = result.checks.find((c) => c.id === 'python');
    expect(python.status).toBe(SEVERITY.WARN);
    expect(python.detail).toContain('fall back');
    // Missing python alone must not block the pipeline.
    expect(result.checks.filter((c) => c.status === SEVERITY.FAIL)).toEqual([]);
  });

  it('fails when the master resume is missing', async () => {
    rmSync(join(root, 'resumes', 'base', 'MASTER_RESUME.docx'));
    const result = await runDoctor({ root, env: {}, deps: { spawnImpl: spawnOk } });
    const resume = result.checks.find((c) => c.id === 'resume');
    expect(resume.status).toBe(SEVERITY.FAIL);
    expect(result.ok).toBe(false);
  });

  it('fails with the schema error when a config file is invalid', async () => {
    writeFileSync(join(root, 'config', 'candidate.json'), '{ not json', 'utf8');
    const result = await runDoctor({ root, env: {}, deps: { spawnImpl: spawnOk } });
    const config = result.checks.find((c) => c.id === 'config');
    expect(config.status).toBe(SEVERITY.FAIL);
    expect(config.detail).toContain('candidate.json');
    expect(result.ok).toBe(false);
  });

  it('warns about empty optional profile fields without failing', async () => {
    const result = await runDoctor({ root, env: {}, deps: { spawnImpl: spawnOk } });
    const opt = result.checks.find((c) => c.id === 'profile-optional');
    // The fixture profile leaves `portfolio` empty — a truthful gap, which must
    // WARN rather than fail. An empty optional field is honest; the system must
    // never invent one to make the check go green.
    expect(opt.status).toBe(SEVERITY.WARN);
    expect(opt.detail).toContain('identity.links.portfolio');
  });
});
