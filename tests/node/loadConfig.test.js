import { describe, it, expect } from 'vitest';
import { loadConfig, readJson, CONFIG_FILES, PROJECT_ROOT } from '../../src/config/loadConfig.js';

/**
 * This is the one place that loads the REAL local configuration, and it asserts
 * only its SHAPE.
 *
 * It used to assert values: the author's own `fullName`, a specific
 * sponsorship flag, a specific target title. Those assertions encoded one
 * person's personal data as a test expectation, could never pass for any other
 * user, and went red the moment the local config was replaced with a template.
 * What is actually worth guarding here is that every configured file loads,
 * parses, validates against its schema, and arrives with the right types.
 *
 * Everything that needs concrete candidate values reads the fictional profile in
 * tests/node/fixtures/config via `loadTestConfig()`.
 */
describe('loadConfig (integration with the real config files)', () => {
  it('loads, validates, and bundles every configured file', () => {
    const config = loadConfig({ loadEnv: false, env: {} });
    expect(Object.keys(CONFIG_FILES).every((k) => k in config)).toBe(true);
  });

  it('produces a candidate profile of the expected shape', () => {
    const { candidate } = loadConfig({ loadEnv: false, env: {} });
    expect(typeof candidate.identity.fullName).toBe('string');
    expect(candidate.identity.fullName.length).toBeGreaterThan(0);
    expect(typeof candidate.contact.email).toBe('string');
    expect(typeof candidate.workAuthorization.requiresSponsorship).toBe('boolean');
    expect(Array.isArray(candidate.targetTitles)).toBe(true);
    expect(candidate.targetTitles.length).toBeGreaterThan(0);
  });

  it('produces scoring config of the expected shape', () => {
    const { scoring } = loadConfig({ loadEnv: false, env: {} });
    expect(Array.isArray(scoring.keywords.azureFabric)).toBe(true);
    expect(typeof scoring.tiers.apply).toBe('number');
  });

  it('returns a frozen bundle', () => {
    const config = loadConfig({ loadEnv: false, env: {} });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('readJson throws a clear error for a missing file', () => {
    expect(() => readJson(`${PROJECT_ROOT}/config/does_not_exist.json`)).toThrow(/not found or unreadable/);
  });

  it('applies runtime settings from env', () => {
    expect(loadConfig({ loadEnv: false, env: {} }).runtime.mode).toBe('DRY_RUN');
    expect(loadConfig({ loadEnv: false, env: { RUN_MODE: 'PREPARE' } }).runtime.mode).toBe('PREPARE');
  });
});
