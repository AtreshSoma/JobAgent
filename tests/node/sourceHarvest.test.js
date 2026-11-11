/**
 * ATS coordinate harvesting — pure parsing/merging, no I/O.
 *
 * Every URL shape below was taken from real rows in the local job database, so
 * these tests pin the harvester against the URLs it will actually meet.
 */
import { describe, it, expect } from 'vitest';

import {
  extractAtsCoordinate, coordinateKey, harvestCoordinates,
  configuredCoordinateKeys, mergeCoordinates,
} from '../../src/search/sourceHarvest.js';

describe('extractAtsCoordinate', () => {
  it('reads Greenhouse board tokens, including the embed form', () => {
    expect(extractAtsCoordinate('https://boards.greenhouse.io/databricks/jobs/123'))
      .toEqual({ ats: 'greenhouse', slug: 'databricks' });
    expect(extractAtsCoordinate('https://job-boards.greenhouse.io/grafanalabs/jobs/99'))
      .toEqual({ ats: 'greenhouse', slug: 'grafanalabs' });
    expect(extractAtsCoordinate('https://boards.greenhouse.io/embed/job_app?for=natera&token=5'))
      .toEqual({ ats: 'greenhouse', slug: 'natera' });
  });

  it('reads Lever, Ashby and SmartRecruiters slugs', () => {
    expect(extractAtsCoordinate('https://jobs.lever.co/shieldai/abc-def'))
      .toEqual({ ats: 'lever', slug: 'shieldai' });
    expect(extractAtsCoordinate('https://jobs.ashbyhq.com/1password/uuid-here'))
      .toEqual({ ats: 'ashby', slug: '1password' });
    expect(extractAtsCoordinate('https://jobs.smartrecruiters.com/AbbVie/744000-data-engineer'))
      .toEqual({ ats: 'smartrecruiters', slug: 'AbbVie' });
  });

  it('reads a SmartRecruiters identifier out of the API detail URL too', () => {
    expect(extractAtsCoordinate('https://api.smartrecruiters.com/v1/companies/VTekisConsultingLLP/postings/129'))
      .toEqual({ ats: 'smartrecruiters', slug: 'VTekisConsultingLLP' });
  });

  it('reads a Workday host, tenant and public site name', () => {
    expect(extractAtsCoordinate('https://bah.wd1.myworkdayjobs.com/en-US/BAH_Jobs/job/USA-VA/Data-Engineer_R012'))
      .toEqual({
        ats: 'workday', host: 'bah.wd1.myworkdayjobs.com', tenant: 'bah', site: 'BAH_Jobs',
      });
    // No locale segment.
    expect(extractAtsCoordinate('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US/Engineer_JR1'))
      .toEqual({
        ats: 'workday', host: 'nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia',
        site: 'NVIDIAExternalCareerSite',
      });
    // Bare board URL.
    expect(extractAtsCoordinate('https://kemper.wd5.myworkdayjobs.com/Kemper_Careers'))
      .toEqual({
        ats: 'workday', host: 'kemper.wd5.myworkdayjobs.com', tenant: 'kemper', site: 'Kemper_Careers',
      });
  });

  it('refuses to guess a Workday site when the URL has no /job/ marker', () => {
    // Guessing "last segment" here would harvest a job title as a site name and
    // produce a tenant entry that 404s on every future run.
    expect(extractAtsCoordinate('https://acme.wd1.myworkdayjobs.com/en-US/Careers/details/Senior-Data-Engineer_R1'))
      .toBeNull();
  });

  it('rejects navigation paths that are not company slugs', () => {
    expect(extractAtsCoordinate('https://jobs.lever.co/search?q=data')).toBeNull();
    expect(extractAtsCoordinate('https://boards.greenhouse.io/')).toBeNull();
    expect(extractAtsCoordinate('https://jobs.ashbyhq.com/sitemap.xml')).toBeNull();
  });

  it('ignores URLs that name no enumerable board', () => {
    expect(extractAtsCoordinate('https://www.linkedin.com/jobs/view/12345')).toBeNull();
    expect(extractAtsCoordinate('https://careers.airbnb.com/positions/9')).toBeNull();
    expect(extractAtsCoordinate('not a url')).toBeNull();
    expect(extractAtsCoordinate('')).toBeNull();
    expect(extractAtsCoordinate(null)).toBeNull();
    expect(extractAtsCoordinate('ftp://boards.greenhouse.io/acme')).toBeNull();
  });

  it('reads a Workable account from its public apply board', () => {
    expect(extractAtsCoordinate('https://apply.workable.com/acme-data/j/ABC123/'))
      .toEqual({ ats: 'workable', slug: 'acme-data' });
    // The jobs.workable.com view URL does not name the account.
    expect(extractAtsCoordinate('https://jobs.workable.com/view/abc/data-engineer-at-acme')).toBeNull();
  });
});

describe('coordinateKey', () => {
  it('compares board slugs case-insensitively', () => {
    expect(coordinateKey({ ats: 'greenhouse', slug: 'Acme' }))
      .toBe(coordinateKey({ ats: 'greenhouse', slug: 'acme' }));
  });

  it('keys a Workday tenant on host + tenant + site together', () => {
    const a = { ats: 'workday', host: 'h.wd1.myworkdayjobs.com', tenant: 'h', site: 'A' };
    const b = { ...a, site: 'B' };
    expect(coordinateKey(a)).not.toBe(coordinateKey(b));
  });
});

