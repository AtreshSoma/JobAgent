import { describe, it, expect } from 'vitest';
import { applyExclusions } from '../../src/scoring/exclusionFilter.js';
import { loadTestConfig } from './helpers/testConfig.js';
import * as F from './fixtures/jobs.js';

const { exclusions } = loadTestConfig({ loadEnv: false, env: {} });
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

describe('US-only gate: offshore postings reaching the dashboard', () => {
  const config = loadTestConfig({ loadEnv: false, env: {} });
  const check = (location) => applyExclusions(
    { title: 'Data Engineer', jdText: 'Build data pipelines.', location, postedAt: new Date().toISOString() },
    config.exclusions,
  );

  it('discards the Workday country-prefix formats that were slipping through', () => {
    // These are real location strings observed on the dashboard with
    // `geography.usOnly: true` already enabled. Two independent bugs let them
    // through: the leading ISO country code read as a US state abbreviation
    // ("IN" -> Indiana), and accented city names never matching ASCII markers.
    for (const location of [
      'PHL - TAGUIG CITY',
      'IN-KA-BANGALORE Home Office PW II',
      'IN-TS-HYDERABAD',
      'PH-00-Taguig',
      'BRA - São Paulo',
      'MEX - Mexico City',
      'GBR - London',
    ]) {
      const r = check(location);
      expect(r.excluded, location).toBe(true);
      expect(r.category, location).toBe('geography_mismatch');
    }
  });

  it('matches accented place names written in ASCII in the marker list', () => {
    expect(check('Zürich, Switzerland').excluded).toBe(true);
    expect(check('Bogotá, Colombia').excluded).toBe(true);
    expect(check('São Paulo, Brazil').excluded).toBe(true);
  });

  it('still keeps US locations that share a name or code with a foreign one', () => {
    // The reason the gate is positional rather than a bigger marker list: these
    // must all survive. Dropping a real US job is the worse error.
    for (const location of [
      'Indianapolis, IN', 'IN-Indianapolis', 'CA-San Jose', 'Ontario, CA',
      'Dublin, OH', 'Vienna, VA', 'Athens, GA', 'Cambridge, MA',
      'USA-TX-Austin', 'US-CA-San Francisco', 'New York, NY, United States',
      'Washington, DC', 'Portland, OR', 'New Mexico',
    ]) {
      expect(check(location).excluded, location).toBe(false);
    }
  });

  it('still defers on an unknown location instead of hard-discarding it', () => {
    expect(check('').excluded).toBe(false);
    expect(check('Remote').excluded).toBe(false);
  });
});

describe('multi-location placeholders must not hide an offshore role', () => {
  const config2 = loadTestConfig({ loadEnv: false, env: {} });
  const check = (job) => applyExclusions(
    { title: 'Data Engineer', jdText: 'Build pipelines.', postedAt: new Date().toISOString(), ...job },
    config2.exclusions,
  );

  it('treats an explicit country field as decisive', () => {
    // REGRESSION. A Manulife requisition in Quezon City / Lapu Lapu City reached
    // the board with `usOnly: true` because Workday's LIST endpoint collapses a
    // multi-location req to the literal string "2 Locations". There was no city
    // to match and no country to match, so no marker list could ever have
    // caught it. The per-job detail states `country: "Philippines"` outright,
    // and ground truth must outrank string matching.
    const r = check({ location: '2 Locations', rawMetadata: { country: 'Philippines' } });
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('geography_mismatch');
    expect(r.reason).toMatch(/Philippines/);
  });

  it('keeps a job whose stated country IS the United States', () => {
    for (const country of ['United States', 'USA', 'United States of America']) {
      expect(check({ location: '3 Locations', rawMetadata: { country } }).excluded, country).toBe(false);
    }
  });

  it('discards once the real places are resolved, and keeps US ones', () => {
    expect(check({ location: 'Quezon City; Lapu Lapu City' }).excluded).toBe(true);
    expect(check({ location: 'Boston, MA; Austin, TX' }).excluded).toBe(false);
  });

  it('still defers when the location is genuinely unknown and no country is stated', () => {
    // An aggregate placeholder with no country resolved yet is UNKNOWN, not
    // foreign — hard-discarding it would lose real US multi-site roles.
    expect(check({ location: '2 Locations' }).excluded).toBe(false);
    expect(check({ location: '' }).excluded).toBe(false);
  });
});

describe('ISO country codes from structured ATS fields', () => {
  const cfg3 = loadTestConfig({ loadEnv: false, env: {} });
  const g = (location, country) => applyExclusions(
    { title: 'Data Engineer', jdText: 'x', location, rawMetadata: { country } },
    cfg3.exclusions,
  );

  it('reads a two-letter code as the COUNTRY, not a US state', () => {
    // Verified live against SmartRecruiters: a New York posting is
    // `country: "us"` with the state in `region`; Toronto is `"ca"`, Hyderabad
    // `"in"`, Munich `"de"`. So "ca" means Canada. Treating it as California —
    // by reading the code back out of "Toronto, CA" — is circular and let every
    // Canadian posting through.
    expect(g('Toronto, Ontario', 'ca').excluded).toBe(true);
    expect(g('Hyderabad', 'in').excluded).toBe(true);
    expect(g('Munich', 'de').excluded).toBe(true);
    expect(g('Staines', 'gb').excluded).toBe(true);
  });

  it('keeps US postings however the country is spelled', () => {
    for (const c of ['us', 'US', 'United States', 'USA']) {
      expect(g('New York, NEW YORK', c).excluded, c).toBe(false);
    }
  });

  it('keeps a job when a spelled-out US state contradicts the country code', () => {
    // Bad data, not a foreign role — a spelled-out state or an explicit
    // national marker is strong enough to override; a bare abbreviation is not.
    expect(g('San Francisco, California', 'ca').excluded).toBe(false);
    expect(g('Austin, Texas, United States', 'ca').excluded).toBe(false);
  });

  it('does not fire when no country is stated', () => {
    expect(g('Palo Alto', undefined).excluded).toBe(false);
    expect(g('2 Locations', null).excluded).toBe(false);
  });
});
