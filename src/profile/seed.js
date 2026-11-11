/**
 * Start a new person with jobs that are already on this computer.
 *
 * A new workspace begins empty, and a full search takes ~14 minutes. Most of
 * what that search would find is often already in another person's store — a
 * pharmacovigilance posting that the data engineer's search happened to pass
 * over is still a posting. This copies the ones whose TITLE clearly fits the
 * new person into their workspace.
 *
 * WHAT IS COPIED: the posting's own facts — company, title, location, URL,
 * description, dates, the source and its sponsorship evidence.
 * WHAT IS NOT: anything that belongs to the person it was found for — their
 * score, tier, decision, reason, notes, tailored resume, packet, application
 * and history. Copies arrive unscored (status 'scored' with no fingerprint),
 * which is exactly what `rescoreStale` re-judges, so they are scored under the
 * NEW person's profile on activation — never carrying the old person's verdict.
 */
import { profileVocabularyFor, classifyTitleFit } from '../scoring/profileFit.js';

/** Posting facts only. Nothing here is a judgement about a person. */
const POSTING_COLUMNS = [
  'id', 'source', 'company', 'title', 'location', 'url', 'jd_text', 'posted_at',
  'applicant_count', 'employment_type', 'employment_category', 'compensation_text',
  'sponsorship', 'sponsorship_signals', 'ats_platform', 'summary_only', 'search_query',
];

/** Read in chunks so a large store never loads every description at once. */
const CHUNK = 200;

/**
 * @param {object} args
 * @param {object} args.from database wrapper to copy from (the person whose list it is)
 * @param {object} args.to   the new person's database wrapper
 * @param {object} args.candidate the new person's derived candidate config (targetTitles, …)
 * @param {number} [args.maxAgeDays=45] only postings this recent (or undated, found this recently)
 * @param {number} [args.limit=2000] newest first
 * @param {Date}   [args.now]
 * @returns {{ seeded: number, considered: number }}
 */
export function seedJobsInto({ from, to, candidate, maxAgeDays = 45, limit = 2000, now = new Date() }) {
  const src = from?.db;
  if (!src || typeof src.prepare !== 'function' || from === to) return { seeded: 0, considered: 0 };
  const vocab = profileVocabularyFor(candidate);
  if (!vocab) return { seeded: 0, considered: 0 };
  const cutoff = new Date(now.getTime() - maxAgeDays * 864e5).toISOString();

  // Titles first (cheap): personalized search rows only, recent, and not
  // closed by the employer. Closed or role-search rows are never copied.
  let heads;
  try {
    heads = src.prepare(`SELECT id, title FROM jobs
      WHERE coalesce(discovery_mode, 'profile') = 'profile'
        AND coalesce(discard_reason, '') NOT LIKE '%closed%'
        AND coalesce(status, '') <> 'closed'
        AND (coalesce(posted_at, '') >= ? OR (coalesce(posted_at, '') = '' AND coalesce(created_at, '') >= ?))
      ORDER BY coalesce(posted_at, created_at) DESC`).all(cutoff, cutoff);
  } catch {
    return { seeded: 0, considered: 0 };
  }
  // A POSITIVE title match only ("accept"): a copy the person never asked for
  // is noise in a list they have not looked at yet.
  const ids = heads.filter((h) => classifyTitleFit(h.title, vocab).verdict === 'accept').map((h) => h.id).slice(0, limit);

  let seeded = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = src.prepare(`SELECT ${POSTING_COLUMNS.join(', ')} FROM jobs WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk);
    for (const row of rows) {
      if (to.getJob?.(row.id)) continue; // already in their list: theirs wins
      to.upsertJob({ ...row, status: 'scored', score: null, tier: null, scoring_fingerprint: '', discovery_mode: 'profile' });
      seeded += 1;
    }
  }
  return { seeded, considered: heads.length };
}
