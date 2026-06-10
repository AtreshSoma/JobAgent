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
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { detectAts } from './atsDetector.js';
import { getPlatform } from './platforms/index.js';
import { buildPrefillPlan } from './formPrefill.js';
import { buildUploadPlan } from './fileUpload.js';
import { nowIso } from '../utils/dates.js';

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
  resumePdfPath = null, resumeValidation = null,
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
    resumeValidation: resumeValidation ?? null,
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
  writeFileSync(path, JSON.stringify(packet, null, 2), 'utf8');
  return path;
}
