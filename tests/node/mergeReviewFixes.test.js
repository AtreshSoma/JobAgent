import { describe, it, expect } from 'vitest';
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadConfig } from '../../src/config/loadConfig.js';
import { pythonExe } from '../../src/resume/pythonEnv.js';
import { candidateRequiresSponsorship } from '../../src/apply/screeningQA.js';

describe('cover_letter.json is optional (it is gitignored personal config)', () => {
  it('a workspace without it still loads, with cover letters switched off', () => {
    const root = mkdtempSync(join(tmpdir(), 'ja-noletter-'));
    try {
      cpSync(join(process.env.JOB_AGENT_ROOT, 'config'), join(root, 'config'), { recursive: true });
      rmSync(join(root, 'config', 'cover_letter.json'), { force: true });
      expect(existsSync(join(root, 'config', 'cover_letter.json'))).toBe(false);
      const config = loadConfig({ root, loadEnv: false });
      expect(config.coverLetter).toMatchObject({ enabled: false, _missing: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Python resolver on Windows', () => {
  it('prefers python.exe over the Microsoft Store python3 stub in WindowsApps', () => {
    const env = { PATH: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python312', PATHEXT: '.EXE' };
    const exists = (p) => /WindowsApps.python3\.exe$/i.test(p) || /Python312.python\.exe$/i.test(p);
    expect(pythonExe(env, { root: null, platform: 'win32', exists })).toBe('python');
  });

  it('never returns the stub even when it is the only python3 on PATH', () => {
    const env = { PATH: 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps', PATHEXT: '.EXE' };
    const exists = (p) => /WindowsApps.python3\.exe$/i.test(p);
    expect(pythonExe(env, { root: null, platform: 'win32', exists })).toBe('python');
  });
});

describe('one reading of the sponsorship requirement', () => {
  it('uses the current field, falling back to the legacy one', () => {
    expect(candidateRequiresSponsorship({ workAuthorization: { requiresSponsorship: true } })).toBe(true);
    expect(candidateRequiresSponsorship({ sponsorshipRequired: false })).toBe(false);
    expect(candidateRequiresSponsorship({})).toBeUndefined();
  });
});

describe('dashboard hardening from the pre-merge review', () => {
  it('prototype names are not board views or sorts, a NUL byte is a 400, and async route errors are 4xx', async () => {
    const { openDatabase } = await import('../../src/logging/db.js');
    const { startDashboard } = await import('../../src/dashboard/server.js');
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', title: 'T', status: 'scored', score: 70, tier: 'Queue' });
    const dash = await startDashboard({ config: { root: '/fake/root' }, db, logger: null, port: 0 });
    try {
      for (const q of ['view=__proto__', 'sort=constructor', 'view=toString']) {
        expect((await fetch(`${dash.url}/api/jobs?${q}`)).status).toBe(200);
      }
      expect((await fetch(`${dash.url}/assets/js/%00`)).status).toBe(400);
      const adopt = await fetch(`${dash.url}/api/profile/adopt`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ titles: ['Data Engineer'] }),
      });
      expect(adopt.status).toBeGreaterThanOrEqual(400);
      expect(adopt.status).toBeLessThan(500);
    } finally {
      await dash.close();
      db.close();
    }
  });
});
