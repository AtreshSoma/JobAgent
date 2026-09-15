/**
 * Nationwide US coverage.
 *
 * The US-only discovery gate decided with a five-entry marker list, so any US
 * city sharing a name with a foreign one lost: measured against real postings
 * it silently discarded 15 of 39 sampled US locations — including Dublin OH,
 * Vienna VA, Ontario CA and Athens GA — before they could be scored. These
 * tests pin coverage of all 50 states, DC, and the territories.
 */
import { describe, it, expect } from 'vitest';

import { loadTestConfig } from './helpers/testConfig.js';
import { applyExclusions } from '../../src/scoring/exclusionFilter.js';
import {
  US_STATES, US_STATE_COUNT, matchUsState, usLocationSignal, leadingForeignCountry,
} from '../../src/utils/usGeography.js';

const config = loadTestConfig({ loadEnv: false, env: {} });
const keeps = (location) => !applyExclusions(
  { title: 'Data Engineer', jdText: 'Build pipelines.', location },
  config.exclusions,
  { now: new Date('2026-07-25T00:00:00Z') },
).excluded;

describe('US state recognition', () => {
  it('knows all 50 states, DC, and the inhabited territories', () => {
    // 50 states + DC + PR + GU + VI + AS + MP.
    expect(US_STATE_COUNT).toBe(56);
    for (const state of ['California', 'Texas', 'Wyoming', 'Alaska', 'Hawaii',
      'North Dakota', 'Rhode Island', 'West Virginia']) {
      expect(matchUsState(`Somewhere, ${state}`)?.name, state).toBeTruthy();
    }
    expect(Object.values(US_STATES)).toContain('DC');
    expect(Object.values(US_STATES)).toContain('PR');
  });

  it('reads USPS codes only when they stand alone in upper case', () => {
    expect(matchUsState('Dublin, OH')).toMatchObject({ code: 'OH', strength: 'abbreviation' });
    expect(matchUsState('Austin, TX 78701')).toMatchObject({ code: 'TX' });
    // Lower-case English words that happen to spell state codes must not count.
    for (const location of ['work in a team', 'hybrid or remote', 'call me maybe', 'de facto lead']) {
      expect(matchUsState(location), location).toBeNull();
    }
  });

  it('prefers a spelled-out state over a bare code', () => {
    expect(usLocationSignal('Morrisville, North Carolina')).toMatchObject({
      isUs: true, strength: 'name', state: 'NC',
    });
    expect(usLocationSignal('Remote - United States')).toMatchObject({
      isUs: true, strength: 'national',
    });
    expect(usLocationSignal('Berlin, Germany')).toMatchObject({ isUs: false });
  });
});

describe('the US-only gate keeps jobs from every state', () => {
  it('keeps US cities that share a name with a foreign city', () => {
    // Every one of these was discarded before: the city matched the foreign
    // list and nothing matched the five-entry US list.
    const shared = [
      'Dublin, OH', 'Vienna, VA', 'Ontario, CA', 'Athens, GA', 'Rome, GA',
      'Berlin, CT', 'Milan, TN', 'Paris, TX', 'Hamburg, NY', 'Waterloo, IA',
      'Stockholm, WI', 'Peru, IN', 'Delhi, CA', 'Cairo, IL', 'Warsaw, IN',
      'Cambridge, MA', 'Manchester, NH', 'Birmingham, AL', 'Moscow, ID',
      'Oxford, MS', 'Reading, PA', 'Toledo, OH', 'Naples, FL', 'Odessa, TX',
    ];
    const dropped = shared.filter((location) => !keeps(location));
    expect(dropped, `wrongly discarded: ${dropped.join(' | ')}`).toEqual([]);
  });

  it('keeps a job in every single state, by name and by code', () => {
    const dropped = [];
    for (const [name, code] of Object.entries(US_STATES)) {
      const properName = name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
      if (!keeps(`Springfield, ${properName}`)) dropped.push(properName);
      if (!keeps(`Springfield, ${code}`)) dropped.push(code);
    }
    expect(dropped, `wrongly discarded: ${dropped.join(' | ')}`).toEqual([]);
  });

  it('keeps nationwide and remote-US phrasings', () => {
    for (const location of ['United States', 'Remote, US', 'Remote - Anywhere in the US',
      'US - Remote', 'Nationwide', 'Remote (Continental US)']) {
      expect(keeps(location), location).toBe(true);
    }
  });

  it('still discards genuinely foreign locations', () => {
    for (const location of ['Toronto, Ontario, Canada', 'London, United Kingdom',
      'Berlin, Germany', 'Bengaluru, India', 'Sydney, Australia', 'Dublin, Ireland',
      'Vienna, Austria', 'Paris, France', 'Athens, Greece', 'Vancouver, BC, Canada',
      'Mexico City, Mexico', 'Tokyo, Japan', 'Hyderabad, Telangana, India']) {
      expect(keeps(location), location).toBe(false);
    }
  });

  it('resolves an unknown or ambiguous location in favour of keeping the job', () => {
    // A blank location is deferred to scoring, never hard-discarded.
    expect(keeps('')).toBe(true);
    expect(keeps('Chicago')).toBe(true);
    // "Berlin, DE" is Germany's country CODE and Delaware's state code, with a
    // town called Berlin in both. Nothing in a location string can settle that,
    // so it is kept and the human sees one row to reject — the opposite bias is
    // what made fifteen US cities disappear without trace.
    expect(keeps('Berlin, DE')).toBe(true);
  });
});

