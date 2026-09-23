/**
 * Keep the approval queue honest: no packet stays "approved" once it can no
 * longer be used.
 *
 * Why this exists
 * ---------------
 * On 2026-09-23 the Today queue led with four "Retry auto-fill" jobs. Every
 * one of their packets had been built in August from the TEMPLATE profile
 * (Jane_Doe_Resume_*.docx, a cover letter signed "Jane Doe") — and since the
 * ownership check went in, every fill path refuses such a packet. Retry could
 * only fail, forever. Two of the four postings had also been closed by the
 * employer.
 *
 * The fill-time check is right to refuse; what was missing is the step that
 * notices BEFORE the user presses the button. This pass runs when the
 * dashboard starts and after a profile change. A packet that belongs to
 * someone else, or whose file has gone, is withdrawn and the job returns to
 * "prepare" (shortlisted, since the user already chose it once).
 */
import { readFileSync } from 'node:fs';

import { packetOwnershipCheck } from './applicationPacket.js';

/** Read the packet an approval row points at; null when missing or unreadable. */
function loadPacket(approval) {
  if (!approval?.packet_path) return null;
  try { return JSON.parse(readFileSync(approval.packet_path, 'utf8')); } catch { return null; }
}

/** Approval states whose packet could still be filled. */
const LIVE_APPROVALS = new Set(['approved', 'pending_review', 'pending']);

/**
 * @param {object} args
 * @param {import('../logging/db.js').Database} args.db
 * @param {object} args.config loadConfig() bundle (the ACTIVE candidate)
 * @param {(approval: object) => object|null} [args.loadPacketImpl]
 * @param {boolean} [args.apply=true] false = report only
 * @returns {{ checked: number, superseded: Array<{ jobId: string, reason: string }> }}
 */
export function reconcileStalePackets({ db, config, loadPacketImpl = loadPacket, apply = true } = {}) {
  const out = { checked: 0, superseded: [] };
  if (!db?.listApprovals || !db?.supersedePacket || !config?.candidate) return out;
  for (const approval of db.listApprovals()) {
    if (!LIVE_APPROVALS.has(approval.approval_status)) continue;
    const job = db.getJob?.(approval.job_id);
    if (!job || Number(job.applied) === 1) continue;
    // A form the human may be finishing, or a submission to confirm, is theirs.
    if (['submitted', 'submit_unverified', 'ready_for_submit', 'assist_started'].includes(job.status)) continue;
    out.checked += 1;
    const packet = loadPacketImpl(approval);
    let reason = null;
    if (!packet) {
      reason = 'the packet file is missing or unreadable';
    } else {
      const owned = packetOwnershipCheck(packet, config);
      if (!owned.ok) reason = `it was built for another profile (${owned.reason})`;
    }
    if (!reason) continue;
    out.superseded.push({ jobId: job.id, reason });
    if (apply) db.supersedePacket(job.id, { reason });
  }
  return out;
}