describe('harvestCoordinates', () => {
  it('counts sightings and remembers the employer name', () => {
    const found = harvestCoordinates([
      { url: 'https://jobs.lever.co/shieldai/1', company: 'Shield AI' },
      { url: 'https://jobs.lever.co/shieldai/2', company: 'Shield AI' },
      { url: 'https://www.linkedin.com/jobs/view/3', company: 'Nope' },
      { url: 'https://boards.greenhouse.io/natera/jobs/4', company: 'Natera' },
    ]);
    expect(found.size).toBe(2);
    const lever = found.get('lever|shieldai');
    expect(lever.count).toBe(2);
    expect([...lever.companies]).toEqual(['Shield AI']);
  });

  it('survives malformed rows', () => {
    expect(harvestCoordinates([null, {}, { url: 123 }, undefined]).size).toBe(0);
    expect(harvestCoordinates().size).toBe(0);
  });
});

describe('configuredCoordinateKeys', () => {
  const config = {
    sources: [
      { adapter: 'greenhouse', boards: ['databricks', 'stripe'] },
      { adapter: 'lever', boards: ['spotify'] },
      {
        adapter: 'workday',
        tenants: [{ host: 'nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia', site: 'NVIDIAExternalCareerSite' }],
      },
      { adapter: 'careers', companies: [{ ats: 'ashby', slug: 'ramp' }] },
      { adapter: 'apify', options: {} },
    ],
  };

  it('covers board lists, workday tenants and careers-page ATS pins', () => {
    const keys = configuredCoordinateKeys(config);
    expect(keys.has('greenhouse|databricks')).toBe(true);
    expect(keys.has('lever|spotify')).toBe(true);
    expect(keys.has('workday|nvidia.wd5.myworkdayjobs.com|nvidia|NVIDIAExternalCareerSite')).toBe(true);
    expect(keys.has('ashby|ramp')).toBe(true);
    expect(keys.has('greenhouse|not-configured')).toBe(false);
  });

  it('handles an empty or partial config without throwing', () => {
    expect(configuredCoordinateKeys({}).size).toBe(0);
    expect(configuredCoordinateKeys({ sources: [{ adapter: 'greenhouse' }] }).size).toBe(0);
  });
});

describe('mergeCoordinates', () => {
  const base = () => ({
    sources: [
      { id: 'gh', adapter: 'greenhouse', boards: ['databricks'] },
      { id: 'wd', adapter: 'workday', tenants: [] },
      { id: 'ashby', adapter: 'ashby', boards: [] },
    ],
  });

  it('appends new boards and tenants', () => {
    const { config, added } = mergeCoordinates(base(), [
      { ats: 'greenhouse', slug: 'natera' },
      { ats: 'ashby', slug: '1password' },
      {
        ats: 'workday', host: 'bah.wd1.myworkdayjobs.com', tenant: 'bah',
        site: 'BAH_Jobs', company: 'Booz Allen Hamilton',
      },
    ]);
    expect(config.sources[0].boards).toEqual(['databricks', 'natera']);
    expect(config.sources[2].boards).toEqual(['1password']);
    expect(config.sources[1].tenants[0]).toMatchObject({
      host: 'bah.wd1.myworkdayjobs.com', tenant: 'bah', site: 'BAH_Jobs',
      company: 'Booz Allen Hamilton',
    });
    expect(added).toEqual({ greenhouse: 1, ashby: 1, workday: 1 });
  });

  it('leaves searchText off a harvested tenant so it tracks the profile', () => {
    // Writing a literal here would freeze the board to whatever role happened
    // to be current the day it was harvested; the adapter derives its phrases
    // from candidate.targetTitles precisely when the key is absent.
    const { config } = mergeCoordinates(base(), [
      { ats: 'workday', host: 'h.wd1.myworkdayjobs.com', tenant: 'h', site: 'S' },
    ]);
    expect(config.sources[1].tenants[0]).not.toHaveProperty('searchText');
  });

  it('still pins a searchText when one is passed deliberately', () => {
    const { config } = mergeCoordinates(base(), [
      { ats: 'workday', host: 'h.wd1.myworkdayjobs.com', tenant: 'h', site: 'S', searchText: 'clinical' },
    ]);
    expect(config.sources[1].tenants[0].searchText).toBe('clinical');
  });

  it('never mutates the input config', () => {
    const original = base();
    mergeCoordinates(original, [{ ats: 'greenhouse', slug: 'natera' }]);
    expect(original.sources[0].boards).toEqual(['databricks']);
  });

  it('skips coordinates already configured, and duplicates within one batch', () => {
    const { config, added, skipped } = mergeCoordinates(base(), [
      { ats: 'greenhouse', slug: 'databricks' },
      { ats: 'greenhouse', slug: 'natera' },
      { ats: 'greenhouse', slug: 'natera' },
    ]);
    expect(config.sources[0].boards).toEqual(['databricks', 'natera']);
    expect(added).toEqual({ greenhouse: 1 });
    expect(skipped).toBe(2);
  });

  it('skips an ATS that has no source to receive it rather than inventing one', () => {
    const { config, added, skipped } = mergeCoordinates(base(), [{ ats: 'lever', slug: 'shieldai' }]);
    expect(config.sources).toHaveLength(3);
    expect(added).toEqual({});
    expect(skipped).toBe(1);
  });

  it('never reorders or prunes existing entries', () => {
    // An empty board today may simply have no openings today; pruning is a
    // different decision from adding and is not this function's job.
    const cfg = base();
    cfg.sources[0].boards = ['zeta', 'alpha', 'middle'];
    const { config } = mergeCoordinates(cfg, [{ ats: 'greenhouse', slug: 'new' }]);
    expect(config.sources[0].boards).toEqual(['zeta', 'alpha', 'middle', 'new']);
  });
});
