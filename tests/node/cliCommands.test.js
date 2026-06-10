import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { openDatabase } from '../../src/logging/db.js';
import { enqueueForApproval, APPROVAL_STATUS } from '../../src/apply/approvalQueue.js';
import {
  runDiscover, runAssist, listApprovalQueue, approvePacket, rejectPacket,
  listPackets, getPacket, loadPacket,
} from '../../src/cli/commands.js';
import { LIFECYCLE } from '../../src/lifecycle.js';

function writePacketFile(dir, id, packet) {
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify(packet), 'utf8');
  return path;
}

describe('approval-queue CLI commands', () => {
  let db; let dir;
  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    dir = mkdtempSync(join(tmpdir(), 'packets-'));
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  function enqueue(jobId, score = 90, tier = 'Priority', blockers = []) {
    const packet = { job: { id: jobId, company: `Co-${jobId}`, title: 'SDE', url: 'https://x/apply' }, score, tier, blockers };
    const path = writePacketFile(dir, jobId, packet);
    return { ...enqueueForApproval(db, { packet, packetPath: path }), packet, path };
  }

  it('lists pending packets, then all packets after approval', () => {
    enqueue('a'); enqueue('b');
    expect(listApprovalQueue(db)).toHaveLength(2);
    const { id } = listApprovalQueue(db)[0];
    approvePacket(db, id);
    expect(listApprovalQueue(db)).toHaveLength(1); // only pending now
    expect(listApprovalQueue(db, { all: true })).toHaveLength(2);
  });

  it('approve / reject update status', () => {
    const a = enqueue('a');
    expect(approvePacket(db, a.id).status).toBe(APPROVAL_STATUS.APPROVED);
    const b = enqueue('b');
    expect(rejectPacket(db, b.id).status).toBe(APPROVAL_STATUS.REJECTED);
  });

  it('listPackets returns a joined view with company/score/blockers', () => {
    enqueue('a', 88, 'Apply', ['resume warning']);
    const rows = listPackets(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].company).toBe('Co-a');
    expect(rows[0].score).toBe(88);
    expect(rows[0].blockers).toEqual(['resume warning']);
  });

  it('getPacket finds by job id', () => {
    enqueue('job-xyz');
    const found = getPacket(db, 'job-xyz');
    expect(found).not.toBe(null);
    expect(found.packet.job.id).toBe('job-xyz');
    expect(getPacket(db, 'missing')).toBe(null);
  });

  it('loadPacket tolerates a missing/corrupt file', () => {
    expect(loadPacket({ packet_path: join(dir, 'nope.json') })).toBe(null);
    expect(loadPacket({})).toBe(null);
  });
});

describe('runDiscover', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'discover-')); mkdirSync(join(root, 'data'), { recursive: true }); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes found_jobs.json with FOUND lifecycle and null scores', async () => {
    const searchFn = async () => ({
      jobs: [{
        id: 'gh:acme::sde::1', source: 'greenhouse', company: 'Acme', title: 'SDE',
        location: 'Remote', url: 'https://x', rawMetadata: { sourceKind: 'ats', discovery: { match: 'strong', signals: [], reasons: [] } },
      }],
      duplicates: [], errors: [],
    });
    const r = await runDiscover({
      config: { root, jobboards: {}, candidate: {}, scoring: {} },
      logger: null,
      deps: { searchFn },
    });
    expect(r.counters.jobs_found).toBe(1);
    expect(r.jobs[0].lifecycle).toBe(LIFECYCLE.FOUND);
    expect(r.jobs[0].score).toBe(null);
    expect(r.found.endsWith('found_jobs.json')).toBe(true);
  });
});

describe('runAssist', () => {
  let db; let dir;
  beforeEach(() => { db = openDatabase({ path: ':memory:' }); dir = mkdtempSync(join(tmpdir(), 'assist-')); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('only acts on APPROVED packets and fills them, never submitting', async () => {
    const mk = (id) => {
      const packet = { job: { id, url: 'https://x/apply' }, score: 90, blockers: [] };
      const path = writePacketFile(dir, id, packet);
      return enqueueForApproval(db, { packet, packetPath: path });
    };
    const approved = mk('a'); mk('b'); // b stays pending
    approvePacket(db, approved.id);

    const assistFn = async ({ packet }) => ({
      jobId: packet.job.id, status: LIFECYCLE.READY_FOR_SUBMIT, submitted: false, blockers: [],
    });

    const r = await runAssist({
      config: { runtime: {}, scoring: {} },
      db, logger: null, mode: 'LIVE_ASSIST',
      deps: { assistFn },
    });

    expect(r.results).toHaveLength(1); // only the approved packet
    expect(r.counters.jobs_assisted).toBe(1);
    expect(r.results[0].submitted).toBe(false);
    expect(r.results[0].status).toBe(LIFECYCLE.READY_FOR_SUBMIT);
  });

  it('does NOT re-apply to a job already marked applied (idempotency guard)', async () => {
    const id = 'already-done';
    const packet = { job: { id, url: 'https://x/apply' }, score: 90, blockers: [] };
    const path = writePacketFile(dir, id, packet);
    const approval = enqueueForApproval(db, { packet, packetPath: path });
    approvePacket(db, approval.id);
    // Simulate a prior successful submission.
    db.upsertJob({ id, applied: 1, applied_at: new Date().toISOString(), status: LIFECYCLE.SUBMITTED });

    let called = 0;
    const assistFn = async ({ packet: p }) => {
      called += 1;
      return { jobId: p.job.id, status: LIFECYCLE.SUBMITTED, submitted: true, blockers: [] };
    };

    const r = await runAssist({
      config: { runtime: {}, scoring: {} },
      db, logger: null,
      deps: { assistFn },
    });

    expect(called).toBe(0); // never re-submitted
    expect(r.results).toHaveLength(0);
    expect(r.counters.jobs_skipped_already_applied).toBe(1);
  });
});
