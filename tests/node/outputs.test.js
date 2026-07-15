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
    expect(out.scored.endsWith('scored_jobs.json')).toBe(true);
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
