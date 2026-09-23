/**
 * Pipeline output artifacts.
 *
 * Writes the three human-readable JSON snapshots the rest of the toolchain (and
 * the user) reads:
 *
 *   data/found_jobs.json   — every discovered job + what happened to it
 *   data/scored_jobs.json  — every job that was scored (opt-in: deps.writeScoredJobs)
 *   data/queued_jobs.json  — only jobs strong enough for action (Priority/Apply/Queue)
 *
 * All three carry the same lifecycle vocabulary (src/lifecycle.js) and a shared
 * counters block so the numbers always reconcile. File writes are injectable so
 * the pipeline stays fully testable offline.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { writeFileAtomic } from './utils/fsSafe.js';

/** Canonical, zeroed counter block. */
export function emptyCounters() {
  return {
    jobs_found: 0,
    // Postings whose id was NOT already in the database before this run. This
    // is the number that answers "did the run find anything?" — `jobs_found`
    // counts everything every source returned, which on a mature corpus is
    // ~76k of overwhelmingly already-known rows, so a run that genuinely found
    // 2,800 new postings and one that found none read almost identically.
    jobs_new: 0,
    jobs_scored: 0,
    jobs_skipped_unchanged: 0,
    jobs_cancelled: 0,
    jobs_queued: 0,
    // Total discards. Kept for compatibility, but it conflates three unrelated
    // causes, so each now also has its own counter below — otherwise a user
    // cannot tell a run ruined by a geography rule from one that simply
    // surfaced old postings.
    jobs_discarded: 0,
    jobs_discarded_stale: 0,
    jobs_discarded_excluded: 0,
    jobs_discarded_low_score: 0,
    // Removed before scoring because another record already represented them.
    // Previously reduced to a bare length in the report and invisible in the
    // counters, which made over-collapsing dedup undiagnosable.
    jobs_duplicate: 0,
    jobs_suppressed_applied: 0,
    jobs_suppressed_url_owned: 0,
    // Scored below the bar ONLY because the description was never fetched.
    // Not a fit judgement — these are recoverable by `npm run enrich`.
    jobs_unread: 0,
    jobs_unknown_date_review: 0,
    jobs_prepared: 0,
    jobs_assisted: 0,
    jobs_submitted: 0,
  };
}

/** Tally rows by a key into { value: count }. */
export function countBy(rows = [], key) {
  const out = {};
  for (const r of rows) {
    const k = r[key] ?? 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function defaultWrite(dir, path, text) {
  mkdirSync(dir, { recursive: true });
  // Atomic: a dashboard/watch process reading this artifact mid-write must
  // never see a truncated JSON file.
  writeFileAtomic(path, text, 'utf8');
}

/** Write a JSON artifact under <root>/data/<filename>. Returns the path. */
function writeArtifact(root, filename, doc, deps = {}) {
  const writeImpl = deps.writeFileImpl ?? defaultWrite;
  const dir = join(root, 'data');
  const path = join(dir, filename);
  // Compact: found_jobs.json was ~40% whitespace at indent 2, and these files
  // are machine-read (harvestSources, the dashboard) — `jq .` pretty-prints.
  writeImpl(dir, path, JSON.stringify(doc));
  return path;
}

/** Full-visibility discovery audit trail. */
export function writeFoundJobs(root, payload, deps = {}) {
  const doc = {
    generatedAt: (deps.now ?? new Date()).toISOString(),
    counters: payload.counters,
    bySourceFound: countBy(payload.discovered, 'source'),
    bySourceKind: countBy(payload.discovered, 'sourceKind'),
    byDiscoveryMatch: countBy(payload.discovered, 'discoveryMatch'),
    byLifecycle: countBy(payload.discovered, 'lifecycle'),
    duplicates: payload.duplicates?.length ?? 0,
    errors: payload.errors ?? [],
    jobs: payload.discovered,
  };
  return writeArtifact(root, 'found_jobs.json', doc, deps);
}

/** Every job that made it past hard exclusions and was scored. */
export function writeScoredJobs(root, payload, deps = {}) {
  const scored = payload.scored ?? [];
  const doc = {
    generatedAt: (deps.now ?? new Date()).toISOString(),
    counters: payload.counters,
    byTier: countBy(scored, 'tier'),
    bySponsorship: countBy(scored, 'sponsorship'),
    byLifecycle: countBy(scored, 'lifecycle'),
    jobs: scored,
  };
  return writeArtifact(root, 'scored_jobs.json', doc, deps);
}

/** Only the jobs strong enough to act on (queued tiers). */
export function writeQueuedJobs(root, payload, deps = {}) {
  const queued = payload.queued ?? [];
  const doc = {
    generatedAt: (deps.now ?? new Date()).toISOString(),
    counters: payload.counters,
    byTier: countBy(queued, 'tier'),
    byLifecycle: countBy(queued, 'lifecycle'),
    jobs: queued,
  };
  return writeArtifact(root, 'queued_jobs.json', doc, deps);
}

/**
 * Jobs with no parseable posting date, held in a SEPARATE review bucket. These
 * are intentionally NOT mixed into the fresh found/scored/queued results — a
 * human can review them and decide whether any are worth pursuing.
 */
export function writeUnknownDateReview(root, payload, deps = {}) {
  const review = payload.review ?? [];
  const doc = {
    generatedAt: (deps.now ?? new Date()).toISOString(),
    note: 'Jobs without a parseable posting date. Not part of fresh results; review manually.',
    count: review.length,
    jobs: review,
  };
  return writeArtifact(root, 'unknown_date_review.json', doc, deps);
}

/** Convenience: write all artifacts in one call. */
//
// data/scored_jobs.json is no longer written by default: nothing in src/ or
// scripts/ reads it (the board reads SQLite), and it duplicated found_jobs.json.
// `deps.writeScoredJobs: true` restores it for anyone who still wants the file.
export function writeAllArtifacts(root, payload, deps = {}) {
  return {
    found: writeFoundJobs(root, payload, deps),
    scored: deps.writeScoredJobs === true ? writeScoredJobs(root, payload, deps) : null,
    queued: writeQueuedJobs(root, payload, deps),
    unknownDateReview: writeUnknownDateReview(root, payload, deps),
  };
}
