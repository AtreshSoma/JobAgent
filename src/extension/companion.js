/** Secure data boundary for the Chrome/Edge assisted-fill extension. */
import { timingSafeEqual } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';
import { realpathSync, readFileSync, statSync } from 'node:fs';

import { APPROVAL_STATUS } from '../apply/approvalQueue.js';
import { isInsideDirectory } from '../utils/pathSafe.js';
import { loadPacket } from '../cli/commands.js';
import { answerScreeningQuestion, effectiveAnswers } from '../apply/screeningQA.js';
import { packetOwnershipCheck } from '../apply/applicationPacket.js';

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

/**
 * Labels the extension must NEVER answer on its own, whatever it has stored.
 *
 * The content script matches answers by substring pattern and is blind to a
 * question's polarity. Measured: "Are you able to work in the US without
 * requiring sponsorship?" matched the `require sponsorship` pattern and was
 * answered "Yes" for a candidate who requires it — the opposite of the truth,
 * on an immigration question. The server-side matcher refuses inverted
 * questions; the extension has no equivalent, so these always go to the human.
 * Mirrored in extension/content.js (WORK_AUTH).
 */
export const EXTENSION_MANUAL_LABEL = /\b(sponsor\w*|visas?|authori[sz]\w*|citizen\w*)\b/i;

/**
 * Server-side screening decisions for a set of question labels.
 *
 * Uses the same `answerScreeningQuestion` the browser runner uses (inverted
 * sponsorship, qualified years-of-experience and the truthfulness guard all
 * included), so the extension does not have to re-implement any of it. A
 * work-authorization label is always `ask_user` here: see
 * EXTENSION_MANUAL_LABEL.
 *
 * @param {string[]} labels question labels
 * @param {object} config loadConfig() bundle
 * @returns {Record<string, {answer: string|null, action: 'fill'|'ask_user', matchedId: string|null, reason?: string}>}
 *   keyed by the label as given
 */
export function answerForLabels(labels = [], config = {}) {
  const out = {};
  for (const raw of Array.isArray(labels) ? labels : []) {
    const label = String(raw ?? '').trim();
    if (!label || Object.hasOwn(out, label)) continue;
    if (EXTENSION_MANUAL_LABEL.test(label)) {
      out[label] = {
        answer: null, action: 'ask_user', matchedId: null,
        reason: 'work-authorization questions are always answered by you in the extension',
      };
      continue;
    }
    const qa = answerScreeningQuestion(label, config?.screeningAnswers ?? {}, { candidate: config?.candidate });
    out[label] = qa.answered
      ? { answer: qa.answer, action: 'fill', matchedId: qa.matchedId }
      : { answer: null, action: 'ask_user', matchedId: null, ...(qa.reason ? { reason: qa.reason } : {}) };
  }
  return out;
}

/** Every question label an approved packet already knows about. */
function packetQuestionLabels(packet = {}) {
  const pick = (list) => (Array.isArray(list) ? list : []).map((x) => x?.label).filter(Boolean);
  return [
    ...pick(packet.prefill?.plan?.filter?.((p) => p?.source === 'screening')),
    ...pick(packet.prefill?.needsUser),
    ...pick(packet.screeningPlan?.answered),
    ...pick(packet.screeningPlan?.needsUser),
  ];
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
  // The extension is a SECOND fill path and hands the browser the candidate's
  // profile, answers and documents; it must ask the same ownership question
  // the runner does, or a packet prepared for a previous profile is filled by
  // the extension after the dashboard refused it.
  const owned = packetOwnershipCheck(packet, config ?? {});
  if (!owned.ok) {
    throw statusError(409, `this packet is not the active candidate's — ${owned.reason}; prepare it again`);
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
    // `effectiveAnswers`, not `.answers` — the browser extension is a SECOND
    // fill path, and reading the raw array here bypassed the profile-derived
    // answers entirely. After switching profiles it would have handed the
    // previous candidate's work authorization, pay expectation and years of
    // experience to the browser while the CLI filler used the right ones.
    screeningAnswers: effectiveAnswers(config?.screeningAnswers).map((item) => ({
      id: item.id, patterns: item.patterns ?? [], answer: item.answer, type: item.type ?? 'text',
    })),
    // Decisions computed HERE, by the polarity-aware matcher, for every
    // question the reviewed packet knows. The content script prefers these to
    // its own pattern match and treats `ask_user` as a hard "leave it".
    screeningDecisions: answerForLabels(packetQuestionLabels(packet), config),
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
