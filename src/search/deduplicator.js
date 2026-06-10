/**
 * Deduplicate normalized jobs.
 *
 * A job is a duplicate when its dedup key matches one already seen. The key is
 * normalized company + normalized title only — deliberately NOT the source job
 * id or location — so the same role posted across many cities (e.g. a Deloitte
 * listing repeated for 24 metros, each with its own gh_jid) collapses to a
 * single entry instead of flooding the queue. When two records share a key, the
 * one with the richer job description text is kept.
 *
 * Optionally accepts an `exists(id|key)` predicate to also drop jobs already
 * present in the database from previous runs.
 */

import { normalizeLoose } from '../utils/textNormalize.js';

/**
 * @param {object[]} jobs normalized jobs
 * @param {object} [options]
 * @param {(job: object, key: string) => boolean} [options.existsInDb]
 *   return true to treat a job as a known duplicate from a prior run
 * @returns {{ unique: object[], duplicates: object[], seenKeys: string[] }}
 */
export function deduplicate(jobs = [], { existsInDb } = {}) {
  /** @type {Map<string, object>} */
  const byKey = new Map();
  const duplicates = [];

  for (const job of jobs) {
    const key = keyFor(job);

    if (typeof existsInDb === 'function' && existsInDb(job, key)) {
      duplicates.push({ job, reason: 'exists_in_db', key });
      continue;
    }

    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, job);
      continue;
    }
    // Keep the record with the longer JD text; the other is the duplicate.
    if ((job.jdText?.length ?? 0) > (prior.jdText?.length ?? 0)) {
      byKey.set(key, job);
      duplicates.push({ job: prior, reason: 'duplicate_in_batch', key });
    } else {
      duplicates.push({ job, reason: 'duplicate_in_batch', key });
    }
  }

  return {
    unique: [...byKey.values()],
    duplicates,
    seenKeys: [...byKey.keys()],
  };
}

/**
 * Compute the dedup key for a normalized job.
 *
 * Company + title only. The source job id and location are intentionally
 * excluded so the same role advertised in multiple locations (each a distinct
 * posting/id) is treated as one. Job ids remain unique elsewhere (see
 * makeJobId), so this does not cause database primary-key collisions.
 */
export function keyFor(job = {}) {
  const company = normalizeLoose(job.company);
  const title = normalizeLoose(job.title);
  return [company, title].filter(Boolean).join('::');
}
