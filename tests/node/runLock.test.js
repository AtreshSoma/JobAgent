import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireRunLock, RunLockError, readRunLock, runLockPath, isPidAlive } from '../../src/utils/runLock.js';

describe('runLock — cross-process run exclusion', () => {
  const roots = [];
  const root = () => { const r = mkdtempSync(join(tmpdir(), 'jobagent-lock-')); roots.push(r); return r; };
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  it('one holder at a time, with the holder named in the error', () => {
    const r = root();
    const lock = acquireRunLock({ root: r, owner: 'dashboard', phase: 'discover' });
    expect(readRunLock(r)).toMatchObject({ pid: process.pid, owner: 'dashboard', phase: 'discover' });
    try { acquireRunLock({ root: r, owner: 'cli', phase: 'score' }); throw new Error('no'); } catch (err) {
      expect(err).toBeInstanceOf(RunLockError);
      expect(err.statusCode).toBe(409);
      expect(err.holder).toMatchObject({ owner: 'dashboard', phase: 'discover' });
    }
    lock.release();
    lock.release(); // idempotent
    expect(existsSync(runLockPath(r))).toBe(false);
    acquireRunLock({ root: r, owner: 'cli', phase: 'score' }).release();
  });

  it('takes over a lock whose pid is dead', () => {
    const r = root();
    mkdirSync(join(r, 'data'), { recursive: true });
    writeFileSync(runLockPath(r), JSON.stringify({ pid: 999999, owner: 'cli', phase: 'watch', startedAt: 'x' }));
    const lock = acquireRunLock({ root: r, owner: 'dashboard', phase: 'score', deps: { isAlive: () => false } });
    expect(readRunLock(r).owner).toBe('dashboard');
    lock.release();
  });

  it('isPidAlive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(12, () => { throw Object.assign(new Error(), { code: 'ESRCH' }); })).toBe(false);
  });
});
