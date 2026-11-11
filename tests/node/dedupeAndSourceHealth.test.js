/**
 * M2 — dedupe keeps the copy that survives the US gate; company-less records
 * never collapse across employers.
 * P2-7 — degradation notes are counted apart from errors per source.
 */
import { describe, it, expect, vi } from 'vitest';

import { deduplicate, keyFor } from '../../src/search/deduplicator.js';
import { runSearch, isNote } from '../../src/search/index.js';
import { loadTestConfig } from './helpers/testConfig.js';

const geo = loadTestConfig({ loadEnv: false, env: {} }).exclusions.geography;
const LONG = 'Offshore copy with a much longer description. '.repeat(10);

describe('dedupe prefers the geography-passing copy', () => {
  it('keeps the US copy over a longer Bangalore copy, remembering the other place', () => {
    const us = { id: 'a', company: 'Acme', title: 'Data Engineer', location: 'Remote, US', jdText: 'short', rawMetadata: {} };
    const blr = { id: 'b', company: 'Acme', title: 'Data Engineer', location: 'Bangalore, India', jdText: LONG, rawMetadata: {} };
    for (const order of [[us, blr], [blr, us]]) {
      const { unique, duplicates } = deduplicate(order.map((j) => ({ ...j, rawMetadata: {} })), { geography: geo });
      expect(unique).toHaveLength(1);
      expect(unique[0].id).toBe('a');
      expect(unique[0].rawMetadata.alsoAt).toEqual(['Bangalore, India']);
      expect(duplicates[0].job.id).toBe('b');
    }
  });

  it('falls back to the longer description when both (or neither) pass', () => {
    const a = { id: 'a', company: 'Acme', title: 'DE', location: 'Austin, TX', jdText: 'x' };
    const b = { id: 'b', company: 'Acme', title: 'DE', location: 'Denver, CO', jdText: LONG };
    expect(deduplicate([a, b], { geography: geo }).unique[0].id).toBe('b');
    expect(deduplicate([a, b]).unique[0].id).toBe('b');
  });

  it('never collapses company-less records from different hosts', () => {
    const x = { id: 'x', company: '', title: 'Data Engineer', url: 'https://jobs.alpha.com/1' };
    const y = { id: 'y', company: '', title: 'Data Engineer', url: 'https://careers.beta.io/2' };
    expect(keyFor(x)).not.toBe(keyFor(y));
    expect(deduplicate([x, y]).unique).toHaveLength(2);
  });
});

describe('per-source errors vs notes', () => {
  it('classifies degraded/budget entries as notes', () => {
    expect(isNote({ degraded: true, error: 'budget reached' })).toBe(true);
    expect(isNote({ note: 'no tenants configured' })).toBe(true);
    expect(isNote({ error: 'HTTP 500' })).toBe(false);
  });

  it('a budgeted but healthy source reports 0 errors, N notes, and succeeded', async () => {
    const jobboards = { defaults: { rateLimitMs: 0, maxRetries: 0 }, sources: [{ id: 'ok', adapter: 'x', enabled: true }] };
    const { ADAPTERS } = await import('../../src/search/index.js');
    ADAPTERS.x = { run: vi.fn(async () => ({ jobs: [], errors: [{ degraded: true, error: '3 kept the teaser' }] })) };
    ADAPTERS.y = { run: vi.fn(async () => ({ jobs: [], errors: [{ error: 'HTTP 500' }] })) };
    try {
      const { perSource } = await runSearch({ jobboards: { ...jobboards, sources: [...jobboards.sources, { id: 'bad', adapter: 'y', enabled: true }] } });
      expect(perSource.find((s) => s.source === 'ok')).toMatchObject({ errors: 0, notes: 1, succeeded: true });
      expect(perSource.find((s) => s.source === 'bad')).toMatchObject({ errors: 1, notes: 0, succeeded: false });
    } finally {
      delete ADAPTERS.x;
      delete ADAPTERS.y;
    }
  });
});
