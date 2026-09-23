/**
 * A packet built for one candidate is refused at every fill chokepoint.
 *
 * Regressions covered:
 *   - a packet with no `owner` fell back to `packet.candidateName` (never
 *     written) and passed, so legacy "Jane Doe" packets were filled for
 *     whoever was active;
 *   - the check lived only in dashboard callers, so the runner, extension and
 *     CLI filled foreign packets;
 *   - the recorded resume fingerprint was never compared;
 *   - runAssist never counted its own submissions against the daily cap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { packetOwnershipCheck } from '../../src/apply/applicationPacket.js';
import { assistApply } from '../../src/automation/applyRunner.js';
import { buildExtensionPayload } from '../../src/extension/companion.js';
import { runAssist, approvePacket } from '../../src/cli/commands.js';
import { enqueueForApproval } from '../../src/apply/approvalQueue.js';
import { openDatabase } from '../../src/logging/db.js';
import { LIFECYCLE } from '../../src/lifecycle.js';

const dana = {
  candidate: { identity: { fullName: 'Dana Okafor' }, contact: { email: 'dana@okafor.dev' } },
  profile: { id: 'dana-data', label: 'Dana data' },
};

describe('packetOwnershipCheck', () => {
  it('refuses a legacy packet whose documents are named for someone else', () => {
    const r = packetOwnershipCheck({ resumePath: 'C:\\out\\Jane_Doe_Resume_DE.docx' }, dana);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Jane_Doe_Resume_DE\.docx.*Dana Okafor/);
  });

  it('refuses a legacy packet whose cover letter still holds template text', () => {
    const r = packetOwnershipCheck({
      resumePath: '/o/Dana_Okafor_Resume_DE.docx', coverLetterPath: '/o/Dana_Okafor_Cover_Letter_DE.txt',
    }, dana, { readTextImpl: () => 'Dear team,\nI am applying for the {title} role.' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/\{title\}/);
  });

  it('refuses an owned packet tailored from a different master resume', () => {
    const packet = { owner: { candidateName: 'Dana Okafor', profileId: 'dana-data', resumeFingerprint: 'aaaa' } };
    expect(packetOwnershipCheck(packet, dana, { fingerprintImpl: () => 'bbbb' }).ok).toBe(false);
    expect(packetOwnershipCheck(packet, dana, { fingerprintImpl: () => 'aaaa' }).ok).toBe(true);
    // Unknown on either side is not a mismatch.
    expect(packetOwnershipCheck(packet, dana, { fingerprintImpl: () => null }).ok).toBe(true);
  });
});

describe('chokepoints', () => {
  const foreign = {
    job: { id: 'j1', url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', title: 'DE' },
    owner: { candidateName: 'Jane Doe', candidateEmail: 'you@example.com' },
    blockers: [], fillPlan: { steps: [], uploads: [] }, screeningPlan: { answered: [], needsUser: [] },
  };

  it('the runner refuses before opening a browser', async () => {
    let opened = false;
    const r = await assistApply({
      packet: foreign, config: { ...dana, runtime: {} }, options: { statePath: false },
      deps: { createSession: async () => { opened = true; return {}; } },
    });
    expect(opened).toBe(false);
    expect(r.status).toBe(LIFECYCLE.ASSIST_BLOCKED);
    expect(r.blockers.join(' ')).toMatch(/^packet_not_owned: .*Jane Doe/);
  });

  it('the extension payload answers 409', () => {
    const approval = { job_id: 'j1', approval_status: 'approved', approved_by_user: 1 };
    try {
      buildExtensionPayload({
        db: { getApprovalByJob: () => approval, getJob: () => ({ id: 'j1', applied: 0 }) },
        config: dana, jobId: 'j1', loadPacketImpl: () => foreign,
      });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(err.statusCode).toBe(409);
      expect(err.message).toMatch(/not the active candidate/);
    }
  });

  describe('CLI runAssist', () => {
    let db; let dir;
    beforeEach(() => { db = openDatabase({ path: ':memory:' }); dir = mkdtempSync(join(tmpdir(), 'own-')); });
    afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

    const enqueue = (id, packet) => {
      const path = join(dir, `${id}.json`);
      writeFileSync(path, JSON.stringify(packet));
      approvePacket(db, enqueueForApproval(db, { packet, packetPath: path }).id);
    };

    it('skips a foreign packet and counts its own submissions toward the daily cap', async () => {
      enqueue('j1', foreign);
      const mine = (id) => ({ job: { id, url: 'https://x/apply' }, owner: { candidateName: 'Dana Okafor' }, blockers: [] });
      enqueue('j2', mine('j2'));
      enqueue('j3', mine('j3'));
      const seen = [];
      const r = await runAssist({
        config: { ...dana, runtime: {} }, db, logger: null,
        deps: {
          assistFn: async ({ packet, dailyCount }) => {
            seen.push({ id: packet.job.id, dailyCount });
            return { status: LIFECYCLE.SUBMITTED, submitted: true, submitVerification: { verified: true, signals: [] } };
          },
        },
      });
      expect(r.counters.jobs_skipped_not_owned).toBe(1);
      expect(seen.map((s) => s.id)).toEqual(['j2', 'j3']);
      expect(seen[1].dailyCount).toBe(seen[0].dailyCount + 1);
    });
  });
});
