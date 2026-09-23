/**
 * A second launch reuses the running dashboard instead of starting another.
 *
 * Double-clicking the launcher twice used to start a second dashboard on 4647
 * against the same database. These tests stand up REAL local HTTP servers on
 * ephemeral ports: one shaped like a Job Agent dashboard, one that is some other
 * app, and one that never answers.
 */
import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeRunningDashboard, runApp } from '../../src/cli/app.js';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); })));
});

/** Listen on an ephemeral 127.0.0.1 port with the given handler. */
async function serve(handler) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

const jobAgentStatus = (req, res) => {
  if (req.url === '/api/run/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ running: false, phase: null, cancelRequested: false, startedAt: null }));
  } else {
    res.writeHead(404).end();
  }
};

describe('probeRunningDashboard', () => {
  it('recognizes a Job Agent dashboard by its run-status shape', async () => {
    const port = await serve(jobAgentStatus);
    expect(await probeRunningDashboard(port)).toBe(`http://127.0.0.1:${port}`);
  });

  it('does not mistake another app answering 200 JSON for Job Agent', async () => {
    const port = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    expect(await probeRunningDashboard(port)).toBeNull();
  });

  it('gives up after the timeout on a port that accepts but never answers', async () => {
    const port = await serve(() => { /* hang */ });
    const started = Date.now();
    expect(await probeRunningDashboard(port, { timeoutMs: 200 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns null for a closed port', async () => {
    const port = await serve(jobAgentStatus);
    await new Promise((r) => servers.pop().close(r));
    expect(await probeRunningDashboard(port)).toBeNull();
  });
});

describe('runApp with a dashboard already on the requested port', () => {
  function deps(overrides = {}) {
    return {
      loadConfig: () => ({ root: '/nonexistent-root', candidate: {} }),
      openDatabase: vi.fn(() => { throw new Error('must not open the database'); }),
      startDashboard: vi.fn(() => { throw new Error('must not start a second server'); }),
      findFreePort: vi.fn(async (p) => p),
      openBrowser: vi.fn(() => true),
      ...overrides,
    };
  }
  const parsedFor = (port, flags = []) => ({ positionals: ['app'], options: { port: String(port) }, flags: new Set(flags) });

  it('opens the running one and exits cleanly without a second server', async () => {
    const port = await serve(jobAgentStatus);
    const d = deps();
    const result = await runApp({ parsed: parsedFor(port), env: {}, deps: d });
    expect(result).toMatchObject({ ok: true, alreadyRunning: true, url: `http://127.0.0.1:${port}` });
    expect(d.openBrowser).toHaveBeenCalledWith(`http://127.0.0.1:${port}`, expect.any(Object));
    expect(d.openDatabase).not.toHaveBeenCalled();
    expect(d.startDashboard).not.toHaveBeenCalled();
    expect(d.findFreePort).not.toHaveBeenCalled();
  });

  it('respects APP_NO_OPEN when reusing the running dashboard', async () => {
    const port = await serve(jobAgentStatus);
    const d = deps();
    const result = await runApp({ parsed: parsedFor(port), env: { APP_NO_OPEN: 'true' }, deps: d });
    expect(result.alreadyRunning).toBe(true);
    expect(d.openBrowser).not.toHaveBeenCalled();
  });

  it('falls back to port scanning when the busy port is some other app', async () => {
    const port = await serve((req, res) => res.writeHead(404).end());
    const d = deps({ findFreePort: vi.fn(async () => { throw new Error('scanned'); }), openDatabase: () => ({ close() {} }) });
    await expect(runApp({ parsed: parsedFor(port, ['no-open']), env: { LOG_LEVEL: 'silent' }, deps: {
      ...d,
      JobLogger: class { error() {} },
      createPinoLogger: () => ({ logger: {} }),
    } })).rejects.toThrow('scanned');
    expect(d.findFreePort).toHaveBeenCalledWith(port);
  });
});
