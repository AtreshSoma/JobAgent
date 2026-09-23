/**
 * S8b — a configured likely-sponsor name must match the EMPLOYER, not a
 * substring of some other employer's name. `company.includes("ey")` gave
 * Honeywell, Cooley, Stanley and Berkeley Research Group a "Likely" badge.
 * Company names below are real false positives from the live board.
 */
import { describe, it, expect } from 'vitest';

import { classifySponsorship, SPONSORSHIP } from '../../src/scoring/sponsorshipClassifier.js';
import { loadTestConfig } from './helpers/testConfig.js';

const config = loadTestConfig({ loadEnv: false, env: {} });
const status = (company) => classifySponsorship({ company, jdText: 'Build data pipelines.' }, config.scoring.sponsorship).status;

describe('likely-sponsor employer matching', () => {
  it.each([
    'Berkeley Research Group', 'Cooley LLP', 'Honeywell Aerospace', 'stanleygroup', 'Central Moloney',
    'Metadata Systems', 'Sapient Industries', 'Ibmex',
  ])('%s is NOT a likely sponsor', (company) => {
    expect(status(company)).not.toBe(SPONSORSHIP.LIKELY);
  });

  it.each(['EY', 'Ernst & Young', 'Ernst & Young LLP', 'IBM Corporation', 'Meta Platforms', 'Tata Consultancy Services'])(
    '%s IS a likely sponsor', (company) => {
      expect(status(company)).toBe(SPONSORSHIP.LIKELY);
    },
  );
});
