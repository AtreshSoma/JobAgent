/** Secure data boundary for the Chrome/Edge assisted-fill extension. */
import { timingSafeEqual } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { realpathSync, readFileSync, statSync } from 'node:fs';

import { APPROVAL_STATUS } from '../apply/approvalQueue.js';
import { isInsideDirectory } from '../utils/pathSafe.js';
import { loadPacket } from '../cli/commands.js';

// Chrome uses chrome-extension://<id>; current Edge builds may expose the
// equivalent extension://<id> origin to a loopback server. Chromium extension
// IDs contain exactly 32 characters in the a-p alphabet. Keep this deliberately
// narrow: ordinary https sites and arbitrary custom schemes must never pass.
const EXTENSION_ORIGIN_RE = /^(?:chrome-extension|extension):\/\/[a-p]{32}\/?$/;
const MAX_ARTIFACT_BYTES = 12 * 1024 * 1024;

export function isChromiumExtensionOrigin(origin = '') {
  return EXTENSION_ORIGIN_RE.test(String(origin));
}

export function validExtensionKey(expected, supplied) {
  const a = Buffer.from(String(expected ?? ''), 'utf8');
  const b = Buffer.from(String(supplied ?? ''), 'utf8');
  return a.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
}

export function extensionProfile(candidate = {}) {
  const identity = candidate.identity ?? {};
  return {
    identity: {
      fullName: identity.fullName ?? '',
      preferredName: identity.preferredName ?? '',
      links: identity.links ?? {},
    },
    contact: candidate.contact ?? {},
    location: candidate.location ?? {},
    workAuthorization: candidate.workAuthorization ?? {},
  };
}

export function buildExtensionPayload({ db, config, jobId, loadPacketImpl = loadPacket } = {}) {
  const approval = db?.getApprovalByJob?.(jobId);
  if (!approval) throw statusError(404, 'no prepared application packet for this job');
  if (approval.approval_status !== APPROVAL_STATUS.APPROVED || !approval.approved_by_user) {
    throw statusError(403, 'the application packet must be explicitly approved in Job Agent first');
  }
  const packet = loadPacketImpl(approval);
  if (!packet?.job?.id || packet.job.id !== jobId) {
    throw statusError(409, 'application packet does not match this job');
  }
  const job = db?.getJob?.(jobId);
  if (job?.applied || ['submitted', 'submit_unverified'].includes(job?.status)) {
    throw statusError(409, 'this job is already submitted or awaiting submission verification');
  }
  return {
    schemaVersion: 1,
    job: {
      id: jobId,
      company: packet.job.company ?? job?.company ?? '',
      title: packet.job.title ?? job?.title ?? '',
      url: job?.url ?? packet.job.url ?? '',
      ats: packet.ats?.platform ?? job?.ats_platform ?? 'generic',
    },
    approval: { approved: true, stopBeforeSubmit: true },
    profile: extensionProfile(config?.candidate),
    screeningAnswers: (config?.screeningAnswers?.answers ?? []).map((item) => ({
      id: item.id, patterns: item.patterns ?? [], answer: item.answer, type: item.type ?? 'text',
    })),
    artifacts: {
      resume: packet.resumePath ? { name: basename(packet.resumePath), available: true } : null,
      coverLetter: packet.coverLetterPath ? { name: basename(packet.coverLetterPath), available: true } : null,
    },
    blockers: packet.blockers ?? [],
  };
}

export function readApprovedArtifact({ db, config, jobId, kind, loadPacketImpl = loadPacket } = {}) {
  // Re-run every approval/duplicate guard before returning sensitive bytes.
  buildExtensionPayload({ db, config, jobId, loadPacketImpl });
  const approval = db.getApprovalByJob(jobId);
  const packet = loadPacketImpl(approval);
  const raw = kind === 'resume' ? packet.resumePath
    : kind === 'cover-letter' ? packet.coverLetterPath : null;
  if (!raw) throw statusError(404, `approved packet has no ${kind} artifact`);
  const root = realpathSync(config.root);
  const candidate = realpathSync(isAbsolute(raw) ? raw : resolve(root, raw));
  // Platform-correct containment (see utils/pathSafe.js): comparing strings
  // directly rejected valid artifacts whenever the drive-letter case differed.
  if (!isInsideDirectory(root, candidate)) {
    throw statusError(403, 'artifact path escapes the Job Agent workspace');
  }
  const size = statSync(candidate).size;
  if (size > MAX_ARTIFACT_BYTES) throw statusError(413, 'artifact is too large for extension upload');
  return { bytes: readFileSync(candidate), name: basename(candidate), type: mimeFor(candidate) };
}

function mimeFor(path) {
  if (/\.pdf$/i.test(path)) return 'application/pdf';
  if (/\.docx$/i.test(path)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/\.doc$/i.test(path)) return 'application/msword';
  return 'text/plain; charset=utf-8';
}

function statusError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
