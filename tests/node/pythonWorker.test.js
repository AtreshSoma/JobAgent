/**
 * Long-lived Python workers (audit R17). Python started two or three times per
 * job (tailor, PDF HTML, letter DOCX, units), importing python-docx each time.
 * A small pool of `tailor_cli.py --serve` processes answers request after
 * request; a timed-out or crashed worker is replaced.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PythonPool } from '../../src/resume/pythonWorker.js';
import { pythonExe } from '../../src/resume/pythonEnv.js';

const REPO = join(import.meta.dirname, '..', '..');
const EXAMPLE = join(REPO, 'resumes', 'base', 'MASTER_RESUME.example.docx');

/** A fake worker: answers each line with `answer(request)` after `delayMs`. */
function fakeSpawn({ answer = (r) => ({ ok: true, echo: r.mode }), delayMs = 0, log = [] } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 1000 + log.length;
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
    child.unref = () => {};
    log.push(child);
    let buffer = '';
    child.stdin.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const req = JSON.parse(line);
        const reply = answer(req);
        if (reply === 'hang') continue;
        if (reply === 'crash') { setTimeout(() => child.emit('close', 1), delayMs); continue; }
        setTimeout(() => child.stdout.write(`${JSON.stringify({ _id: req._id, ...reply })}\n`), delayMs);
      }
    });
    child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0)));
    return child;
  };
}

let pool;
afterEach(async () => { await pool?.close(); pool = null; });

describe('the pool', () => {
  it('answers many requests with one worker', async () => {
    const log = [];
    pool = new PythonPool({ size: 1, spawn: fakeSpawn({ log }) });
    const replies = await Promise.all(['a', 'b', 'c'].map((mode) => pool.request({ mode })));
    expect(replies.map((r) => r.echo)).toEqual(['a', 'b', 'c']);
    expect(log).toHaveLength(1);
  });

  it('runs up to `size` requests at once', async () => {
    const log = [];
    pool = new PythonPool({ size: 2, spawn: fakeSpawn({ log, delayMs: 30 }) });
    await Promise.all([1, 2, 3, 4].map((n) => pool.request({ mode: `m${n}` })));
    expect(log).toHaveLength(2);
  });

  it('a request that times out kills its worker, and the next one gets a fresh one', async () => {
    const log = [];
    pool = new PythonPool({ size: 1, spawn: fakeSpawn({ log, answer: (r) => (r.mode === 'slow' ? 'hang' : { ok: true }) }) });
    await expect(pool.request({ mode: 'slow' }, { timeoutMs: 50 })).rejects.toThrow(/timed out after 50ms/);
    expect(log[0].killed).toBe(true);
    await expect(pool.request({ mode: 'fast' })).resolves.toMatchObject({ ok: true });
    expect(log).toHaveLength(2);
  });

  it('a worker that dies fails its request and is replaced', async () => {
    const log = [];
    pool = new PythonPool({ size: 1, spawn: fakeSpawn({ log, answer: (r) => (r.mode === 'die' ? 'crash' : { ok: true }) }) });
    await expect(pool.request({ mode: 'die' })).rejects.toThrow(/stopped/);
    await expect(pool.request({ mode: 'ok' })).resolves.toMatchObject({ ok: true });
    expect(log).toHaveLength(2);
  });

  it('an idle worker is let go', async () => {
    const log = [];
    pool = new PythonPool({ size: 1, idleMs: 20, spawn: fakeSpawn({ log }) });
    await pool.request({ mode: 'x' });
    await new Promise((r) => setTimeout(r, 80));
    expect(pool.size()).toBe(0);
  });
});

describe('with the real tailor', { timeout: 120_000 }, () => {
  it('serves several requests from one interpreter, and is faster than starting each time', async () => {
    let started = 0;
    const { spawn } = await import('node:child_process');
    const exe = pythonExe(process.env, { root: REPO });
    const script = join(REPO, 'src', 'resume', 'tailor_cli.py');
    pool = new PythonPool({
      size: 1,
      spawn: () => { started += 1; return spawn(exe, [script, '--serve'], { stdio: ['pipe', 'pipe', 'pipe'] }); },
    });
    const t0 = performance.now();
    for (let i = 0; i < 6; i += 1) {
      const reply = await pool.request({ mode: 'units', master_path: EXAMPLE });
      expect(reply.ok).toBe(true);
    }
    const pooled = performance.now() - t0;
    expect(started).toBe(1);
    const t1 = performance.now();
    for (let i = 0; i < 3; i += 1) {
      await new Promise((resolve, reject) => {
        const child = spawn(exe, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
        child.on('close', resolve).on('error', reject);
        child.stdin.end(JSON.stringify({ mode: 'units', master_path: EXAMPLE }));
      });
    }
    const perOneShot = (performance.now() - t1) / 3;
    // Six pooled requests cost less than three fresh starts would for six.
    expect(pooled).toBeLessThan(perOneShot * 6);
  });
});
