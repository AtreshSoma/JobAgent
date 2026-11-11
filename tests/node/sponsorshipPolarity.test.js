/**
 * Polarity regression suite.
 *
 * Every case here was verified against the real stored corpus. The headline bug:
 * the configured affirmative phrase "work visa sponsorship" matched inside
 * "This role is not eligible for work visa sponsorship", so the strongest DENIAL
 * a posting can carry was reported as "Confirmed" — a green badge, +15 weighted
 * score points, and a pass through the sponsorship gate into auto-preparation.
 * All 6 Humana rows labelled Confirmed were explicit refusals.
 */

import { describe, it, expect } from 'vitest';

import {
  detectSponsorshipDenial,
  affirmativeSponsorshipHits,
} from '../../src/utils/sponsorshipLanguage.js';
import { classifySponsorship, SPONSORSHIP } from '../../src/scoring/sponsorshipClassifier.js';
import { applyExclusions } from '../../src/scoring/exclusionFilter.js';
import { scoreJob } from '../../src/scoring/scorer.js';
import { loadTestConfig } from './helpers/testConfig.js';

const { exclusions, scoring, candidate } = loadTestConfig({ loadEnv: false, env: {} });
const AFFIRMATIVE = scoring.sponsorship.affirmativePhrases;

/** Refusals taken verbatim (modulo trimming) from stored postings. */
const REAL_DENIALS = [
  ['Humana / Google — the reported bug', 'This role is not eligible for work visa sponsorship.'],
  ['Humana — third person', 'Humana does not provide work visa sponsorship for this position.'],
  ['Anthropic — colon-led, negation before verb', 'Visa sponsorship: we are not currently able to sponsor visas for fellows.'],
  ['Scale AI', 'Unfortunately, we are not able to sponsor visas, including CPT.'],
  ['Guidehouse', 'No visa sponsorship available for this position.'],
  ['Moderna', 'For this role, we are currently unable to offer immigration sponsorship.'],
  ['Jack Henry', 'This position is ineligible for immigration sponsorship and support.'],
  ['AEG Worldwide', 'Employer does not offer work visa sponsorship for this position.'],
  ['Deloitte — "without" construction', 'Must be legally authorized to work in the United States without the need for employer sponsorship.'],
  ['EPAM', 'EPAM will not provide new H-1B visa sponsorship.'],
  ['General Motors — hyphenated modifier', 'GM does not provide immigration-related sponsorship for this role.'],
  ['Cognizant — slash-joined modifiers', 'Unfortunately, no visa transfer / sponsorship available for this role.'],
  ['YETI', 'The company is not able to sponsor new H-1B petitions.'],
  ['Airbus', 'As a matter of policy, Airbus does not sponsor visas.'],
  ['Symetra — trailing, across "and support"', 'Employer work visa sponsorship and support are not provided.'],
  ['Walmart — trailing modal', 'Immigration sponsorship support will not be available.'],
  ['General Dynamics — "will not be provided"', 'Work visa sponsorship will not be provided for this position.'],
  ['Bare "cannot" + topic-as-verb', 'We cannot sponsor H-1B candidates.'],
  ['Candidate requirement form', 'Candidates must not require sponsorship now or in the future.'],
  ['Terse label form', 'Sponsorship: not available'],
];

/**
 * The Pfizer/Roblox family: the refusal is separated from the noun by an
 * abbreviation-laden parenthetical or a coordination. Both were "Confirmed"
 * before abbreviation periods stopped being treated as sentence boundaries.
 */
const LONG_RANGE_DENIALS = [
  ['Pfizer — parenthetical between noun and refusal',
    'Candidates must be authorized to be employed in the U.S. by any employer. U.S. work visa '
    + 'sponsorship (such as TN, O-1, H-1B, etc.) is not available for this role now or in the future.'],
  ['Johnson, Mirmiran & Thompson — parenthetical after a coordination',
    'Immigration sponsorship or support (e.g. H1B, F-1 CPT/OPT/STEM OPT) is not available for this '
    + 'position, except for qualified candidates eligible for the TN visa classification.'],
  ['Google — abbreviation inside the refusal',
    'This role is not eligible for U.S. immigration sponsorship.'],
];

/** Genuine offers, which must survive untouched. */
const REAL_OFFERS = [
  ['Clera', 'Visa sponsorship is available for this role.'],
  ['BeaconFire', 'Work visa sponsorship available (H-1B, STEM OPT, etc.).'],
  ['Ford', 'Visa sponsorship is available for this position.'],
  ['Deloitte — hedged but affirmative', 'Limited immigration sponsorship may be available.'],
  ['Direct first person', 'We sponsor H-1B and green card applications.'],
  ['Modal', 'We will sponsor qualified candidates.'],
  ['Capability', 'We are able to sponsor work visas.'],
  ['Support form', 'We support visa sponsorship and H-1B transfers.'],
  ['Cap-exempt employer', 'This is a cap-exempt position.'],
];

