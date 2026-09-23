/**
 * The suite runs against a throwaway workspace, never the developer's own.
 * (See tests/node/globalSetup.js for why.)
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT, loadConfig } from '../../src/config/loadConfig.js';
import { DEFAULT_DB_PATH } from '../../src/logging/db.js';
import { FIXTURE_CONFIG_DIR, fixtureCandidate } from './helpers/testConfig.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('test workspace isolation', () => {
  it('PROJECT_ROOT is the temp root from JOB_AGENT_ROOT, not the checkout', () => {
    expect(process.env.JOB_AGENT_ROOT).toBeTruthy();
    expect(PROJECT_ROOT).toBe(resolve(process.env.JOB_AGENT_ROOT));
    expect(PROJECT_ROOT).not.toBe(REPO);
  });

  it('the default database lives in the temp root', () => {
    expect(DEFAULT_DB_PATH.startsWith(PROJECT_ROOT)).toBe(true);
  });

  it('a plain loadConfig() reads the fictional fixture profile and example resume', () => {
    const config = loadConfig({ loadEnv: false, env: {} });
    expect(config.candidate.identity.fullName).toBe(fixtureCandidate.identity.fullName);
    expect(config.profile).toBeNull(); // saved profiles are never copied in
    expect(existsSync(join(PROJECT_ROOT, 'resumes', 'base', 'MASTER_RESUME.docx'))).toBe(true);
    expect(existsSync(join(FIXTURE_CONFIG_DIR, 'candidate.json'))).toBe(true);
  });
});
