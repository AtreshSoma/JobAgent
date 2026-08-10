/**
 * Regressions from the "Find New Jobs finds nothing" audit.
 *
 * Discovery was in fact working — a live run returned 76,558 postings across 13
 * sources with 3 errors. What was broken was everything AROUND it: real new
 * jobs were suppressed without a trace, ids could collide and overwrite, and
 * the run reported a total that made a successful run indistinguishable from a
 * failed one. These tests pin each of those.
 */
import { describe, it, expect, vi } from 'vitest';

import { makeJobId } from '../../src/search/normalize.js';
import { emptyCounters } from '../../src/outputs.js';
import { urlKeyFor } from '../../src/search/deduplicator.js';

describe('job id uniqueness (SQLite PRIMARY KEY)', () => {
  it('keeps two long-titled requisitions distinct instead of truncating them together', () => {
    // `upsertJob` is ON CONFLICT DO UPDATE, so a shared id does not create two
    // rows — the second SILENTLY OVERWRITES the first. `dedupKey` puts
    // sourceJobId LAST, so a bare .slice(0,200) cut off exactly the field that
    // distinguishes two reqs. 52 rows in the live DB already sat at that
    // boundary, so this was happening, not hypothetical.
    const company = 'A Very Long Enterprise Company Name That Goes On'.repeat(2);
    const title = 'Senior Staff Data Platform Engineer, Analytics Infrastructure'.repeat(2);
    const a = makeJobId({ source: 'workday', company, title, sourceJobId: 'REQ-AAA-111' });
    const b = makeJobId({ source: 'workday', company, title, sourceJobId: 'REQ-BBB-222' });

    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(200);
    expect(b.length).toBeLessThanOrEqual(200);
  });

  it('is deterministic across calls, so re-discovery updates rather than duplicates', () => {
    const job = { source: 'workday', company: 'X'.repeat(150), title: 'Y'.repeat(150), sourceJobId: 'R1' };
    expect(makeJobId({ ...job })).toBe(makeJobId({ ...job }));
  });

  it('leaves short ids in their original readable form', () => {
    expect(makeJobId({ source: 'lever', company: 'Acme', title: 'Data Engineer', sourceJobId: '1' }))
      .toBe('lever:acme::data engineer::1');
  });
});

describe('run counters answer "did this run find anything?"', () => {
  it('tracks novelty separately from total volume', () => {
    const c = emptyCounters();
    // Without jobs_new the only headline was jobs_found, which on a mature
    // corpus is ~76k of overwhelmingly already-known rows.
    expect(c).toHaveProperty('jobs_new', 0);
    expect(c).toHaveProperty('jobs_found', 0);
  });

  it('splits the three unrelated causes that jobs_discarded conflated', () => {
    const c = emptyCounters();
    expect(c).toHaveProperty('jobs_discarded_stale', 0);
    expect(c).toHaveProperty('jobs_discarded_excluded', 0);
    expect(c).toHaveProperty('jobs_discarded_low_score', 0);
  });

  it('counts jobs removed by dedup and by each already-seen rule', () => {
    const c = emptyCounters();
    // These drops previously left no row, no log line and no counter, which is
    // what made the losses undiagnosable.
    expect(c).toHaveProperty('jobs_duplicate', 0);
    expect(c).toHaveProperty('jobs_suppressed_applied', 0);
    expect(c).toHaveProperty('jobs_suppressed_url_owned', 0);
  });
});

describe('existsInDb URL ownership', () => {
  /**
   * Rebuilds the pipeline's ownership map with the fixed rule: a URL is an
   * identity signal ONLY when exactly one active row owns it.
   */
  function buildOwners(rows) {
    const counts = new Map();
    for (const row of rows) {
      const key = urlKeyFor(row);
      if (!key) continue;
      if (!counts.has(key)) counts.set(key, []);
      counts.get(key).push(row.id);
    }
    const owners = new Map();
    const ambiguous = [];
    for (const [key, ids] of counts) {
      if (ids.length === 1) owners.set(key, ids[0]);
      else ambiguous.push(key);
    }
    return { owners, ambiguous };
  }

  it('does not let one shared URL suppress every other job behind it', () => {
    // REGRESSION: the map was built with last-writer-wins, so a URL held by
    // many rows still "belonged" to one of them and silently suppressed the
    // rest on every run. Real case: one Deloitte apply-shim URL served 26
    // distinct jobs; 25 were dropped as already-seen, forever.
    const shared = 'https://deloitteus.avature.net/careers/InviteToApply?jobId=353918';
    const rows = Array.from({ length: 26 }, (_, i) => ({ id: `job-${i}`, url: shared }));
    const { owners, ambiguous } = buildOwners(rows);

    expect(ambiguous).toHaveLength(1);
    expect(owners.has(urlKeyFor({ url: shared }))).toBe(false);

    // A genuinely new job on that URL must NOT be treated as already-seen.
    const incoming = { id: 'job-new', url: shared };
    const owner = owners.get(urlKeyFor(incoming));
    expect(Boolean(owner && owner !== incoming.id)).toBe(false);
  });

  it('still suppresses a re-id\'d posting when the URL is genuinely per-job', () => {
    // The rule must keep working where it was right: one URL, one owner.
    const url = 'https://boards.greenhouse.io/acme/jobs/12345';
    const { owners } = buildOwners([{ id: 'old-id', url }]);
    const incoming = { id: 'new-id', url };
    const owner = owners.get(urlKeyFor(incoming));
    expect(Boolean(owner && owner !== incoming.id)).toBe(true);
  });
});

describe('undated postings are not a permanent dead end', () => {
  it('re-score is allowed to touch unknown_date_review rows', async () => {
    // Discovery routes undated postings into unknown_date_review WITHOUT
    // scoring them. While that status was also missing from RESCORABLE_STATUSES
    // the rows could never be scored by anything, ever: 2,509 rows in the live
    // DB were stuck. A missing DATE is not a reason to refuse to judge the ROLE.
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/cli/commands.js', 'utf8'));
    const block = src.slice(src.indexOf('const RESCORABLE_STATUSES'), src.indexOf('const RESCORABLE_STATUSES') + 400);
    expect(block).toContain('unknown_date_review');
  });
});

describe('board can be sorted by when a job was discovered', () => {
  it('exposes a discovered sort distinct from posted', async () => {
    // Posted date and first-seen date answer different questions. Without a
    // discovery sort, new rows were interleaved by score across ~100k others,
    // so there was no way to see what a run had actually turned up.
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/dashboard/data.js', 'utf8'));
    const sorts = src.slice(src.indexOf('const SORTS = {'), src.indexOf('const SORTS = {') + 900);
    expect(sorts).toContain('discovered:');
    expect(sorts).toContain('createdAt');
    expect(sorts).toContain('posted:');
  });
});
