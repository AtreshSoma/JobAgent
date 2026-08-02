/**
 * Workday posting URLs, and the stored-row repair for the ones already written.
 *
 * REGRESSION. `mapJob` built links with `new URL(externalPath, 'https://'+host)`.
 * `externalPath` is root-relative (`/job/Remote-Kentucky/Lead-Cloud---Data-
 * Platform-Engineer_R-422722`), and a root-relative path resolves against the
 * ORIGIN — discarding the `/{locale}/{site}` segments that identify which
 * career site the job lives on. Every Workday link ever stored was a 404:
 * 15,733 of 15,758 rows, the largest source in the database, 124 of them live
 * on the board. Verified against Workday: without the site segment 404, with
 * it 200.
 */
import { describe, it, expect } from 'vitest';

import { mapJob } from '../../src/search/adapters/workday.js';
import { repairWorkdayUrl } from '../../scripts/repairJobUrls.mjs';

const CFG = {
  host: 'humana.wd5.myworkdayjobs.com',
  tenant: 'humana',
  site: 'Humana_External_Career_Site',
  company: 'Humana',
  locale: '',
};

const POSTING = {
  title: 'Lead Cloud & Data Platform Engineer',
  externalPath: '/job/Remote-Kentucky/Lead-Cloud---Data-Platform-Engineer_R-422722',
  locationsText: 'Remote Kentucky',
  postedOn: 'Posted 8 Days Ago',
  bulletFields: ['R-422722'],
};

describe('mapJob URL construction', () => {
  it('keeps the site segment, without which Workday answers 404', () => {
    expect(mapJob(POSTING, CFG).url).toBe(
      'https://humana.wd5.myworkdayjobs.com/Humana_External_Career_Site'
      + '/job/Remote-Kentucky/Lead-Cloud---Data-Platform-Engineer_R-422722',
    );
  });

  it('includes the locale when the tenant configures one', () => {
    expect(mapJob(POSTING, { ...CFG, locale: 'en-US' }).url).toBe(
      'https://humana.wd5.myworkdayjobs.com/en-US/Humana_External_Career_Site'
      + '/job/Remote-Kentucky/Lead-Cloud---Data-Platform-Engineer_R-422722',
    );
  });

  it('never resolves the path against the bare origin', () => {
    // The exact shape of the bug: host followed straight by /job/.
    expect(mapJob(POSTING, CFG).url).not.toMatch(/myworkdayjobs\.com\/job\//);
  });

  it('does not double-prefix a site that already appears in the path', () => {
    // Citi's site is literally "2", which occurs inside requisition numbers —
    // any "is the site already here?" test false-positives on exactly the
    // tenants it would corrupt, so the join must be unconditional.
    const citi = { ...CFG, host: 'citi.wd5.myworkdayjobs.com', tenant: 'citi', site: '2' };
    const url = mapJob({ ...POSTING, externalPath: '/job/Pune/Data-Engineer-C11_25842' }, citi).url;
    expect(url).toBe('https://citi.wd5.myworkdayjobs.com/2/job/Pune/Data-Engineer-C11_25842');
  });

  it('tolerates a path that arrives without its leading slash', () => {
    expect(mapJob({ ...POSTING, externalPath: 'job/X/Y_R1' }, CFG).url)
      .toBe('https://humana.wd5.myworkdayjobs.com/Humana_External_Career_Site/job/X/Y_R1');
  });

  it('falls back to the board URL when there is no path at all', () => {
    expect(mapJob({ ...POSTING, externalPath: '' }, CFG).url)
      .toBe('https://humana.wd5.myworkdayjobs.com/Humana_External_Career_Site');
  });

  it('always emits a parseable absolute URL', () => {
    for (const path of ['/job/a b/c', '/job/ünïcode/R1', '/job/x?y=1']) {
      const { url } = mapJob({ ...POSTING, externalPath: path }, CFG);
      expect(() => new URL(url)).not.toThrow();
    }
  });
});

describe('repairWorkdayUrl (stored rows)', () => {
  const byHost = new Map([
    ['humana.wd5.myworkdayjobs.com', { site: 'Humana_External_Career_Site' }],
    ['acme.wd1.myworkdayjobs.com', { site: 'Careers', locale: 'en-US' }],
  ]);

  it('reinserts the missing site segment', () => {
    expect(repairWorkdayUrl(
      'https://humana.wd5.myworkdayjobs.com/job/Remote-Kentucky/Lead_R-422722', byHost,
    )).toBe('https://humana.wd5.myworkdayjobs.com/Humana_External_Career_Site/job/Remote-Kentucky/Lead_R-422722');
  });

  it('reinserts the locale too when the tenant has one', () => {
    expect(repairWorkdayUrl('https://acme.wd1.myworkdayjobs.com/job/X/Y_R1', byHost))
      .toBe('https://acme.wd1.myworkdayjobs.com/en-US/Careers/job/X/Y_R1');
  });

  it('leaves an already-correct URL untouched', () => {
    const good = 'https://humana.wd5.myworkdayjobs.com/Humana_External_Career_Site/job/X/Y_R1';
    expect(repairWorkdayUrl(good, byHost)).toBeNull();
  });

  it('leaves non-Workday and unknown-host URLs alone', () => {
    expect(repairWorkdayUrl('https://boards.greenhouse.io/acme/jobs/1', byHost)).toBeNull();
    expect(repairWorkdayUrl('https://other.wd9.myworkdayjobs.com/job/X_R1', byHost)).toBeNull();
    expect(repairWorkdayUrl('not a url', byHost)).toBeNull();
    expect(repairWorkdayUrl(null, byHost)).toBeNull();
  });

  it('is idempotent — re-running never double-prefixes', () => {
    const broken = 'https://humana.wd5.myworkdayjobs.com/job/X/Y_R1';
    const once = repairWorkdayUrl(broken, byHost);
    expect(repairWorkdayUrl(once, byHost)).toBeNull();
  });
});
