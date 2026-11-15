/**
 * Export everything from the dashboard (S1: it was a command line only).
 * The bundle format itself is tested in backupAndBundle.test.js.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { isEncryptedBundle } from '../../src/logging/bundle.js';

describe('export everything from the dashboard', () => {
  let root; let db; let dash;
  const post = (body) => fetch(`${dash.url}/api/export/bundle`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'jobagent-export-'));
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, 'config', 'candidate.json'), '{"identity":{"fullName":"Casey Fixture"}}');
    mkdirSync(join(root, 'data'), { recursive: true });
    const file = openDatabase({ path: join(root, 'data', 'applied_jobs.db') });
    file.upsertJob({ id: 'x1', company: 'Acme', title: 'Engineer', status: 'scored', score: 80 });
    file.close();
    db = openDatabase({ path: ':memory:' });
    dash = await startDashboard({ config: { root }, db, logger: null, port: 0 });
  });
  afterEach(async () => {
    await dash.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('writes one file to exports/ and serves it by name', async () => {
    const { status, body } = await post({});
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, encrypted: false });
    expect(body.databases).toBeGreaterThanOrEqual(1);
    expect(body.name).toMatch(/^jobagent-[0-9A-Za-z-]+\.jobagent$/);
    const res = await fetch(`${dash.url}/api/export/bundle/${body.name}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(body.name);
    expect((await res.arrayBuffer()).byteLength).toBe(body.bytes > 0 ? Number(res.headers.get('content-length')) : 0);
  });

  it('encrypts with a passphrase, and refuses one that is too short', async () => {
    expect((await post({ passphrase: 'short' })).status).toBe(400);
    const { body } = await post({ passphrase: 'correct horse battery' });
    expect(body.encrypted).toBe(true);
    expect(isEncryptedBundle(join(root, 'exports', body.name))).toBe(true);
  });

  it('serves nothing but an export', async () => {
    for (const name of ['..%2Fconfig%2Fcandidate.json', 'candidate.json', 'jobagent-x.db', 'jobagent-..%2F..%2Fx.jobagent']) {
      expect((await fetch(`${dash.url}/api/export/bundle/${name}`)).status, name).toBe(404);
    }
  });
});