describe('sponsorship denial detection (strict — it hard-discards)', () => {
  for (const [label, jd] of [...REAL_DENIALS, ...LONG_RANGE_DENIALS]) {
    it(`detects: ${label}`, () => {
      expect(detectSponsorshipDenial(jd).denied).toBe(true);
    });
  }

  it('names the refusal itself, not the surrounding boilerplate', () => {
    const jd = 'Sql server\nAzure / Google Cloud\nAdditional Information\n'
      + 'This role is not eligible for work visa sponsorship.';
    const { evidence } = detectSponsorshipDenial(jd);
    expect(evidence[0]).toBe('is not eligible for work visa sponsorship');
    expect(evidence[0]).not.toMatch(/azure|google cloud|additional information/);
  });

  for (const [label, jd] of REAL_OFFERS) {
    it(`does NOT deny an offer: ${label}`, () => {
      expect(detectSponsorshipDenial(jd).denied).toBe(false);
    });
  }

  it('does not read a negation about something else as a sponsorship refusal', () => {
    const jd = 'We will sponsor candidates who do not require relocation.';
    expect(detectSponsorshipDenial(jd).denied).toBe(false);
    expect(affirmativeSponsorshipHits(jd, AFFIRMATIVE).affirmed).toContain('will sponsor');
  });

  it.each([
    ['inclusive "do not need"', 'We offer H-1B sponsorship. Candidates who do not need sponsorship are also welcome.'],
    ['"with or without"', 'Visa sponsorship available; applicants with or without sponsorship needs welcome.'],
    ['"sponsored" as an adjective', 'Includes company-sponsored certifications. No sponsored relocation.'],
  ])('never hard-discards an offering posting over %s', (_label, jd) => {
    expect(detectSponsorshipDenial(jd).denied).toBe(false);
    expect(applyExclusions({ title: 'Data Engineer', jdText: jd }, exclusions).excluded).toBe(false);
  });

  it('still reads "sponsored" as the visa topic when it is a participle', () => {
    expect(detectSponsorshipDenial('Visas will not be sponsored for this role.').denied).toBe(true);
    expect(detectSponsorshipDenial('H-1B candidates cannot be sponsored.').denied).toBe(true);
  });

  it('treats "not only … we sponsor" as the offer it is', () => {
    const jd = 'Not only do we sponsor H-1B, we also cover relocation.';
    expect(detectSponsorshipDenial(jd).denied).toBe(false);
  });

  it('does not let a negation cross a clause boundary', () => {
    const jd = 'No prior consulting experience needed; visa sponsorship available.';
    expect(detectSponsorshipDenial(jd).denied).toBe(false);
    expect(affirmativeSponsorshipHits(jd, AFFIRMATIVE).affirmed.length).toBeGreaterThan(0);
  });

  it('does not let a negation cross a LINE boundary in a bullet list', () => {
    // JDs are overwhelmingly bullet lists with no terminating periods. If line
    // breaks are not boundaries the whole posting is one clause, and an
    // unrelated "not" suppresses a real offer far below it.
    const jd = '• Must not have gaps in employment\n• Visa sponsorship available';
    expect(affirmativeSponsorshipHits(jd, AFFIRMATIVE).affirmed.length).toBeGreaterThan(0);
  });

  it('is quiet on postings that never mention sponsorship', () => {
    const r = detectSponsorshipDenial('Senior Data Engineer. Azure, Databricks, SQL, Python.');
    expect(r.denied).toBe(false);
    expect(r.evidence).toEqual([]);
  });

  it('handles empty and nullish input', () => {
    for (const v of [undefined, null, '', '   ']) {
      expect(detectSponsorshipDenial(v)).toEqual({ denied: false, evidence: [] });
      expect(affirmativeSponsorshipHits(v, AFFIRMATIVE)).toEqual({ affirmed: [], suppressed: [] });
    }
  });
});

