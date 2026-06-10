import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { submitStatus, writeJobTracker } from '../../src/reports/jobTracker.js';
import { openDatabase } from '../../src/logging/db.js';

describe('submitStatus', () => {
  it('shows Submitted once a job is marked applied', () => {
    expect(submitStatus({ applied: 1 }, null)).toBe('Submitted');
    // Applied wins even if the status still says skipped/ready.
    expect(submitStatus({ applied: 1, status: 'skipped' }, null)).toBe('Submitted');
  });

  it('shows Skipped by you when the user skipped it', () => {
    expect(submitStatus({ status: 'skipped' }, null)).toBe('Skipped by you');
  });

  it('shows a filled-but-not-submitted state', () => {
    expect(submitStatus({ status: 'ready_for_submit' }, null)).toBe('Filled — ready to submit');
    expect(submitStatus({ status: 'assist_blocked' }, null))
      .toBe('Filled — needs you (login/extra fields)');
  });

  it('falls back to approval and pipeline states', () => {
    expect(submitStatus({}, { approval_status: 'approved' })).toBe('Approved — not yet submitted');
    expect(submitStatus({}, { approval_status: 'rejected' })).toBe('Rejected by you');
    expect(submitStatus({ application_packet_path: '/x' }, null))
      .toBe('Prepared — awaiting your approval');
    expect(submitStatus({ score: 80 }, null)).toBe('Scored');
    expect(submitStatus({}, null)).toBe('Found');
  });
});

describe('writeJobTracker', () => {
  it('writes one CSV row per job with accurate prepared/submitted counts', () => {
    const root = mkdtempSync(join(tmpdir(), 'tracker-'));
    const db = openDatabase({ path: ':memory:' });
    try {
      db.upsertJob({
        id: 'j1', company: 'Acme, Inc.', title: 'Sr "Data" Engineer', url: 'http://a',
        source: 'greenhouse', score: 90, tier: 'Priority', status: 'prepared',
        application_packet_path: '/p/j1.json', posted_at: '2026-06-01T00:00:00Z',
      });
      db.upsertJob({
        id: 'j2', company: 'Globex', title: 'DE', url: 'http://b',
        applied: 1, applied_at: '2026-06-05T12:00:00Z', status: 'ready_for_submit',
        application_packet_path: '/p/j2.json',
      });
      db.upsertJob({ id: 'j3', company: 'Initech', title: 'Jr DE', url: 'http://c', score: 40 });
      db.insertApproval({ id: 'a1', job_id: 'j1', packet_path: '/p/j1.json', approval_status: 'pending_review' });

      const result = writeJobTracker(db, root);
      expect(result.total).toBe(3);
      expect(result.prepared).toBe(1); // j1 (j2 counts as submitted, not prepared)
      expect(result.submitted).toBe(1); // j2

      const csv = readFileSync(result.path, 'utf8');
      const lines = csv.split('\n');
      expect(lines).toHaveLength(4); // header + 3 jobs
      expect(lines[0]).toContain('Submit Status');
      // CSV escaping: comma and quotes in company/title survive round-tripping.
      expect(csv).toContain('"Acme, Inc."');
      expect(csv).toContain('"Sr ""Data"" Engineer"');
      // Status truthfulness: only the human-submitted job reads Submitted.
      const j1 = lines.find((l) => l.includes('j1'));
      const j2 = lines.find((l) => l.includes('j2'));
      expect(j1).toContain('Prepared — awaiting your approval');
      expect(j2).toContain('Submitted');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
