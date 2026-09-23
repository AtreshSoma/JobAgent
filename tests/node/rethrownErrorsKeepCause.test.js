/**
 * Errors rethrown with a friendlier message keep the original as `cause`, so
 * the underlying failure (ENOENT, the JSON syntax position) is still available
 * to logs and callers. The messages themselves are unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readJson } from '../../src/config/loadConfig.js';
import { createFileApplicationStateStore } from '../../src/apply/applicationState.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jobagent-cause-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** The error a function throws (fails the test if it does not throw). */
function thrown(fn) {
  try { fn(); } catch (err) { return err; }
  throw new Error('expected a throw');
}

describe('rethrown errors keep their cause', () => {
  it('readJson: a missing file keeps the filesystem error', () => {
    const err = thrown(() => readJson(join(dir, 'absent.json')));
    expect(err.message).toMatch(/Config file not found or unreadable: .*absent\.json \(ENOENT\)/);
    expect(err.cause?.code).toBe('ENOENT');
  });

  it('readJson: invalid JSON keeps the SyntaxError', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{ "a": ');
    const err = thrown(() => readJson(file));
    expect(err.message).toMatch(/Config file is not valid JSON/);
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });

  it('application state: an unreadable checkpoint keeps the parse error', () => {
    const file = join(dir, 'state.json');
    writeFileSync(file, 'not json');
    const err = thrown(() => createFileApplicationStateStore(file).load());
    expect(err.message).toMatch(/application state is unreadable/);
    expect(err.cause).toBeInstanceOf(SyntaxError);
  });
});
