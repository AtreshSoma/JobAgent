/**
 * Application packet builder (Section 5/7).
 *
 * Aggregates everything needed to apply to one job into a single, reviewable
 * packet: the job, its score/tier, the tailored resume + cover letter paths, the
 * screening/prefill plan, the file-upload plan, the detected ATS, and the
 * platform-specific fill plan.
 *
 * A packet is NEVER submit-ready on creation. `submitReady` stays false until a
 * human approves it AND the runtime is explicitly in live-submit mode. Building a
 * packet performs no network activity and submits nothing.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { join } from 'node:path';

import { detectAts } from './atsDetector.js';
import { getPlatform } from './platforms/index.js';
import { buildPrefillPlan } from './formPrefill.js';
import { buildUploadPlan } from './fileUpload.js';
import { nowIso } from '../utils/dates.js';

/**
 * Who a packet belongs to.
 *
 * WHY A PACKET NEEDS AN OWNER. There is one master resume, one job store and
 * one approvals table, and packets carried nothing identifying the candidate
 * they were built for. So after switching profiles, "Auto-fill" reused an
 * existing approval and packet without ever asking whose they were: the new
 * candidate's application was filled from documents, screening answers and a
 * cover letter prepared for the previous one.
 *
 * The stamp is deliberately more than a name. Two profiles can describe the
 * same person searching in two directions, with different target roles,
 * screening answers and tailored resumes, so identity alone would wave through
 * a packet built under different search intent.
 *
 * @param {object} [config] loadConfig() bundle
 * @returns {{profileId: string|null, profileLabel: string|null, candidateName: string,
 *            candidateEmail: string, resumeFingerprint: string|null}}
 */
export function packetOwner(config = {}) {
  const identity = config.candidate?.identity ?? {};
  return {
    profileId: config.profile?.id ?? null,
    profileLabel: config.profile?.label ?? null,
    candidateName: String(identity.fullName ?? '').trim(),
    candidateEmail: String(config.candidate?.contact?.email ?? '').trim().toLowerCase(),
    resumeFingerprint: config.resumeFingerprint ?? null,
  };
}

/** Compare two owner-ish values the way a human would: trimmed, case-insensitive. */
const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/**
 * Does this packet belong to the candidate the config currently describes?
 *
 * Returns the REASON when it does not, so the caller can tell the user which
 * mismatch it found rather than silently rebuilding.
 *
 * A packet from before this field existed has no owner recorded. That is
 * treated as unknown-but-usable rather than foreign: refusing every historical
 * packet would strand work the user already reviewed and approved, and the
 * profile-switch leak this guards against is a going-forward problem. The
 * packet does carry the candidate name in its documents, so a legacy packet
 * whose name disagrees is still caught below.
 *
 * @param {object} packet loaded application packet
 * @param {object} config loadConfig() bundle
 * @returns {{ok: boolean, reason: string|null}}
 */
