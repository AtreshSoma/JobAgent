import { describe, it, expect } from 'vitest';
import { loadConfig, readJson, CONFIG_FILES, PROJECT_ROOT } from '../../src/config/loadConfig.js';

describe('loadConfig (integration with real config files)', () => {
  it('loads, validates, and bundles all real configs', () => {
    const config = loadConfig({ loadEnv: false, env: {} });
    expect(Object.keys(CONFIG_FILES).every((k) => k in config)).toBe(true);
    expect(config.candidate.identity.fullName).toBe('Atresh Somayajula');
    expect(config.candidate.workAuthorization.requiresSponsorship).toBe(true);
    expect(Array.isArray(config.scoring.keywords.azureFabric)).toBe(true);
    expect(config.runtime.mode).toBe('DRY_RUN');
  });

  it('returns a frozen bundle', () => {
    const config = loadConfig({ loadEnv: false, env: {} });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('readJson throws a clear error for a missing file', () => {
    expect(() => readJson(`${PROJECT_ROOT}/config/does_not_exist.json`)).toThrow(/not found or unreadable/);
  });

  it('applies runtime settings from env', () => {
    const config = loadConfig({ loadEnv: false, env: { RUN_MODE: 'PREPARE' } });
    expect(config.runtime.mode).toBe('PREPARE');
  });
});
