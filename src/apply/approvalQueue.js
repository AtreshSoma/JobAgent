/**
 * Human approval queue (the compliance gate).
 *
 * Every prepared application waits here for explicit human approval before the
 * browser assist will open and fill it. This module is the single choke point
 * that enforces: nothing is acted on until a human approves it (approve()).
 * Approval clears a packet for ASSISTED filling only — the assistant still never
 * clicks the final submit; the human reviews the filled form and submits it.
 *
 * The queue is backed by the approval_queue table via the Database class.
 */

import { randomUUID } from 'node:crypto';
import { nowIso } from '../utils/dates.js';

export const APPROVAL_STATUS = Object.freeze({
  PENDING: 'pending_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

/**
 * Enqueue a prepared packet for human review.
 *
 * Idempotent per job: if this job already has a queue entry, the existing row is
 * repointed at the new packet and reset to `pending_review` (a re-prepared
 * packet must be re-approved), instead of inserting a duplicate.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {object} args
 * @param {object} args.packet application packet
 * @param {string} args.packetPath path to the persisted packet JSON
 * @returns {{ id: string, status: string, updated: boolean }}
 */
export function enqueueForApproval(db, { packet, packetPath }) {
  const jobId = packet.job?.id ?? null;

  if (jobId && typeof db.getApprovalByJob === 'function') {
    const existing = db.getApprovalByJob(jobId);
    if (existing) {
      db.updateApprovalPacket(existing.id, {
        packet_path: packetPath,
        approval_status: APPROVAL_STATUS.PENDING,
      });
      return { id: existing.id, status: APPROVAL_STATUS.PENDING, updated: true };
    }
  }

  const id = randomUUID();
  db.insertApproval({
    id,
    job_id: jobId,
    packet_path: packetPath,
    approval_status: APPROVAL_STATUS.PENDING,
    approved_by_user: 0,
    approved_at: null,
    created_at: nowIso(),
  });
  return { id, status: APPROVAL_STATUS.PENDING, updated: false };
}

/** List packets awaiting human review. */
export function listPending(db) {
  return db.listApprovals({ status: APPROVAL_STATUS.PENDING });
}

/**
 * Fail loudly when the approval id does not exist. Without this, approving a
 * mistyped id "succeeds" (the UPDATE matches zero rows) and the CLI reports a
 * packet as approved when nothing changed.
 * @param {import('../logging/db.js').Database} db
 * @param {string} approvalId
 */
function assertApprovalExists(db, approvalId) {
  if (typeof db.getApproval !== 'function') return;
  if (!db.getApproval(approvalId)) {
    throw new Error(
      `no approval found with id "${approvalId}" — run "npm run approvals" to list valid ids`,
    );
  }
}

/**
 * Record an explicit human approval. This does NOT submit anything; it only
 * marks the packet as human-approved.
 * @param {import('../logging/db.js').Database} db
 * @param {string} approvalId
 * @returns {{ id: string, status: string }}
 */
export function approve(db, approvalId) {
  assertApprovalExists(db, approvalId);
  db.updateApprovalStatus(approvalId, {
    approval_status: APPROVAL_STATUS.APPROVED,
    approved_by_user: 1,
    approved_at: nowIso(),
  });
  return { id: approvalId, status: APPROVAL_STATUS.APPROVED };
}

/** Record a human rejection. */
export function reject(db, approvalId) {
  assertApprovalExists(db, approvalId);
  db.updateApprovalStatus(approvalId, {
    approval_status: APPROVAL_STATUS.REJECTED,
    approved_by_user: 0,
    approved_at: nowIso(),
  });
  return { id: approvalId, status: APPROVAL_STATUS.REJECTED };
}

/**
 * Compliance check: is this packet cleared for ASSISTED filling? A packet is
 * cleared only when a human has explicitly approved it. (The assistant never
 * submits, so there is no separate "live-submit" runtime gate — the human
 * reviews the filled form and clicks Submit.)
 *
 * @param {object} approvalRow row from approval_queue
 * @returns {{ clearedForAssist: boolean, reasons: string[] }}
 */
export function isClearedForAssist(approvalRow) {
  const reasons = [];
  if (approvalRow?.approval_status !== APPROVAL_STATUS.APPROVED) {
    reasons.push('not human-approved');
  }
  if (!approvalRow?.approved_by_user) {
    reasons.push('missing per-job user approval');
  }
  return { clearedForAssist: reasons.length === 0, reasons };
}
