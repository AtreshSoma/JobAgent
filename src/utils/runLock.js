/**
 * Cross-process run lock: data/.run.lock.
 *
 * The dashboard's `runState.running` flag only excludes runs INSIDE one
 * process. A CLI `npm run discover` (or `watch`) started while the dashboard
 * was running a discovery wrote the same rows at the same time: interleaved
 * upserts, two processes each deciding the ownership of the same posting, and
 * run_log counters that each described half a run. This lock is the
 * cross-process half of the guard.
 *
 * The lock file is created with O_EXCL ('wx'), so exactly one process can
 * create it. A lock whose pid is no longer alive (a crash, a killed terminal)
 * is stale and is taken over; a live holder causes a RunLockError that names
 * it, so the caller can say "a discover run started by the CLI at 09:14 is in
 * progress" instead of a bare "busy".
 */

import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Lock file path under a project root. */
export function runLockPath(root) {
  return join(root, 'data', '.run.lock');
}

/** Thrown when another live process holds the lock. `holder` is its record. */
export class RunLockError extends Error {
  /** @param {object} holder the lock file's contents */
  constructor(holder) {
    super(`a ${holder?.phase ?? 'run'} started by ${holder?.owner ?? 'another process'} `
      + `(pid ${holder?.pid ?? '?'}) at ${holder?.startedAt ?? 'an unknown time'} is still in progress`);
    this.name = 'RunLockError';
    this.holder = holder;
    this.statusCode = 409;
  }
}

/** Is a process with this pid alive? (EPERM means alive but not ours.) */
export function isPidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; }
}

/** The current holder's record, or null when there is no lock file. */
export function readRunLock(root) {
  try { return JSON.parse(readFileSync(runLockPath(root), 'utf8')); } catch { return null; }
}

/**
 * Take the lock or throw RunLockError.
 *
 * @param {object} args
 * @param {string} args.root project root (the lock lives in <root>/data)
 * @param {string} args.owner who is running ('dashboard', 'cli', 'db-maintenance')
 * @param {string} args.phase what is running ('discover', 'score', …)
 * @param {object} [args.deps] { pid, now, isAlive } for tests
 * @returns {{ release: () => void, path: string, record: object }}
 */
export function acquireRunLock({ root, owner, phase, deps = {} } = {}) {
  if (!root) throw new Error('acquireRunLock requires a project root');
  const path = runLockPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const pid = deps.pid ?? process.pid;
  const alive = deps.isAlive ?? isPidAlive;
  const record = {
    pid, owner: String(owner ?? 'unknown'), phase: String(phase ?? 'run'),
    startedAt: (deps.now ?? new Date()).toISOString(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readRunLock(root);
      // A holder that is alive — or a lock we cannot read yet (being written) —
      // wins. Only a provably dead pid is taken over.
      if (holder && !alive(holder.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      throw new RunLockError(holder ?? { owner: 'another process' });
    }
    try { writeSync(fd, JSON.stringify(record)); } finally { closeSync(fd); }
    let released = false;
    return {
      path,
      record,
      release() {
        if (released) return;
        released = true;
        // Only remove OUR lock: a stale-takeover by another process may have
        // replaced it since.
        const current = readRunLock(root);
        if (current && current.pid === pid && current.startedAt === record.startedAt) {
          rmSync(path, { force: true });
        }
      },
    };
  }
  throw new RunLockError(readRunLock(root) ?? { owner: 'another process' });
}