export function packetOwnershipCheck(packet, config = {}) {
  const current = packetOwner(config);
  const owner = packet?.owner ?? null;
  if (!owner) {
    // Legacy packet: fall back to the one identity it has always carried.
    const named = String(packet?.candidateName ?? '').trim();
    if (named && current.candidateName && !sameText(named, current.candidateName)) {
      return { ok: false, reason: `it was prepared for ${named}, not ${current.candidateName}` };
    }
    return { ok: true, reason: null };
  }
  if (owner.candidateName && current.candidateName && !sameText(owner.candidateName, current.candidateName)) {
    return { ok: false, reason: `it was prepared for ${owner.candidateName}, not ${current.candidateName}` };
  }
  if (owner.candidateEmail && current.candidateEmail && owner.candidateEmail !== current.candidateEmail) {
    return { ok: false, reason: `it was prepared for ${owner.candidateEmail}, not ${current.candidateEmail}` };
  }
  if (owner.profileId && current.profileId && owner.profileId !== current.profileId) {
    return {
      ok: false,
      reason: `it was prepared under the "${owner.profileLabel ?? owner.profileId}" search profile, `
        + `and "${current.profileLabel ?? current.profileId}" is active now`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * @param {object} args
 * @param {object} args.job normalized job
 * @param {object} args.score scoreJob result
 * @param {string} args.tier explainScore tier
 * @param {object} args.candidate candidate config
 * @param {object} args.screeningAnswers screening config
 * @param {string} [args.resumePath] tailored resume path
 * @param {boolean} [args.resumeTailored] whether the resume was tailored (vs. master fallback)
 * @param {string|null} [args.resumeWarning] tailoring warning, if any
 * @param {object} [args.coverLetter] generateCoverLetter result
 * @param {string} [args.coverLetterPath] saved cover letter file path
 * @param {Array} [args.formFields] discovered form fields [{label, selector, choices}]
 * @param {string} [args.html] page html for ATS detection
 * @returns {object} application packet
 */
export function buildApplicationPacket({
  job, score, tier, candidate, screeningAnswers,
  resumePath, resumeTailored = false, resumeWarning = null,
  resumePdfPath = null, resumePreviewWarning = null, resumeValidation = null, atsReport = null,
  tailoring = null, owner = null,
  coverLetter, coverLetterPath, formFields = [], html = '',
}) {
  const ats = detectAts({ url: job.url, html });
  const platform = getPlatform(ats.platform);

  const prefill = buildPrefillPlan(formFields, { candidate, screeningAnswers });
  const uploads = buildUploadPlan({ resumePath, coverLetterPath });

  const partialPacket = { job, prefill, uploads };
  const fillPlan = platform.prepare(partialPacket);

  const blockers = [...uploads.blockers];
  if (prefill.needsUser.length) {
    blockers.push(`${prefill.needsUser.length} screening field(s) need user input`);
  }
  if (resumeWarning) {
    blockers.push(`resume: ${resumeWarning}`);
  }

  // Screening answer plan: the subset of the fill plan sourced from screening
  // answers, plus the questions that still need a human. Surfaced explicitly so a
  // reviewer can audit every answer the agent intends to give.
  const screeningPlan = {
    answered: prefill.plan.filter((p) => p.source === 'screening'),
    needsUser: prefill.needsUser,
  };

  return {
    id: randomUUID(),
    createdAt: nowIso(),
    // WHOSE APPLICATION THIS IS. Read back by `packetOwnershipCheck` before any
    // path reuses a stored packet, so a packet built for one candidate can
    // never be filled onto another candidate's application. See `packetOwner`.
    owner: owner ?? {
      profileId: null,
      profileLabel: null,
      candidateName: String(candidate?.identity?.fullName ?? '').trim(),
      candidateEmail: String(candidate?.contact?.email ?? '').trim().toLowerCase(),
      resumeFingerprint: null,
    },
    job: {
      id: job.id, company: job.company, title: job.title, url: job.url,
      source: job.source, location: job.location,
    },
    jdSummary: summarizeJd(job.jdText),
    score: score?.total ?? null,
    tier: tier ?? null,
    sponsorship: score?.sponsorship ?? job.sponsorship ?? null,
    matchedKeywords: score?.matchedKeywords ?? [],
    missingKeywords: score?.missingKeywords ?? [],
    resumePath: resumePath ?? null,
    resumeTailored: Boolean(resumeTailored),
    resumeWarning: resumeWarning ?? null,
    resumePdfPath: resumePdfPath ?? null,
    // Preview conversion is best-effort and must never block an otherwise
    // valid application packet. The dashboard can retry it on demand.
    resumePreviewWarning: resumePreviewWarning ?? null,
    resumeValidation: resumeValidation ?? null,
    // Evidence-backed tailoring report: every change made to the resume for
    // THIS job (skill reorders with before/after, emphasis evidence, focus
    // line) and the JD requirements the resume does not support (never
    // inserted). This is what the human reviews before approving.
    tailoring: tailoring ?? null,
    atsReport: atsReport ?? null,
    coverLetterPath: coverLetterPath ?? null,
    coverLetterGenerated: Boolean(coverLetter?.generated),
    ats,
    prefill,
    uploads,
    fillPlan,
    screeningPlan,
    blockers,
    approvalStatus: 'pending_review',
    // HARD GATE: a freshly built packet is never ready to submit. Both flags are
    // surfaced at the packet top level (not only inside fillPlan) so any consumer
    // can see the stop-before-submit guarantee without inspecting the plan.
    stopBeforeSubmit: true,
    submitReady: false,
  };
}

/** First ~600 chars of the JD as a quick reviewer summary (whitespace-collapsed). */
function summarizeJd(jdText = '', maxChars = 600) {
  const clean = String(jdText ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Persist a packet to disk as JSON and return the file path.
 * @param {object} packet
 * @param {string} dir output directory
 * @param {string} [fileName] explicit file name (defaults to `${packet.id}.json`)
 * @returns {string} written path
 */
export function writePacket(packet, dir, fileName) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName ?? `${packet.id}.json`);
  // Atomic: the dashboard reads packet JSON on demand — it must never see a
  // half-written packet.
  writeFileAtomic(path, JSON.stringify(packet, null, 2), 'utf8');
  return path;
}
