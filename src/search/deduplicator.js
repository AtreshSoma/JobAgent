/**
 * Deduplicate normalized jobs.
 *
 * A job is a duplicate when its dedup key matches one already seen. The
 * primary key is normalized company + normalized title only — deliberately NOT
 * the source job id or location — so the same role posted across many cities
 * (e.g. a Deloitte listing repeated for 24 metros, each with its own gh_jid)
 * collapses to a single entry instead of flooding the queue. When two records
 * share a key, the one with the richer job description text is kept.
 *
 * A SECONDARY key is the normalized application URL: two records pointing at
 * the same posting are the same job even when their parsed company/title
 * differ (an aggregator that dropped the company name, a retitled cross-post).
 *
 * Optionally accepts an `exists(id|key)` predicate to also drop jobs already
 * present in the database from previous runs.
 */

import { normalizeLoose } from '../utils/textNormalize.js';
import { passesUsOnlyGate } from '../scoring/exclusionFilter.js';

/**
 * @param {object[]} jobs normalized jobs
 * @param {object} [options]
 * @param {(job: object, key: string) => boolean} [options.existsInDb]
 *   return true to treat a job as a known duplicate from a prior run
 * @returns {{ unique: object[], duplicates: object[], seenKeys: string[] }}
 */
export function deduplicate(jobs = [], { existsInDb, geography = null } = {}) {
  // The same US-only test the exclusion stage applies, so the copy kept here is
  // the one that will survive there. No geography config: every copy passes.
  const passesGeo = (job) => passesUsOnlyGate(job, geography);
  /** @type {Map<string, object>} */
  const byKey = new Map();
  /** @type {Set<string>} normalized URLs already owned by a kept record */
  const seenUrls = new Set();
  const duplicates = [];

  for (const job of jobs) {
    const key = keyFor(job);
    const urlKey = urlKeyFor(job);

    if (typeof existsInDb === 'function' && existsInDb(job, key)) {
      duplicates.push({ job, reason: 'exists_in_db', key });
      continue;
    }

    const prior = byKey.get(key);
    if (!prior) {
      // New company::title — but the same posting URL may already be kept
      // under a differently-parsed company/title. Same URL = same job.
      if (urlKey && seenUrls.has(urlKey)) {
        duplicates.push({ job, reason: 'duplicate_url', key: urlKey });
        continue;
      }
      byKey.set(key, job);
      if (urlKey) seenUrls.add(urlKey);
      continue;
    }
    // WHICH COPY SURVIVES.
    //
    // Longer JD used to win outright, so "Acme — Data Engineer (Remote, US)"
    // lost to the richer "Acme — Data Engineer (Bangalore)" copy, which the
    // US-only gate then discarded — and the role vanished from the board
    // although a perfectly good US copy had been found. The copy that PASSES
    // the geography gate now wins; JD length only breaks a tie. The loser's
    // location is kept on the winner as `alsoAt`, so the other places the role
    // is offered remain visible.
    const jobOk = passesGeo(job);
    const priorOk = passesGeo(prior);
    const jobWins = jobOk !== priorOk
      ? jobOk
      : (job.jdText?.length ?? 0) > (prior.jdText?.length ?? 0);
    const [winner, loser] = jobWins ? [job, prior] : [prior, job];
    noteAlsoAt(winner, loser);
    if (jobWins) {
      byKey.set(key, job);
      if (urlKey) seenUrls.add(urlKey);
    }
    duplicates.push({ job: loser, reason: 'duplicate_in_batch', key });
  }

  return {
    unique: [...byKey.values()],
    duplicates,
    seenKeys: [...byKey.keys()],
  };
}

/** Query params that are pure tracking noise — never part of a job's identity. */
const TRACKING_PARAM_RE = /^(utm_\w+|gclid|fbclid|msclkid|ref|referrer|referer|src|source|gh_src|lever-source|trk|trackingid|cid|mkt_tok)$/i;

/**
 * Normalize an application URL into a stable identity key: lowercase host
 * (www. stripped), no hash, no trailing slash, tracking params removed,
 * remaining params sorted. Identity params like Greenhouse's gh_jid survive.
 *
 * @param {object} job
 * @returns {string|null} normalized URL key, or null when the job has no URL
 */
export function urlKeyFor(job = {}) {
  const raw = String(job.url ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAM_RE.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    return `${host}${path}${params ? `?${params}` : ''}`;
  } catch {
    return raw.toLowerCase();
  }
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
  // A record with NO company must not collapse across employers: "Data
  // Engineer" from an aggregator that dropped the employer name keyed as just
  // "data engineer" and swallowed every other company-less Data Engineer in the
  // run. Without a company, the posting's own host (or its source) stands in.
  if (!company) {
    const where = hostOf(job.url) || normalizeLoose(job.source) || 'unknown';
    return ['~', where, title].filter(Boolean).join('::');
  }
  return [company, title].filter(Boolean).join('::');
}

/** Lowercased hostname of a URL, `www.` stripped, or ''. */
function hostOf(url) {
  try {
    return new URL(String(url ?? '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Record the loser's location on the winner, once, without touching `location`. */
function noteAlsoAt(winner, loser) {
  const places = [loser.location, ...(loser.rawMetadata?.alsoAt ?? [])]
    .map((p) => String(p ?? '').trim()).filter(Boolean);
  if (!places.length) return;
  winner.rawMetadata = winner.rawMetadata ?? {};
  const own = String(winner.location ?? '').trim();
  const merged = new Set(winner.rawMetadata.alsoAt ?? []);
  for (const p of places) if (p !== own) merged.add(p);
  if (merged.size) winner.rawMetadata.alsoAt = [...merged];
}
