/**
 * Loading .env must print nothing: dotenv >= 17 logs an "injected env" banner
 * to STDOUT unless told to be quiet, which would corrupt `doctor --json` and
 * anything else whose stdout is parsed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config/loadConfig.js';

describe('loadConfig .env loading', () => {
  it('writes nothing to stdout', () => {
    const root = mkdtempSync(join(tmpdir(), 'dotenv-'));
    writeFileSync(join(root, '.env'), 'JOB_AGENT_DOTENV_QUIET_PROBE=1\n');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // No config/ in this root, so it throws after .env has been loaded.
      expect(() => loadConfig({ root })).toThrow(/Config file not found/);
      expect(process.env.JOB_AGENT_DOTENV_QUIET_PROBE).toBe('1');
      expect(out).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      log.mockRestore();
      delete process.env.JOB_AGENT_DOTENV_QUIET_PROBE;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
