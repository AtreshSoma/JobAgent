/**
 * Re-admit postings the old discovery window discarded as `stale` (audit D1).
 *
 * Before the catch-up window (src/search/sourceCoverage.js) a posting first
 * seen after the window was written as `stale: posted N day(s) ago` and, being
 * discarded, was never judged again. On the live store that was 1,715 of 1,839
 * data-engineering postings. The pipeline no longer does that for new
 * sightings; this repairs the rows already written.
 *
 * Selection: discarded with a `stale:` reason, posted inside the retention
 * window, never applied to or decided on, and a title the active profile states
 * or treats as adjacent (BACKFILL_MIN_TITLE_FIT). For each one:
 *
 *   - title and location are run through the hard exclusions first. A row that
 *     fails one (e.g. a non-US location) keeps `discarded` with the TRUE reason,
 *     so the stale count stops hiding them.
 *   - otherwise it becomes `needs_description`. Stale discards were stored
 *     without their description, so the row is not scored here: the next
 *     discovery run (which re-reads the listing) or `npm run enrich` reads it,
 *     and the normal judge decides. Rows their source no longer lists are
 *     retired by the existing expiry pass.
 *
 * Report-only unless `apply` is true. Idempotent: a re-admitted row is no
 * longer `stale:` and is never selected twice.
 */

import { applyExclusions } from '../scoring/exclusionFilter.js';
import { profileVocabularyFor, titleFitPriority } from '../scoring/profileFit.js';
import { BACKFILL_MIN_TITLE_FIT } from '../search/sourceCoverage.js';

export const READMITTED_REASON = 'not judged: re-admitted after a stale discard; description not read yet';

/**
 * @param {object} args
 * @param {object} args.db openDatabase() handle
 * @param {object} args.config loadConfig() bundle
 * @param {Date} [args.now]
 * @param {boolean} [args.apply]
 * @param {number} [args.limit]
 * @returns {{considered: number, readmitted: number, relabelled: number, notFit: number,
 *   reasons: Record<string, number>, sample: Array<{company: string, title: string, posted_at: string}>}}
 */
export function rejudgeStale({ db, config, now = new Date(), apply = false, limit = Infinity } = {}) {
  const raw = db?.db;
  const out = { considered: 0, readmitted: 0, relabelled: 0, notFit: 0, reasons: {}, sample: [] };
  if (!raw || typeof raw.prepare !== 'function') return out;
  const retentionDays = Number(config?.exclusions?.staleness?.skipOlderThanDays) || 45;
  const cutoff = new Date(now.getTime() - retentionDays * 864e5).toISOString();
  const vocab = config?.candidate ? profileVocabularyFor(config.candidate) : null;
  if (!vocab) return out;

  const rows = raw.prepare(`SELECT id, company, title, location, url, posted_at, employment_type
      FROM jobs
      WHERE status = 'discarded' AND discard_reason LIKE 'stale:%'
        AND posted_at IS NOT NULL AND posted_at <> '' AND posted_at >= ?
        AND coalesce(applied, 0) = 0 AND coalesce(user_decision, '') = ''
        AND coalesce(application_packet_path, '') = ''
      ORDER BY posted_at DESC`).all(cutoff);

  const readmit = [];
  const relabel = [];
  for (const row of rows) {
    if (out.considered >= limit) break;
    out.considered += 1;
    if (titleFitPriority(row.title, vocab) < BACKFILL_MIN_TITLE_FIT) {
      out.notFit += 1;
      continue;
    }
    const job = {
      id: row.id, company: row.company, title: row.title, location: row.location ?? '',
      url: row.url, postedAt: row.posted_at, employmentType: row.employment_type ?? '', jdText: '',
    };
    const exclusion = applyExclusions(job, config.exclusions ?? {}, { now, candidate: config.candidate });
    if (exclusion.excluded) {
      relabel.push({ id: row.id, reason: exclusion.reason });
      const kind = String(exclusion.reason).split(':')[0];
      out.reasons[kind] = (out.reasons[kind] ?? 0) + 1;
      continue;
    }
    readmit.push(row.id);
    if (out.sample.length < 15) out.sample.push({ company: row.company, title: row.title, posted_at: row.posted_at });
  }
  out.readmitted = readmit.length;
  out.relabelled = relabel.length;
  if (!apply) return out;

  const stamp = now.toISOString();
  const run = () => {
    const toUnread = raw.prepare(`UPDATE jobs SET status = 'needs_description', discard_reason = ?,
        tier = NULL, score = NULL, scoring_fingerprint = NULL, updated_at = ? WHERE id = ?`);
    for (const id of readmit) toUnread.run(READMITTED_REASON, stamp, id);
    const toReason = raw.prepare('UPDATE jobs SET discard_reason = ?, updated_at = ? WHERE id = ?');
    for (const { id, reason } of relabel) toReason.run(reason, stamp, id);
  };
  if (typeof db.transaction === 'function') db.transaction(run);
  else run();
  return out;
}