describe('affirmative phrases are never credited inside a refusal', () => {
  for (const [label, jd] of [...REAL_DENIALS, ...LONG_RANGE_DENIALS]) {
    it(`no affirmative survives: ${label}`, () => {
      expect(affirmativeSponsorshipHits(jd, AFFIRMATIVE).affirmed).toEqual([]);
    });
  }

  it('reports the negated mention as suppressed so the reason is explainable', () => {
    const { affirmed, suppressed } = affirmativeSponsorshipHits(
      'This role is not eligible for work visa sponsorship.', AFFIRMATIVE,
    );
    expect(affirmed).toEqual([]);
    expect(suppressed).toContain('work visa sponsorship');
  });

  it('credits an offer even when the same JD refuses elsewhere for another visa', () => {
    const jd = 'We will sponsor H-1B transfers.\nWe do not offer O-1 sponsorship.';
    expect(affirmativeSponsorshipHits(jd, AFFIRMATIVE).affirmed.length).toBeGreaterThan(0);
  });
});

describe('classifySponsorship', () => {
  it('returns Denied — never Confirmed — for the reported Humana posting', () => {
    const r = classifySponsorship(
      { company: 'Humana', jdText: 'This role is not eligible for work visa sponsorship.' },
      scoring.sponsorship,
    );
    expect(r.status).toBe(SPONSORSHIP.DENIED);
    expect(r.signals[0]).toMatch(/not eligible for work visa sponsorship/);
  });

  it('still Confirms a genuine offer', () => {
    const r = classifySponsorship(
      { company: 'Clera', jdText: 'Visa sponsorship is available for this role.' },
      scoring.sponsorship,
    );
    expect(r.status).toBe(SPONSORSHIP.CONFIRMED);
    expect(r.signals.length).toBeGreaterThan(0);
  });

  it('an explicit JD refusal outranks a connector willingToSponsor flag', () => {
    const r = classifySponsorship(
      {
        company: 'Somewhere',
        willingToSponsor: true,
        jdText: 'This position is not eligible for visa sponsorship.',
      },
      scoring.sponsorship,
    );
    expect(r.status).toBe(SPONSORSHIP.DENIED);
  });

  it('a refusal outranks the likely-sponsor company list', () => {
    // Deloitte is configured as a likely sponsor; this posting still says no.
    const r = classifySponsorship(
      { company: 'Deloitte', jdText: 'We are unable to offer immigration sponsorship for this role.' },
      scoring.sponsorship,
    );
    expect(r.status).toBe(SPONSORSHIP.DENIED);
  });

  it('falls back to Likely on the company list when the JD is silent', () => {
    const r = classifySponsorship(
      { company: 'Infosys', jdText: 'Senior Data Engineer. Azure and Databricks.' },
      scoring.sponsorship,
    );
    expect(r.status).toBe(SPONSORSHIP.LIKELY);
  });

  it('reports Unconfirmed with no signals when the JD is silent on sponsorship', () => {
    const r = classifySponsorship(
      { company: 'Nowhere Inc', jdText: 'Senior Data Engineer. Azure, Databricks, SQL, Python.' },
      scoring.sponsorship,
    );
    expect(r.status).toBe(SPONSORSHIP.UNCONFIRMED);
    expect(r.signals).toEqual([]);
  });
});

describe('Denied never out-scores a merely unknown posting', () => {
  const job = { title: 'Senior Data Engineer', source: 'workday', jdText: 'Azure Databricks Python SQL' };
  const points = (status) => {
    const s = scoreJob(job, { scoring, candidate, sponsorship: { status } });
    return s.breakdown.sponsorshipFeasibility.points
      + s.breakdown.companySponsorshipLikelihood.points;
  };

  it('scores Denied at zero, below Unconfirmed', () => {
    expect(points('Denied')).toBe(0);
    expect(points('Unconfirmed')).toBeGreaterThan(0);
    expect(points('Confirmed')).toBeGreaterThan(points('Unconfirmed'));
  });
});

describe('exclusionFilter catches refusals the config phrase list cannot enumerate', () => {
  const base = {
    title: 'Senior Data Engineer',
    company: 'Humana',
    location: 'Remote, US',
    postedAt: new Date().toISOString(),
  };

  it('discards the reported Humana posting as sponsorship_denial', () => {
    const r = applyExclusions(
      { ...base, jdText: 'Azure / Google Cloud. This role is not eligible for work visa sponsorship.' },
      exclusions,
    );
    expect(r.excluded).toBe(true);
    expect(r.category).toBe('sponsorship_denial');
  });

  for (const [label, jd] of REAL_DENIALS) {
    it(`discards: ${label}`, () => {
      const r = applyExclusions({ ...base, jdText: jd }, exclusions);
      expect(r.excluded).toBe(true);
      expect(r.category).toBe('sponsorship_denial');
    });
  }

  for (const [label, jd] of REAL_OFFERS) {
    it(`keeps a sponsoring employer: ${label}`, () => {
      const r = applyExclusions({ ...base, jdText: `${jd} Azure Databricks Python SQL.` }, exclusions);
      expect(r.excluded).toBe(false);
    });
  }
});