describe('the dashboard reports which states it actually covers', () => {
  it('groups open jobs by state and counts the coverage', async () => {
    const { openDatabase } = await import('../../src/logging/db.js');
    const { dashboardStats } = await import('../../src/dashboard/data.js');
    const db = openDatabase({ path: ':memory:' });
    const add = (id, location, tier = 'Priority', score = 90) => db.upsertJob({
      id, company: `Co-${id}`, title: 'Data Engineer', url: `https://example.com/${id}`,
      source: 'greenhouse', status: 'scored', location, tier, score,
    });
    add('a', 'Dublin, OH');
    add('b', 'Columbus, Ohio');
    add('c', 'Austin, TX');
    add('d', 'Remote - United States');
    add('e', '');
    add('f', 'Vienna, VA', 'Queue', 60);

    const stats = dashboardStats(db, { now: new Date('2026-07-25T00:00:00Z') });
    expect(stats.byState.OH).toMatchObject({ count: 2, name: 'Ohio' });
    expect(stats.byState.TX.count).toBe(1);
    expect(stats.byState.VA.count).toBe(1);
    // A nationwide posting names no state, and is reported as such rather than
    // being attributed to one.
    expect(stats.byState.US.count).toBe(1);
    expect(stats.byState.unknown.count).toBe(1);

    expect(stats.coverage).toMatchObject({ statesCovered: 3, statesPossible: US_STATE_COUNT });
    expect(stats.coverage.nationwide).toBe(1);
    expect(stats.coverage.unstated).toBe(1);
    // Strong fits are tracked per state too, so a state full of weak matches is
    // not mistaken for real coverage.
    expect(stats.byState.OH.strong).toBe(2);
    expect(stats.byState.VA.strong).toBe(0);
    db.close();
  });
});

describe('every configured search asks for the whole country', () => {
  it('never narrows a search to one state or metro', () => {
    // The gate fix restores US jobs the pipeline already found. This guards the
    // other half: a search scoped to "Phoenix, AZ" would narrow coverage at the
    // source, where no amount of downstream filtering can get it back.
    const offenders = [];
    for (const source of config.jobboards?.sources ?? []) {
      const searches = [
        ...((source.options?.actors ?? []).map((a) => [a.label ?? a.actorId, a.input?.location])),
        ...((source.queries ?? []).filter((q) => q && typeof q === 'object')
          .map((q) => [q.label ?? source.id, q.location ?? q.params?.location])),
      ];
      for (const [label, location] of searches) {
        if (!location) continue;
        const signal = usLocationSignal(location);
        // Nationwide phrasings are fine; a specific state or city is not.
        const nationwide = signal.strength === 'national' || /^remote$/i.test(location.trim());
        if (!nationwide) offenders.push(`${source.id}/${label}: "${location}"`);
      }
    }
    expect(offenders, `sub-national searches: ${offenders.join(' | ')}`).toEqual([]);
  });
});

describe('leadingForeignCountry — ISO country prefix in ATS location strings', () => {
  it('reads a three-letter country prefix, which no US state code can collide with', () => {
    expect(leadingForeignCountry('PHL - TAGUIG CITY')).toMatchObject({ code: 'PHL', country: 'Philippines' });
    expect(leadingForeignCountry('GBR - London')).toMatchObject({ country: 'United Kingdom' });
    expect(leadingForeignCountry('BRA - São Paulo')).toMatchObject({ country: 'Brazil' });
  });

  it('reads a two-letter country prefix ONLY in country-region-city shape', () => {
    // REGRESSION: "IN" here is India, but it is also the USPS code for Indiana.
    // Misreading it gave the posting a US signal, and the US-only gate then
    // required a foreign COUNTRY NAME to overrule that signal — which a city
    // like Bangalore never supplies. Every offshore posting in this Workday
    // format therefore passed a filter configured to reject it.
    expect(leadingForeignCountry('IN-KA-BANGALORE Home Office')).toMatchObject({ country: 'India' });
    expect(leadingForeignCountry('IN-TS-HYDERABAD')).toMatchObject({ country: 'India' });
    // Region token may be numeric when the employer leaves it unset.
    expect(leadingForeignCountry('PH-00-Taguig')).toMatchObject({ country: 'Philippines' });
  });

  it('never reads a US state code as a country', () => {
    // Two letters WITHOUT a region token stays American: dropping a real US job
    // is the worse error, so the ambiguous shape resolves toward keeping it.
    expect(leadingForeignCountry('CA-San Jose')).toBeNull();
    expect(leadingForeignCountry('IN-Indianapolis')).toBeNull();
    // An explicit US/USA prefix is never foreign, even in country-region shape.
    expect(leadingForeignCountry('USA-TX-Austin')).toBeNull();
    expect(leadingForeignCountry('US-CA-San Francisco')).toBeNull();
  });

  it('returns null for ordinary location strings', () => {
    for (const s of ['New York, NY, United States', 'Plano, Texas', 'Remote', '', null]) {
      expect(leadingForeignCountry(s), String(s)).toBeNull();
    }
  });
});
