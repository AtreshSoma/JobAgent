import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPinoLogger, JobLogger, rotateRunLogs } from '../../src/logging/jobLogger.js';
import { openDatabase } from '../../src/logging/db.js';

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('logging — run log files', () => {
  const dirs = [];
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'jobagent-logs-')); dirs.push(d); return d; };
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('creates the file only on the first record, at info by default', async () => {
    const dir = tmp();
    const { logger, file } = createPinoLogger({ runId: 'r1', logDir: dir, consoleLevel: 'silent' });
    expect(existsSync(file)).toBe(false);
    logger.debug('not at info');
    await settle();
    expect(existsSync(file)).toBe(false);
    logger.info('hello');
    await settle();
    expect(readFileSync(file, 'utf8')).toMatch(/"msg":"hello"/);
  });

  it('JobLogger.warn/info/debug reach pino (they used to vanish), and forRun tags the run id', async () => {
    const dir = tmp();
    const { logger: pino, file } = createPinoLogger({ runId: 'session', logDir: dir, consoleLevel: 'silent' });
    const db = openDatabase({ path: ':memory:' });
    const jl = new JobLogger({ db, logger: pino, runId: 'session' });
    jl.warn('config reload failed: x');
    jl.info({ phase: 'discover' }, 'could not open run_log row');
    const run = jl.forRun('run-42');
    run.warn('per run');
    expect(run.runId).toBe('run-42');
    await settle();
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/config reload failed/);
    expect(text).toMatch(/"phase":"discover"/);
    expect(text).toMatch(/"runId":"run-42".*per run|per run.*"runId":"run-42"/);
    expect(db.listEvents()).toHaveLength(0); // diagnostics are not audit events
    db.close();
  });

  it('rotation drops stale empty logs and keeps the newest 30 / 50 MB', () => {
    const dir = tmp();
    const old = (Date.now() - 3 * 86_400_000) / 1000;
    writeFileSync(join(dir, 'run-empty-old.log'), '');
    utimesSync(join(dir, 'run-empty-old.log'), old, old);
    writeFileSync(join(dir, 'run-empty-new.log'), '');
    for (let i = 0; i < 32; i += 1) {
      const p = join(dir, `run-${String(i).padStart(2, '0')}.log`);
      writeFileSync(p, 'x');
      utimesSync(p, old + i, old + i);
    }
    writeFileSync(join(dir, 'other.txt'), 'keep');
    const removed = rotateRunLogs(dir);
    expect(removed).toContain('run-empty-old.log');
    expect(removed).toContain('run-00.log');
    const left = readdirSync(dir).filter((n) => n.startsWith('run-'));
    expect(left).toHaveLength(30);
    expect(readdirSync(dir)).toContain('other.txt');
    // The empty newest file plus five 1-byte files fit in 5 bytes; 24 go.
    expect(rotateRunLogs(dir, { keepBytes: 5 })).toHaveLength(24);
  });
});
