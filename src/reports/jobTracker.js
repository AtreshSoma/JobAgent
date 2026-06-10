/**
 * Excel-friendly job tracker export.
 *
 * Joins every job in the SQLite store with its latest approval-queue row and
 * writes one tidy spreadsheet at `data/job_tracker.csv`. The "Submit Status"
 * column always reflects the human-gated reality: nothing reads "Submitted"
 * unless a human actually submitted it (jobs.applied = 1).
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { csvField } from './reportGenerator.js';
import { formatPostedRelative } from '../utils/dates.js';

/** Tracker columns, in spreadsheet order. */
const COLUMNS = [
  'Company', 'Job Role', 'Posted On', 'Applied On', 'Job URL', 'Submit Status',
  'Notes/Comments', 'Source', 'Location', 'Score', 'Tier', 'Sponsorship',
  'ATS', 'Resume Used', 'Cover Letter', 'Job ID',
];

/**
 * Human-readable submit status for a job + its latest approval row.
 * Order matters: an actual submission always wins, then explicit user actions,
 * then assist outcomes, then approval state, then pipeline progress.
 *
 * @param {object} job jobs-table row (may be partial)
 * @param {object|null} approval latest approval_queue row for the job
 * @returns {string}
 */
export function submitStatus(job = {}, approval = null) {
  if (Number(job.applied) === 1) return 'Submitted';
  if (job.status === 'skipped') return 'Skipped by you';
  if (job.status === 'ready_for_submit') return 'Filled — ready to submit';
  if (job.status === 'assist_blocked') return 'Filled — needs you (login/extra fields)';
  if (approval?.approval_status === 'approved') return 'Approved — not yet submitted';
  if (approval?.approval_status === 'rejected') return 'Rejected by you';
  if (job.application_packet_path) return 'Prepared — awaiting your approval';
  if (typeof job.score === 'number' || job.tier) return 'Scored';
  return 'Found';
}

/** Latest approval row per job id. */
function approvalsByJob(db) {
  const map = new Map();
  for (const a of db.listApprovals?.() ?? []) {
    // listApprovals is ordered by created_at ascending, so later rows win.
    map.set(a.job_id, a);
  }
  return map;
}

/**
 * Write data/job_tracker.csv from the jobs table + approval queue.
 *
 * @param {import('../logging/db.js').Database} db
 * @param {string} root project root
 * @returns {{ path: string, total: number, prepared: number, submitted: number }}
 */
export function writeJobTracker(db, root) {
  const jobs = db.listJobs({});
  const approvals = approvalsByJob(db);

  let prepared = 0;
  let submitted = 0;
  const rows = jobs.map((job) => {
    const approval = approvals.get(job.id) ?? null;
    const status = submitStatus(job, approval);
    if (Number(job.applied) === 1) submitted += 1;
    else if (job.application_packet_path) prepared += 1;
    return [
      job.company, job.title,
      job.posted_at ? formatPostedRelative(job.posted_at) : 'Unknown',
      job.applied_at ?? '',
      job.url, status,
      job.discard_reason ?? '',
      job.source, job.location, job.score, job.tier, job.sponsorship,
      job.ats_platform ?? '', job.resume_path ?? '', job.cover_letter_path ?? '',
      job.id,
    ].map(csvField).join(',');
  });

  const dir = join(root, 'data');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'job_tracker.csv');
  writeFileSync(path, [COLUMNS.join(','), ...rows].join('\n'), 'utf8');
  return { path, total: jobs.length, prepared, submitted };
}
