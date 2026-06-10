import { describe, it, expect } from 'vitest';
import { deduplicate, keyFor } from '../../src/search/deduplicator.js';
import { normalizeJob } from '../../src/search/normalize.js';

const job = (over) => normalizeJob({ source: 's', ...over });

describe('deduplicator', () => {
  it('drops same company+title+id duplicates, keeping richer JD', () => {
    const a = job({ company: 'Acme', title: 'SDE', sourceJobId: '1', jdText: 'short' });
    const b = job({ company: 'ACME', title: 'sde', sourceJobId: '1', jdText: 'a much longer description with detail' });
    const { unique, duplicates } = deduplicate([a, b]);
    expect(unique).toHaveLength(1);
    expect(unique[0].jdText).toContain('longer');
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reason).toBe('duplicate_in_batch');
  });

  it('keeps distinct jobs', () => {
    const a = job({ company: 'Acme', title: 'SDE', sourceJobId: '1' });
    const b = job({ company: 'Globex', title: 'SDE', sourceJobId: '2' });
    expect(deduplicate([a, b]).unique).toHaveLength(2);
  });

  it('collapses the same role posted across many locations (distinct ids)', () => {
    const cities = ['Houston, TX', 'Dallas, TX', 'New York, NY', 'Seattle, WA'];
    const jobs = cities.map((location, i) => job({
      company: 'Deloitte',
      title: 'ConvergeHEALTH - Data Operations Engineer',
      sourceJobId: `gh-${i}`,
      location,
      url: `https://deloitte.com/job/${i}`,
    }));
    const { unique, duplicates } = deduplicate(jobs);
    expect(unique).toHaveLength(1);
    expect(duplicates).toHaveLength(cities.length - 1);
    expect(duplicates.every((d) => d.reason === 'duplicate_in_batch')).toBe(true);
  });

  it('uses existsInDb to drop known jobs from prior runs', () => {
    const a = job({ company: 'Acme', title: 'SDE', sourceJobId: '1' });
    const known = new Set([keyFor(a)]);
    const { unique, duplicates } = deduplicate([a], { existsInDb: (_j, key) => known.has(key) });
    expect(unique).toHaveLength(0);
    expect(duplicates[0].reason).toBe('exists_in_db');
  });
});
