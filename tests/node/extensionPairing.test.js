/**
 * Pair the extension with a code from the dashboard, instead of pasting a key
 * (audit A12).
 *
 * The dashboard shows a short code. The extension's settings page sends it to
 * the local server and gets the extension key back, once. The code works one
 * time, for five minutes, and a run of wrong guesses locks pairing for a minute.
 * The key is the same 32+ character key the extension has always used (from
 * JOB_AGENT_EXTENSION_KEY, or one the dashboard makes and keeps in data/ when
 * that is not set), and pasting it by hand still works.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createPairing, ensureExtensionKey, PAIRING_ALPHABET } from '../../src/extension/pairing.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { openDatabase } from '../../src/logging/db.js';
import { buildTestRoot } from './globalSetup.js';
import { browserUnavailable } from './helpers/browser.js';
import { launchBrowser, startTestDashboard, waitUntilConnected } from './helpers/dashboardPage.js';

const KEY = 'k'.repeat(40);

describe('the pairing code', () => {
  it('is 8 easy characters in two groups, and never has 0, O, 1 or I', () => {
    const p = createPairing();
    for (let i = 0; i < 50; i += 1) {
      const { code } = p.issue();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect([...code.replace('-', '')].every((c) => PAIRING_ALPHABET.includes(c))).toBe(true);
    }
  });

  it('works once, accepts it typed loosely, and gives back the key', () => {
    const p = createPairing();
    const { code } = p.issue();
    expect(p.redeem(code.toLowerCase().replace('-', ' '), KEY)).toEqual({ ok: true, key: KEY });
    expect(p.redeem(code, KEY).ok).toBe(false);
  });

  it('expires after five minutes', () => {
    let t = 1_000_000;
    const p = createPairing({ now: () => t });
    const { code } = p.issue();
    t += 5 * 60_000 + 1;
    expect(p.redeem(code, KEY)).toMatchObject({ ok: false, error: expect.stringMatching(/expired|new code/i) });
  });

  it('a new code replaces the old one', () => {
    const p = createPairing();
    const first = p.issue().code;
    const second = p.issue().code;
    expect(p.redeem(first, KEY).ok).toBe(false);
    expect(p.redeem(second, KEY).ok).toBe(true);
  });

  it('locks after five wrong guesses, even for the right code, then recovers', () => {
    let t = 0;
    const p = createPairing({ now: () => t });
    const { code } = p.issue();
    for (let i = 0; i < 5; i += 1) expect(p.redeem('AAAA-AAAA', KEY).ok).toBe(false);
    const locked = p.redeem(code, KEY);
    expect(locked).toMatchObject({ ok: false, retryAfterMs: expect.any(Number) });
    t += 61_000;
    expect(p.redeem(code, KEY).ok).toBe(true);
  });

  it('gives nothing away about why a guess failed', () => {
    const p = createPairing();
    p.issue();
    expect(p.redeem('ZZZZ-ZZZZ', KEY).error).toBe(p.redeem('', KEY).error);
  });
});

describe('the extension key', () => {
  it('is made once, 64 hex characters, kept in data/, and reused', () => {
    const root = buildTestRoot();
    try {
      const a = ensureExtensionKey(root);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
      expect(ensureExtensionKey(root)).toBe(a);
      expect(existsSync(join(root, 'data', 'extension_key'))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('through the dashboard', () => {
  let root; let db; let dash;
  const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
  const issue = () => fetch(`${dash.url}/api/extension-pairing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
  const pair = (code, origin = ORIGIN) => fetch(`${dash.url}/api/extension/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ code }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  async function boot({ extensionKey } = {}) {
    root = buildTestRoot();
    db = openDatabase({ path: ':memory:' });
    const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
    dash = await startDashboard({ config: load(), db, logger: null, port: 0, deps: { loadConfigImpl: load, ...(extensionKey ? { extensionKey } : {}) } });
  }
  afterEach(async () => { await dash?.close(); db?.close(); if (root) rmSync(root, { recursive: true, force: true }); });

  it('with no key configured, makes one, and the code pairs the extension with it', async () => {
    await boot();
    const { code, expiresAt } = await issue();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    const paired = await pair(code);
    expect(paired.status).toBe(200);
    expect(paired.body.key).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(root, 'data', 'extension_key'), 'utf8').trim()).toBe(paired.body.key);
    // The paired key opens the extension API, which was disabled before.
    const res = await fetch(`${dash.url}/api/extension/jobs/none/payload`, { headers: { origin: ORIGIN, 'x-job-agent-key': paired.body.key } });
    expect([403, 404]).toContain(res.status);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(503);
  });

  it('with a key from the environment, hands out that key', async () => {
    await boot({ extensionKey: KEY });
    const { code } = await issue();
    expect((await pair(code)).body.key).toBe(KEY);
  });

  it('refuses a wrong code and a page that is not the extension', async () => {
    await boot();
    const { code } = await issue();
    expect((await pair('AAAA-AAAA')).status).toBe(403);
    expect((await pair(code, 'https://evil.test')).status).toBe(403);
    expect((await pair(code)).status).toBe(200);
  });

  it('a code cannot be used twice', async () => {
    await boot();
    const { code } = await issue();
    expect((await pair(code)).status).toBe(200);
    expect((await pair(code)).status).toBe(403);
  });
});

describe('the extension settings page', () => {
  it('pairs with a code, stores the key, and keeps pasting available', async () => {
    const source = readFileSync(join(process.cwd(), 'extension', 'pairing.js'), 'utf8');
    const sandbox = { globalThis: {}, URL, JSON, String, Number, Error, Promise };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    const { pairWithServer } = sandbox.globalThis.JobAgentPairing;
    const calls = [];
    const fetchFn = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ key: KEY }) }; };
    const out = await pairWithServer('http://127.0.0.1:4646', 'abcd-2345', fetchFn);
    expect(out).toEqual({ ok: true, key: KEY });
    expect(calls[0].url).toBe('http://127.0.0.1:4646/api/extension/pair');
    expect(JSON.parse(calls[0].init.body)).toEqual({ code: 'abcd-2345' });
    // Never a remote server.
    expect((await pairWithServer('https://evil.test', 'abcd-2345', fetchFn)).ok).toBe(false);
    expect(calls).toHaveLength(1);
    // A server that refuses is reported, not stored.
    const refused = await pairWithServer('http://localhost:4646', 'x', async () => ({ ok: false, status: 403, json: async () => ({ error: 'That code did not work. Show a new code in the dashboard.' }) }));
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/did not work/) });
    // Short keys are never accepted.
    expect((await pairWithServer('http://127.0.0.1:4646', 'x', async () => ({ ok: true, status: 200, json: async () => ({ key: 'short' }) }))).ok).toBe(false);
  });

  it('the page offers the pairing code and still the key field', () => {
    const html = readFileSync(join(process.cwd(), 'extension', 'options.html'), 'utf8');
    expect(html).toMatch(/id="code"/);
    expect(html).toMatch(/id="key"/);
    expect(html).toMatch(/pairing\.js/);
  });
});

describe('the dashboard card (real browser)', () => {
  let dash; let browser; let available = true;
  beforeAll(async () => {
    try { browser = await launchBrowser(); } catch (err) { available = browserUnavailable(err); return; }
    dash = await startTestDashboard();
  }, 60_000);
  afterAll(async () => { await browser?.close(); await dash?.stop(); });

  it('shows a code in System health, and the extension can pair with it', async (ctx) => {
    if (!available) return ctx.skip();
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    page.setDefaultTimeout(20_000);
    await page.goto(dash.url);
    await waitUntilConnected(page);
    await page.locator('[data-action="toggle-activity-menu"]').first().click();
    await page.getByRole('menuitem', { name: 'System health' }).click();
    await page.locator('#pairingTitle').waitFor({ timeout: 30_000 });
    const card = page.locator('section.pairing');
    await card.getByRole('button', { name: 'Pair the extension' }).click();
    const code = await card.locator('.code').textContent();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const res = await fetch(`${dash.url}/api/extension/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: `chrome-extension://${'a'.repeat(32)}` }, body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
  }, 90_000);
});
