import { describe, it, expect } from 'vitest';
import { applyExclusions } from '../../src/scoring/exclusionFilter.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import * as F from './fixtures/jobs.js';

const { exclusions } = loadConfig({ loadEnv: false, env: {} });
const opts = { now: F.NOW };

describe('exclusionFilter', () => {
  it('ALWAYS discards explicit no-sponsorship JDs', () => {
    const r = applyExclusions(F.noSponsorship, exclusions, opts);
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('sponsorship_denial');
  });

  it('discards clearance-required roles without an allowance phrase', () => {
    const r = applyExclusions(F.clearanceRequired, exclusions, opts);
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('security_clearance');
  });

  it('keeps a clearance role when an allowance phrase is present', () => {
    const job = { ...F.clearanceRequired, jdText: F.clearanceRequired.jdText + ' Clearance not required for visa holders. open to visa holders' };
    const r = applyExclusions(job, exclusions, opts);
    expect(r.excluded).toBe(false);
  });

  it('discards junior/entry-level roles', () => {
    const r = applyExclusions(F.juniorRole, exclusions, opts);
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('role_mismatch');
  });

  it('discards postings older than skipOlderThanDays', () => {
    const r = applyExclusions(F.staleHighApplicants, exclusions, opts);
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('stale_posting');
  });

  it('does NOT exclude a clean Azure Fabric senior role', () => {
    const r = applyExclusions(F.azureFabricSenior, exclusions, opts);
    expect(r.excluded).toBe(false);
  });

  it('flags (not discards) older high-applicant roles within skip window', () => {
    const job = { ...F.azureFabricSenior, postedAt: '2026-05-25T00:00:00Z', applicantCount: 350 };
    const r = applyExclusions(job, exclusions, opts);
    expect(r.excluded).toBe(false);
    expect(r.flags).toContain('low_priority_high_applicants');
  });

  describe('US-only location gate', () => {
    it('discards a clearly non-US remote role', () => {
      const job = { ...F.azureFabricSenior, location: 'Remote - Mexico' };
      const r = applyExclusions(job, exclusions, opts);
      expect(r.excluded).toBe(true);
      expect(r.category).toBe('geography_mismatch');
    });

    it('discards a foreign city location', () => {
      const job = { ...F.azureFabricSenior, location: 'Warsaw, Poland' };
      const r = applyExclusions(job, exclusions, opts);
      expect(r.excluded).toBe(true);
      expect(r.category).toBe('geography_mismatch');
    });

    it('keeps US locations that contain country-like substrings', () => {
      for (const loc of ['New Mexico, US', 'Indianapolis, IN', 'Washington, DC', 'United States', 'Remote - US']) {
        const job = { ...F.azureFabricSenior, location: loc };
        expect(applyExclusions(job, exclusions, opts).excluded).toBe(false);
      }
    });

    it('does not discard an unknown/blank location', () => {
      const job = { ...F.azureFabricSenior, location: '' };
      expect(applyExclusions(job, exclusions, opts).excluded).toBe(false);
    });
  });
});
