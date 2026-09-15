import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserSession, openApplicationPage } from '../src/automation/browser.js';

const dir = mkdtempSync(join(tmpdir(), 'edge-smoke-'));
let session;
try {
  session = await createBrowserSession({
    headless: true,            // headless just for the smoke test
    slowMo: 0,
    channel: 'msedge',
    userDataDir: dir,          // dedicated throwaway profile (no live-Edge clash)
  });
  const nav = await openApplicationPage(session.page, 'https://example.com/');
  const url = session.page.url();
  const title = await session.page.title();
  console.log(JSON.stringify({ ok: true, status: nav.status, url, title, blocked: nav.guard?.blocked }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
} finally {
  try { await session?.close?.(); } catch { /* ignore */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
