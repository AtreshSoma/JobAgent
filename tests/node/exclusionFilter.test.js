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

  /**
   * Role identity is stated in the TITLE. Matching roleMismatch against the JD
   * body made senior roles disqualify themselves for describing their own
   * responsibilities: measured over the stored corpus, 2,502 of 2,748
   * role_mismatch discards (91%) matched only in the body, "junior" alone
   * accounting for 1,983 — Senior/Lead Data Engineer postings that are the exact
   * target profile, silently deleted for offering to mentor juniors.
   */
  describe('role mismatch is judged on the title, not the body prose', () => {
    it.each([
      'Serve as a mentor to junior team members and promote a culture of curiosity.',
      'Mentor data engineers: guide junior and mid-level engineers, conduct code reviews.',
      'Providing guidance and mentoring to junior engineers.',
      'New grads with strong cross-functional internship/project experience will be considered.',
      'You will work alongside iOS developers and Android developers on the mobile team.',
    ])('keeps a senior role whose body says: %s', (line) => {
      const job = { ...F.azureFabricSenior, jdText: `${F.azureFabricSenior.jdText} ${line}` };
      const r = applyExclusions(job, exclusions, opts);
      expect(r.excluded).toBe(false);
    });

    it.each([
      'Junior Data Engineer',
      'Data Engineer Intern',
      'Entry-Level Analytics Engineer',
      'iOS Developer',
    ])('still discards on the title: %s', (title) => {
      const job = { ...F.azureFabricSenior, title };
      const r = applyExclusions(job, exclusions, opts);
      expect(r.excluded).toBe(true);
      expect(r.category).toBe('role_mismatch');
    });

    it('still discards a body-scoped scope statement from roleMismatchBody', () => {
      const job = { ...F.azureFabricSenior, jdText: `${F.azureFabricSenior.jdText} This is a frontend only role.` };
      const r = applyExclusions(job, exclusions, opts);
      expect(r.excluded).toBe(true);
      expect(r.category).toBe('role_mismatch');
    });
  });

  /**
   * Clearance matching was polarity-blind too: a posting saying the clearance is
   * optional was discarded exactly like one demanding it (48 such rows in the
   * stored corpus).
   */
  describe('security clearance respects how the requirement is phrased', () => {
    it.each([
      'Secret or TS/SCI clearance is a nice to have for this role.',
      'Active TS/SCI clearance preferred.',
      'Candidates are not required to hold an active clearance at the time of application.',
      'A secret clearance is a plus but not required.',
    ])('keeps a role whose clearance is optional: %s', (line) => {
      const job = { ...F.azureFabricSenior, jdText: `${F.azureFabricSenior.jdText} ${line}` };
      const r = applyExclusions(job, exclusions, opts);
      expect(r.excluded).toBe(false);
    });

    it.each([
      'Must hold an active TS/SCI clearance.',
      'Security clearance required. Applicants must be cleared on day one.',
    ])('still discards a hard clearance requirement: %s', (line) => {
      const job = { ...F.azureFabricSenior, jdText: `${F.azureFabricSenior.jdText} ${line}` };
      const r = applyExclusions(job, exclusions, opts);
      expect(r.excluded).toBe(true);
      expect(r.category).toBe('security_clearance');
    });

    it('one hard clearance mention outranks a softened one elsewhere', () => {
      const job = {
        ...F.azureFabricSenior,
        jdText: `${F.azureFabricSenior.jdText} A public trust clearance is preferred. `
          + 'Must hold a clearance before starting.',
      };
      const r = applyExclusions(job, exclusions, opts);
      expect(r.excluded).toBe(true);
      expect(r.category).toBe('security_clearance');
    });
  });

  it('discards postings older than skipOlderThanDays', () => {
    const tooOld = new Date(F.NOW);
    tooOld.setUTCDate(tooOld.getUTCDate() - exclusions.staleness.skipOlderThanDays - 1);
    const job = { ...F.staleHighApplicants, postedAt: tooOld.toISOString() };
    const r = applyExclusions(job, exclusions, opts);
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('stale_posting');
  });

  it('does NOT exclude a clean Azure Fabric senior role', () => {
    const r = applyExclusions(F.azureFabricSenior, exclusions, opts);
    expect(r.excluded).toBe(false);
  });

  it.each(['C2C only', '1099 contract', 'part-time', 'freelance only'])(
    'keeps matching roles regardless of employment arrangement: %s',
    (arrangement) => {
      const job = {
        ...F.azureFabricSenior,
        employmentType: arrangement,
        jdText: `${F.azureFabricSenior.jdText} Employment arrangement: ${arrangement}.`,
      };
      const r = applyExclusions(job, exclusions, opts);
      expect(r.excluded).toBe(false);
      expect(r.category).toBe(null);
    },
  );

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
