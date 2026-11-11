/**
 * S8a — offshore Workday requisitions must not reach the board with no location.
 *
 * Live evidence: 3,955 stored Workday rows with a read JD had an EMPTY
 * location (the list row's "2 Locations" was blanked, and hydrating from the
 * detail cache restored the text but not the place), 193 of them name
 * India/Philippines cities, and the only two Apply-tier Workday rows were
 * Accenture `/job/Hyderabad/…` postings. Three independent fixes, each tested.
 */
import { describe, it, expect } from 'vitest';

import { mapJob, locationFromExternalPath, run as runWorkday } from '../../src/search/adapters/workday.js';
import { applyExclusions, bodyLocationEvidence } from '../../src/scoring/exclusionFilter.js';
import { loadTestConfig } from './helpers/testConfig.js';

const config = loadTestConfig({ loadEnv: false, env: {} });
const geo = config.exclusions.geography;
const cfg = { host: 'accenture.wd103.myworkdayjobs.com', tenant: 'accenture', site: 'AccentureCareers', company: 'Accenture' };

const ACCENTURE_JD = [
  'Project Role : Data Engineer',
  'Project Role Description : Design, develop and maintain data solutions for data generation, collection, and processing.',
  'Must have skills : Data Engineering',
  'Minimum 5 year(s) of experience is required',
  'Additional Information:',
  '- This position is based at our Hyderabad office.',
  '- A 15 years full time education is required.',
].join('\n');

describe('the /job/<Location>/ path segment', () => {
  it('reads the primary place from the requisition path', () => {
    expect(locationFromExternalPath('/job/Hyderabad/Data-Engineer_ATCI-5731785-S2070050-1')).toBe('Hyderabad');
    expect(locationFromExternalPath('/job/Bellevue-Washington/Sr-Analyst--Finance_REQ353622')).toBe('Bellevue Washington');
    expect(locationFromExternalPath('/job/IN-KA-Bangalore/Data-Engineer_R1')).toBe('IN-KA-Bangalore');
    // A path with no location segment carries no place.
    expect(locationFromExternalPath('/job/Sr-Product-Managers--Technical_REQ362138')).toBe('');
    expect(locationFromExternalPath('')).toBe('');
  });

  it('fills a blanked "2 Locations" row, and marks it as the primary place only', () => {
    const job = mapJob({
      title: 'Data Engineer', externalPath: '/job/Hyderabad/Data-Engineer_ATCI-5731785-S2070050-1',
      locationsText: '2 Locations', postedOn: 'Posted Today',
    }, cfg);
    expect(job.location).toBe('Hyderabad');
    expect(job.rawMetadata.locationFromUrl).toBe(true);
    expect(job.rawMetadata.locationAggregate).toBe('2 Locations');
  });

  it('never replaces a location the list row states', () => {
    const job = mapJob({ title: 'T', externalPath: '/job/Hyderabad/T_1', locationsText: 'Austin, TX' }, cfg);
    expect(job.location).toBe('Austin, TX');
    expect(job.rawMetadata.locationFromUrl).toBeUndefined();
  });

  it('the Accenture Hyderabad requisition is now discarded by the US-only gate', () => {
    const job = mapJob({
      title: 'Data Engineer', externalPath: '/job/Hyderabad/Data-Engineer_ATCI-5731785-S2070050-1', locationsText: '2 Locations',
    }, cfg);
    job.jdText = ACCENTURE_JD;
    const verdict = applyExclusions(job, config.exclusions, { candidate: config.candidate });
    expect(verdict.excluded).toBe(true);
    expect(verdict.category).toBe('geography_mismatch');
  });
});

describe('detail-cache hydration restores the location', () => {
  it('a reused description brings its stored location back', async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ total: 1, jobPostings: [{ title: 'Data Engineer', externalPath: '/job/Data-Engineer_R1', locationsText: '2 Locations' }] }),
    });
    const { jobs } = await runWorkday({ tenants: [{ ...cfg, searchText: '' }] }, {
      fetchImpl, maxRetries: 0,
      workdayDetailCache: () => ({ jdText: ACCENTURE_JD, location: 'Bengaluru; Hyderabad' }),
    });
    expect(jobs[0].location).toBe('Bengaluru; Hyderabad');
    expect(jobs[0].rawMetadata.detailReused).toBe(true);
  });
});

describe('description location evidence when the location is blank', () => {
  it('discards a blank-location posting whose body says it is based offshore', () => {
    expect(bodyLocationEvidence(ACCENTURE_JD, geo)).toMatch(/hyderabad/);
    const verdict = applyExclusions({ title: 'Data Engineer', jdText: ACCENTURE_JD, location: '' }, { geography: geo });
    expect(verdict.excluded).toBe(true);
    expect(verdict.reason).toContain('description places the role outside the US');
  });

  it('ignores boilerplate mentions and any sentence that also names a US place', () => {
    // Capital One-style boilerplate on a US role: a mention, not a location sentence.
    expect(bodyLocationEvidence('We have offices in India, the Philippines and the UK.', geo)).toBeNull();
    expect(bodyLocationEvidence('This role is based in Hyderabad or Austin, Texas.', geo)).toBeNull();
    expect(bodyLocationEvidence('Location: Remote, United States', geo)).toBeNull();
    expect(bodyLocationEvidence('This position is based in our McLean, VA office.', geo)).toBeNull();
    expect(bodyLocationEvidence('', geo)).toBeNull();
  });

  it('does not override a stated location', () => {
    const verdict = applyExclusions({ title: 'Data Engineer', jdText: ACCENTURE_JD, location: 'Austin, TX' }, { geography: geo });
    expect(verdict.excluded).toBe(false);
  });
});
