/**
 * Excel-friendly job tracker export.
 *
 * Joins every job in the SQLite store with its latest approval-queue row and
 * writes one tidy spreadsheet at `data/job_tracker.csv`. The "Submit Status"
 * column always reflects the human-gated reality: nothing reads "Submitted"
 * unless the human submitted it — or opt-in auto-submit VERIFIED the
 * submission (jobs.applied = 1). An unverified auto-submit click is called
 * out explicitly so it is never mistaken for a completed application.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { writeFileAtomic } from '../utils/fsSafe.js';
import { csvField } from './reportGenerator.js';
import { formatPostedRelative } from '../utils/dates.js';
import { deriveAppStatus, APP_STATUS } from '../dashboard/data.js';
import { jsonList } from '../utils/json.js';
import { latestApprovalsByJob as approvalsByJob } from '../apply/approvalQueue.js';

/** Tracker columns, in spreadsheet order. */
const COLUMNS = [
  'Company', 'Job Role', 'Posted On', 'Applied On', 'Job URL', 'Source',
  'Score', 'Tier', 'Sponsorship Confidence', 'Submit Status',
  'Resume Generated', 'Fields Filled', 'Blockers', 'Notes/Comments',
  'Location', 'ATS', 'Resume Used', 'Cover Letter', 'Job ID',
];

/** Spreadsheet label for every derived board status. */
const STATUS_LABELS = Object.freeze({
  [APP_STATUS.SUBMITTED]: 'Submitted',
  [APP_STATUS.SUBMIT_UNVERIFIED]: 'Auto-submit clicked — UNCONFIRMED (verify, then mark submitted)',
  [APP_STATUS.ARCHIVED]: 'Archived by you',
  [APP_STATUS.REJECTED]: 'Rejected by you',
  [APP_STATUS.SKIPPED]: 'Skipped by you',
  [APP_STATUS.BLOCKED]: 'Filled — needs you (login/extra fields)',
  [APP_STATUS.READY_FOR_SUBMIT]: 'Filled — ready to submit',
  [APP_STATUS.APPROVED]: 'Approved — not yet submitted',
  [APP_STATUS.NEEDS_REVIEW]: 'Prepared — awaiting your approval',
  [APP_STATUS.SHORTLISTED]: 'Shortlisted',
  [APP_STATUS.DATE_UNCONFIRMED]: 'Scored — posting date unconfirmed',
  [APP_STATUS.DISCARDED]: 'Filtered out during scoring',
  [APP_STATUS.SCORED]: 'Scored',
  [APP_STATUS.DISCOVERED]: 'Found',
});

/**
 * Human-readable submit status for a job + its latest approval row. Derives
 * from the SAME deriveAppStatus() precedence the dashboard board uses, so the
 * spreadsheet and the board can never drift apart, then maps to spreadsheet
 * wording.
 *
 * @param {object} job jobs-table row (may be partial)
 * @param {object|null} approval latest approval_queue row for the job
 * @returns {string}
 */
export function submitStatus(job = {}, approval = null) {
  const status = deriveAppStatus(job, approval);
  // A packet that exists but whose approval row is missing (edge case) still
  // reads as prepared rather than a bare "Scored".
  if ((status === APP_STATUS.SCORED || status === APP_STATUS.DISCOVERED)
      && job.application_packet_path) {
    return STATUS_LABELS[APP_STATUS.NEEDS_REVIEW];
  }
  return STATUS_LABELS[status] ?? 'Found';
}

/**
 * Write data/job_tracker.csv from the jobs table + approval queue.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} root project root
 * @returns {{ path: string, total: number, prepared: number, submitted: number }}
 */
export function writeJobTracker(db, root) {
  // Every column below is metadata — the JD body is never exported. Use the
  // summary read so the tracker does not haul ~150 MB of jd_text out of SQLite
  // on each rewrite (this runs after every mutating dashboard action, where it
  // measured ~520 ms of pure waste per click). Falls back for test stubs that
  // only implement listJobs.
  const jobs = typeof db.listJobsSummary === 'function' ? db.listJobsSummary() : db.listJobs({});
  const approvals = approvalsByJob(db);

  let prepared = 0;
  let submitted = 0;
  const rows = jobs.map((job) => {
    const approval = approvals.get(job.id) ?? null;
    const status = submitStatus(job, approval);
    if (Number(job.applied) === 1) submitted += 1;
    else if (job.application_packet_path) prepared += 1;
    // A resume counts as generated only when an actual tailored docx exists —
    // a master-resume fallback is "No (master fallback)" so it never overstates.
    const resumeGenerated = job.resume_docx_path ? 'Yes'
      : job.application_packet_path ? 'No (master fallback)' : '';
    return [
      job.company, job.title,
      job.posted_at ? formatPostedRelative(job.posted_at) : 'Unknown',
      job.applied_at ?? '',
      job.url, job.source,
      job.score, job.tier, job.sponsorship,
      status,
      resumeGenerated,
      typeof job.assist_filled_count === 'number' ? job.assist_filled_count : '',
      jsonList(job.assist_blockers).join('; '),
      // The human's own notes come first; the pipeline's discard reason is
      // appended so neither ever hides the other.
      [job.notes, job.discard_reason ? `Discarded: ${job.discard_reason}` : '']
        .filter(Boolean).join(' | '),
      job.location, job.ats_platform ?? '', job.resume_path ?? '',
      job.cover_letter_path ?? '', job.id,
    ].map(csvField).join(',');
  });

  const dir = join(root, 'data');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'job_tracker.csv');
  // Atomic: the dashboard rewrites this after every action while the user may
  // have it open in Excel — a torn CSV must be impossible.
  writeFileAtomic(path, [COLUMNS.join(','), ...rows].join('\n'), 'utf8');
  return { path, total: jobs.length, prepared, submitted };
}
