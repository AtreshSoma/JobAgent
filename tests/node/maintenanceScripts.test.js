import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const script = fileURLToPath(new URL('../../scripts/repair-applied-status.mjs', import.meta.url));
const dirs = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('repair-applied-status maintenance safety', () => {
  it('is a dry-run by default and writes only with --apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'repair-applied-'));
    dirs.push(root);
    const dbPath = join(root, 'data', 'applied_jobs.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const seed = new DatabaseSync(dbPath);
    seed.exec(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, status TEXT, applied INTEGER, applied_at TEXT
    )`);
    seed.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?)')
      .run('job-1', 'ready_for_submit', 1, '2026-07-14T12:00:00Z');
    seed.close();

    const dry = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain('[dry-run] Would repair 1 row(s)');
    let check = new DatabaseSync(dbPath);
    expect(check.prepare('SELECT status FROM jobs WHERE id = ?').get('job-1').status)
      .toBe('ready_for_submit');
    check.close();

    const apply = spawnSync(process.execPath, [script, '--apply'], { cwd: root, encoding: 'utf8' });
    expect(apply.status).toBe(0);
    expect(apply.stdout).toContain('Repairing 1 row(s)');
    check = new DatabaseSync(dbPath);
    expect(check.prepare('SELECT status FROM jobs WHERE id = ?').get('job-1').status)
      .toBe('submitted');
    check.close();
  });
});
