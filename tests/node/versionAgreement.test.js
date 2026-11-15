/**
 * The version is set in one place (audit X6). package.json said 0.2.0 while
 * the changelog and the dashboard said v0.2.2, and the MCP server announced a
 * third, hard-coded copy. package.json is the source; the lockfile, the newest
 * changelog entry and every runtime reader must agree, and `npm run verify`
 * checks it on every run.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { versionAgreement } from '../../scripts/releaseNotes.mjs';
import { PACKAGE_VERSION } from '../../src/version.js';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));

describe('versionAgreement', () => {
  const releases = [{ version: 'v1.4.0', date: '2026-01-02' }, { version: 'v1.3.0', date: '2026-01-01' }];

  it('passes when package.json, the lockfile and the newest release agree', () => {
    expect(versionAgreement({ packageVersion: '1.4.0', lockVersions: ['1.4.0', '1.4.0'], releases })).toEqual({ ok: true, version: 'v1.4.0' });
  });

  it('names each disagreement', () => {
    expect(versionAgreement({ packageVersion: '1.3.0', lockVersions: ['1.3.0', '1.3.0'], releases }).error).toMatch(/package\.json 1\.3\.0.*v1\.4\.0/);
    expect(versionAgreement({ packageVersion: '1.4.0', lockVersions: ['1.3.0', '1.4.0'], releases }).error).toMatch(/package-lock\.json/);
  });

  it('skips undated or unversioned entries when finding the newest release', () => {
    const withDraft = [{ date: '2026-01-03', summary: 'notes only' }, ...releases];
    expect(versionAgreement({ packageVersion: '1.4.0', lockVersions: ['1.4.0'], releases: withDraft }).ok).toBe(true);
  });
});

describe('this repository', () => {
  it('agrees on one version everywhere', () => {
    const result = versionAgreement({ packageVersion: pkg.version, lockVersions: [lock.version, lock.packages?.['']?.version] });
    expect(result.error).toBeUndefined();
  });

  it('reads the runtime version from package.json, not a copy', () => {
    expect(PACKAGE_VERSION).toBe(pkg.version);
    expect(read('src/mcp/server.js')).not.toMatch(/version: '\d+\.\d+\.\d+'/);
  });
});
