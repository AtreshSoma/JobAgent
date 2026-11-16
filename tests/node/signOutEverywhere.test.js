/**
 * "Sign out everywhere" (audit P5).
 *
 * Each person's browser profile folder holds live sign-ins to every
 * application site they used (Workday, iCIMS…). Removing that folder signs
 * them out of all of them on this computer. Only that person's folders are
 * touched, never another profile's, never anything outside the workspace, and
 * never while that browser is open or a run is going.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { browserProfileDirs, signOutEverywhere } from '../../src/profile/signOut.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { openDatabase } from '../../src/logging/db.js';
import { buildTestRoot } from './globalSetup.js';

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jobagent-signout-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const make = (name) => { mkdirSync(join(root, name, 'Default'), { recursive: true }); writeFileSync(join(root, name, 'Default', 'Cookies'), 'x'); };

describe('browserProfileDirs', () => {
  it('finds this person\'s folders, every browser channel, and no one else\'s', () => {
    for (const n of ['.browser-profile-dana', '.browser-profile-dana-msedge', '.browser-profile-sam', '.browser-profile', 'resumes']) make(n);
    expect(browserProfileDirs(root, 'dana').map((d) => d.name).sort()).toEqual(['.browser-profile-dana', '.browser-profile-dana-msedge']);
  });

  it('with no profile, means the original shared folder only', () => {
    for (const n of ['.browser-profile', '.browser-profile-msedge', '.browser-profile-dana']) make(n);
    expect(browserProfileDirs(root, null).map((d) => d.name).sort()).toEqual(['.browser-profile', '.browser-profile-msedge']);
  });

  it('does not mistake a profile whose id starts with another\'s for it', () => {
    for (const n of ['.browser-profile-dan', '.browser-profile-dana']) make(n);
    expect(browserProfileDirs(root, 'dan').map((d) => d.name)).toEqual(['.browser-profile-dan']);
  });
});

describe('signOutEverywhere', () => {
  it('removes only that person\'s folders', () => {
    for (const n of ['.browser-profile-dana', '.browser-profile-sam']) make(n);
    const out = signOutEverywhere(root, 'dana', { openDirs: [] });
    expect(out.removed).toEqual(['.browser-profile-dana']);
    expect(existsSync(join(root, '.browser-profile-dana'))).toBe(false);
    expect(existsSync(join(root, '.browser-profile-sam'))).toBe(true);
  });

  it('refuses while that browser is open', () => {
    make('.browser-profile-dana');
    expect(() => signOutEverywhere(root, 'dana', { openDirs: [join(root, '.browser-profile-dana')] })).toThrow(/open/i);
    expect(existsSync(join(root, '.browser-profile-dana'))).toBe(true);
  });

  it('says so when there is nothing to remove', () => {
    expect(signOutEverywhere(root, 'dana', { openDirs: [] })).toEqual({ removed: [] });
  });
});

describe('POST /api/profile/sign-out-everywhere', () => {
  let r; let db; let dash;
  beforeEach(async () => {
    r = buildTestRoot();
    mkdirSync(join(r, '.browser-profile', 'Default'), { recursive: true });
    db = openDatabase({ path: ':memory:' });
    const load = ({ root: x = r } = {}) => loadConfig({ root: x, loadEnv: false, env: {} });
    dash = await startDashboard({ config: load(), db, logger: null, port: 0, deps: { loadConfigImpl: load } });
  });
  afterEach(async () => { await dash.close(); db.close(); rmSync(r, { recursive: true, force: true }); });
  const post = (body) => fetch(`${dash.url}/api/profile/sign-out-everywhere`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

  it('needs an explicit confirmation', async () => {
    expect((await post({})).status).toBe(400);
    expect(existsSync(join(r, '.browser-profile'))).toBe(true);
  });

  it('removes the folders when confirmed', async () => {
    const res = await post({ confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.removed).toEqual(['.browser-profile']);
    expect(existsSync(join(r, '.browser-profile'))).toBe(false);
  });
});
