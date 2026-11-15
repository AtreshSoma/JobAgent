/**
 * The report reads summary rows, not whole rows (audit D5).
 *
 * `SELECT * FROM jobs` hauls every posting's full description (about 8 KB each,
 * hundreds of MB on a real store) off disk, and the report never prints one.
 * The board, the tracker, the doctor and the re-score already use cheaper
 * reads; the two report call sites did not.
 */
import { describe, expect, it } from 'vitest';

import { reportJobRows } from '../../src/reports/reportGenerator.js';
import { openDatabase } from '../../src/logging/db.js';

describe('reportJobRows', () => {
  it('uses the summary read, so no description is read', () => {
    const calls = [];
    const db = {
      listJobsSummary: (a) => { calls.push(['summary', a]); return [{ id: 'a' }]; },
      listJobs: () => { calls.push(['full']); return []; },
    };
    expect(reportJobRows(db)).toEqual([{ id: 'a' }]);
    expect(calls).toEqual([['summary', { mode: 'profile' }]]);
  });

  it('falls back to the full read for a store that has no summary read', () => {
    expect(reportJobRows({ listJobs: () => [{ id: 'b' }] })).toEqual([{ id: 'b' }]);
  });

  it('on a real database, returns the profile rows without jd_text', () => {
    const db = openDatabase({ path: ':memory:' });
    db.upsertJob({ id: 'j1', company: 'Acme', title: 'Engineer', score: 80, status: 'scored', jd_text: 'x'.repeat(5000), discovery_mode: 'profile' });
    const [row] = reportJobRows(db);
    expect(row.id).toBe('j1');
    expect(row.jd_text).toBeUndefined();
    db.close();
  });
});
