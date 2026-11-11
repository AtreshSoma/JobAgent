import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  emptyCounters, countBy, writeScoredJobs, writeQueuedJobs, writeAllArtifacts,
} from '../../src/outputs.js';
import { LIFECYCLE, lifecycleForTier, isQueuedTier, QUEUED_TIERS } from '../../src/lifecycle.js';
import { TIERS } from '../../src/scoring/explainScore.js';

describe('outputs', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'outputs-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('emptyCounters has all lifecycle counters zeroed', () => {
    expect(emptyCounters()).toEqual({
      jobs_found: 0, jobs_scored: 0, jobs_queued: 0, jobs_discarded: 0,
      jobs_unknown_date_review: 0, jobs_prepared: 0, jobs_assisted: 0, jobs_submitted: 0,
      // Cancellation + incremental discovery outcomes are counted too, so a
      // cancelled or skip-unchanged run is never misread as "found nothing".
      jobs_cancelled: 0, jobs_skipped_unchanged: 0,
      // NOVELTY. `jobs_found` counts every posting every source returned, which
      // on a mature corpus is ~76k of mostly-known rows -- it cannot answer
      // "did this run find me anything?". Without `jobs_new` a run that
      // discovered thousands of new roles was indistinguishable from one that
      // discovered none, which is what made discovery look broken while it was
      // working correctly.
      jobs_new: 0,
      // Removed before scoring because another record already represented them.
      // Previously collapsed to a bare length in the report, which made
      // over-collapsing dedup impossible to diagnose.
      jobs_duplicate: 0,
      // `jobs_discarded` conflates three unrelated causes. Each also gets its
      // own counter so a run ruined by a geography rule is distinguishable from
      // one that merely surfaced stale postings.
      jobs_discarded_stale: 0, jobs_discarded_excluded: 0, jobs_discarded_low_score: 0,
      // Jobs suppressed by the already-seen rules, split by which rule fired.
      jobs_suppressed_applied: 0, jobs_suppressed_url_owned: 0,
      // Scored below the bar ONLY because the description was never fetched.
      // With no description the reachable maximum is ~44/100 against a 50
      // floor, so such a row is a guaranteed Discard however well it fits —
      // calling that "below score threshold" states a fit conclusion the
      // system never earned. Recoverable via `npm run enrich`.
      jobs_unread: 0,
    });
  });

  it('countBy tallies by key', () => {
    expect(countBy([{ tier: 'Priority' }, { tier: 'Priority' }, { tier: 'Queue' }], 'tier'))
      .toEqual({ Priority: 2, Queue: 1 });
  });

  it('writes scored_jobs.json with tier/sponsorship/lifecycle breakdowns', () => {
    const counters = { ...emptyCounters(), jobs_scored: 2 };
    const scored = [
      { id: 'a', tier: 'Priority', sponsorship: 'Confirmed', lifecycle: LIFECYCLE.SCORED },
      { id: 'b', tier: 'Near miss', sponsorship: 'Unconfirmed', lifecycle: LIFECYCLE.NEAR_MISS },
    ];
    const path = writeScoredJobs(root, { scored, counters });
    expect(existsSync(path)).toBe(true);
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    expect(doc.counters.jobs_scored).toBe(2);
    expect(doc.byTier).toEqual({ Priority: 1, 'Near miss': 1 });
    expect(doc.byLifecycle[LIFECYCLE.NEAR_MISS]).toBe(1);
    expect(doc.jobs).toHaveLength(2);
  });

  it('writes queued_jobs.json containing only actionable tiers', () => {
    const counters = { ...emptyCounters(), jobs_queued: 1 };
    const queued = [{ id: 'a', tier: 'Apply', lifecycle: LIFECYCLE.QUEUED }];
    const path = writeQueuedJobs(root, { queued, counters });
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    expect(doc.jobs).toHaveLength(1);
    expect(doc.byTier).toEqual({ Apply: 1 });
  });

  it('writeAllArtifacts returns all three paths', () => {
    const out = writeAllArtifacts(root, {
      discovered: [], scored: [], queued: [], duplicates: [], errors: [], counters: emptyCounters(),
    });
    expect(out.found.endsWith('found_jobs.json')).toBe(true);
    // scored_jobs.json is opt-in now: nothing reads it.
    expect(out.scored).toBeNull();
    const withScored = writeAllArtifacts(root, {
      discovered: [], scored: [], queued: [], duplicates: [], errors: [], counters: emptyCounters(),
    }, { writeScoredJobs: true });
    expect(withScored.scored.endsWith('scored_jobs.json')).toBe(true);
    expect(out.queued.endsWith('queued_jobs.json')).toBe(true);
  });

  it('supports an injected write impl (no disk writes)', () => {
    const writes = [];
    const deps = { writeFileImpl: (dir, path, text) => writes.push({ path, text }) };
    writeScoredJobs(root, { scored: [], counters: emptyCounters() }, deps);
    expect(writes).toHaveLength(1);
    expect(writes[0].path.endsWith('scored_jobs.json')).toBe(true);
  });
});

describe('lifecycle', () => {
  it('maps queued tiers to QUEUED and near-miss to NEAR_MISS', () => {
    expect(lifecycleForTier(TIERS.PRIORITY, {})).toBe(LIFECYCLE.QUEUED);
    expect(lifecycleForTier(TIERS.APPLY, {})).toBe(LIFECYCLE.QUEUED);
    expect(lifecycleForTier(TIERS.QUEUE, {})).toBe(LIFECYCLE.QUEUED);
    expect(lifecycleForTier(TIERS.NEAR_MISS, {})).toBe(LIFECYCLE.NEAR_MISS);
  });

  it('near miss is NOT queued unless config opts in', () => {
    expect(isQueuedTier(TIERS.NEAR_MISS, {})).toBe(false);
    expect(isQueuedTier(TIERS.NEAR_MISS, { queue: { includeNearMiss: true } })).toBe(true);
    expect(QUEUED_TIERS).toContain(TIERS.PRIORITY);
  });
});
