/**
 * Deterministic, side-effect-free Auto-Apply precheck.
 *
 * This is deliberately stricter than ordinary "Fill in browser". Auto-Apply
 * may reach the final Submit control, so every fact that can be checked before
 * opening a browser must be known and safe. Dynamic browser checks (login,
 * CAPTCHA, required fields, uploads, and final confirmation) still run inside
 * applyRunner and can stop the attempt at any time.
 */

import { APPROVAL_STATUS } from './approvalQueue.js';

/** ATS contracts exercised by local, no-submit browser fixtures. */
export const FIXTURE_VERIFIED_AUTO_APPLY_ATS = Object.freeze([
  'greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'generic',
]);

const VERIFIED_ATS = new Set(FIXTURE_VERIFIED_AUTO_APPLY_ATS);
const CLOSED_DECISIONS = new Set(['rejected', 'archived']);
const DUPLICATE_STATUSES = new Set(['submitted', 'submit_unverified']);

function clean(value) {
  return String(value ?? '').trim();
}

function httpUrl(value) {
  try { return /^https?:$/.test(new URL(clean(value)).protocol); }
  catch { return false; }
}

function inferredAts(job = {}, packet = null) {
  const explicit = clean(packet?.ats?.platform ?? job.ats_platform).toLowerCase();
  if (explicit) return explicit;
  const source = clean(job.source).toLowerCase();
  return VERIFIED_ATS.has(source) ? source : 'unknown';
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))];
}

/**
 * @param {object} args
 * @param {object|null} args.job database job row
 * @param {object|null} [args.approval] latest approval row
 * @param {object|null} [args.packet] parsed application packet
 * @param {boolean} [args.autoSubmitAuthorized=false] explicit authorization for this run
 * @returns {object} privacy-safe eligibility preview
 */
export function evaluateAutoApplyEligibility({
  job, approval = null, packet = null, autoSubmitAuthorized = false,
} = {}) {
  if (!job) {
    return {
      jobId: null, eligible: false, autoSubmitAuthorized,
      ats: 'unknown', reasons: ['Job no longer exists in the local database.'],
      warnings: [], checks: [], nextAction: 'Refresh the workbench.',
    };
  }

  const reasons = [];
  const warnings = [];
  const checks = [];
  const add = (id, passed, label, detail) => {
    checks.push({ id, passed, label, detail });
    if (!passed) reasons.push(detail);
  };

  const applied = Number(job.applied) === 1 || DUPLICATE_STATUSES.has(job.status);
  add('duplicate', !applied, 'No prior submission', applied
    ? 'Already submitted or awaiting submission verification; reopening could create a duplicate.'
    : 'No completed or unverified submission is recorded.');

  const decisionOpen = !CLOSED_DECISIONS.has(job.user_decision);
  add('decision', decisionOpen, 'Job remains actionable', decisionOpen
    ? 'The job is not rejected or archived.'
    : `The job is ${job.user_decision}; clear that decision before Auto-Apply.`);

  add('url', httpUrl(job.url), 'Application URL is valid', httpUrl(job.url)
    ? 'The saved URL uses HTTP(S).'
    : 'A valid HTTP(S) application URL is required.');

  const sponsorship = clean(job.sponsorship) || 'Unconfirmed';
  const sponsorshipSafe = !job.sponsorshipGated && !/^unconfirmed$/i.test(sponsorship)
    && !/no sponsorship|not sponsor|unlikely/i.test(sponsorship);
  add('sponsorship', sponsorshipSafe, 'Sponsorship precheck passes', sponsorshipSafe
    ? `Stored sponsorship assessment: ${sponsorship}.`
    : `Sponsorship is ${sponsorship}; verify compatibility before Auto-Apply.`);

  const ats = inferredAts(job, packet);
  add('ats', VERIFIED_ATS.has(ats), 'ATS has a fixture-tested contract', VERIFIED_ATS.has(ats)
    ? `${ats} is covered by a local no-submit fixture.`
    : `ATS is ${ats}; Auto-Apply is disabled until a supported contract is identified.`);

  add('packet', Boolean(packet), 'Application packet exists', packet
    ? 'A prepared packet is available for review.'
    : 'Prepare the application first so documents, answers, and ATS can be reviewed.');

  if (packet) {
    const packetBlockers = unique(packet.blockers ?? []);
    add('packet_blockers', packetBlockers.length === 0, 'Packet has no blockers', packetBlockers.length
      ? `Packet blockers: ${packetBlockers.join('; ')}`
      : 'No packet blockers are recorded.');

    const needsUser = unique([
      ...(packet.prefill?.needsUser ?? []).map((x) => x?.label ?? x?.field ?? x),
      ...(packet.screeningPlan?.needsUser ?? []).map((x) => x?.label ?? x?.field ?? x),
    ]);
    add('answers', needsUser.length === 0, 'Required saved answers are complete', needsUser.length
      ? `Questions still need your answer: ${needsUser.join('; ')}`
      : 'No unresolved packet questions are recorded.');

    const uploadBlockers = unique(packet.uploads?.blockers ?? []);
    const resumePath = clean(packet.resumePath ?? job.resume_docx_path ?? job.resume_path);
    add('resume', Boolean(resumePath) && !packet.resumeWarning, 'Approved resume is available', !resumePath
      ? 'The packet does not contain a resume document.'
      : packet.resumeWarning
        ? `Resume is not approved for Auto-Apply: ${clean(packet.resumeWarning)}`
        : 'The packet references a resume document with no recorded warning.');
    add('uploads', uploadBlockers.length === 0, 'Upload plan has no blockers', uploadBlockers.length
      ? `Upload blockers: ${uploadBlockers.join('; ')}`
      : 'No upload-plan blockers are recorded.');
  }

  if (approval?.approval_status === APPROVAL_STATUS.REJECTED) {
    reasons.push('The prepared packet was rejected; prepare and review a new packet first.');
  } else if (approval && approval.approval_status !== APPROVAL_STATUS.APPROVED) {
    warnings.push('Confirming Auto-Apply will also approve this reviewed packet for this run.');
  }

  if (!autoSubmitAuthorized) {
    warnings.push('Final submission is not authorized until you explicitly enable it for this run.');
  }
  warnings.push('Browser prechecks still stop for login, CAPTCHA/MFA, changed fields, upload failure, or missing confirmation evidence.');

  const eligible = reasons.length === 0;
  return {
    jobId: job.id,
    company: job.company ?? null,
    title: job.title ?? null,
    eligible,
    autoSubmitAuthorized,
    ats,
    reasons: unique(reasons),
    warnings: unique(warnings),
    checks,
    nextAction: eligible
      ? (autoSubmitAuthorized ? 'Eligible for this explicitly authorized Auto-Apply run.' : 'Review the warnings, then explicitly authorize final submission for this run.')
      : reasons[0],
  };
}

/** Evaluate and summarize a batch without performing any mutation. */
export function evaluateAutoApplyBatch({ items = [], autoSubmitAuthorized = false } = {}) {
  const results = items.map((item) => evaluateAutoApplyEligibility({
    ...item, autoSubmitAuthorized,
  }));
  return {
    autoSubmitAuthorized,
    total: results.length,
    eligible: results.filter((x) => x.eligible).length,
    ineligible: results.filter((x) => !x.eligible).length,
    items: results,
  };
}
