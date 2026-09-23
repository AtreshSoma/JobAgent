/**
 * iCIMS connector — public career-portal listings and schema.org job detail.
 *
 *   list   GET {host}/jobs/search?ss=1&in_iframe=1&pr={page}
 *   detail GET {host}/jobs/{id}/{slug}/job?in_iframe=1
 *
 * WHY THIS EXISTS, AND WHY IT WAS PREVIOUSLY THOUGHT IMPOSSIBLE.
 * iCIMS is the single largest ATS by market share (~11%, ~6,400 employers,
 * roughly a quarter of the Fortune 500), and this codebase had it recorded as
 * "JS-only SPA shell, no public JSON feed" — a conclusion that was wrong, and
 * expensively so. Fetching `/jobs/search?ss=1` really does return a ~26 KB
 * wrapper with zero job links. But that wrapper is not a JavaScript app: it is
 * an IFRAME host, and its own inline script immediately points the frame at the
 * SAME url plus `in_iframe=1`. Requesting that directly returns ~132 KB of
 * fully server-rendered HTML with 50 job links in it. No JS engine required.
 *
 * `in_iframe=1` is NOT an evasion or a private parameter. It is the public URL
 * the page itself navigates to one millisecond later, on the same host, with no
 * auth, no token and no cookie. We are asking for the document iCIMS intends a
 * visitor to read; we are just skipping the frame it would be painted into.
 *
 * ROBOTS. Checked on two portals (identical text): `/jobs/search` and
 * `/jobs/{id}/{slug}/job` are NOT disallowed, and robots.txt explicitly
 * publishes `/sitemap.xml`. Everything it does disallow is candidate-account
 * territory — `*login`, `*candidate`, `*referral`, `/connect*` — and
 * `isDisallowedPath` below refuses those, so a listing that links to the login
 * variant of a job cannot pull us somewhere we were asked not to go.
 *
 * The detail page carries a real schema.org JobPosting JSON-LD block (only on
 * the `in_iframe=1` variant), so descriptions and dates are read from structured
 * data rather than scraped out of markup.
 *
 * ONE URL TRAP: the page's own Apply button carries `&hashed=-1834476062`, a
 * server-generated token that cannot be synthesized. We never try. The stored
 * link is the clean canonical `/jobs/{id}/{slug}/job`, which is a real 200 page
 * with a working Apply button on it.
 */

import { parseJsonLdJobs, normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchTextWithTimeout, discoveryHeaders } from '../../utils/httpClient.js';
import { makeTitleGate, makeAgeGate } from './atsSearch.js';
import { profileVocabularyFor, sortByTitleFit } from '../../scoring/profileFit.js';
import { lookupDetail, jobFromCachedDetail } from '../detailBudget.js';

export const adapterId = 'icims';

/** Results per listing page. iCIMS fixes this; `pr` is a PAGE index, not a row offset. */
const PAGE_SIZE = 50;

/** Hard runaway guard on listing pages per portal. */
const MAX_PAGES = 20;

/** Portals fetched in parallel when ctx omits a ceiling. */
const DEFAULT_BOARD_CONCURRENCY = 4;

/** Detail pages fetched in parallel per portal when ctx omits a ceiling. */
const DEFAULT_DETAIL_CONCURRENCY = 4;

/** Detail budget per portal — the title gate normally keeps this well under. */
const DEFAULT_MAX_DETAIL_FETCHES = 40;

/**
 * Paths iCIMS robots.txt disallows. The listing links to some of these (a job
 * row emits both a plain and a `login` variant), so this is enforced rather
 * than assumed — a disallowed URL is dropped before it is ever requested.
 */
const DISALLOWED_RE = /(\/jobs\/[^?]*(?:referral|login|candidate)|\/jobs\/reminder|\/connect)/i;

/** True when a URL falls inside iCIMS's robots.txt Disallow set. */
export function isDisallowedPath(url) {
  try {
    const { pathname } = new URL(url);
    return DISALLOWED_RE.test(pathname);
  } catch {
    return true;
  }
}

/**
 * @param {object} source jobboards entry
 * @param {Array<string|object>} source.boards portal hosts, e.g.
 *   `"careers-acme.icims.com"` or `{ host, company }`
 * @param {object} [source.options]
 * @param {string[]} [source.options.titles] overrides candidate.targetTitles
 * @param {boolean} [source.options.strictTitleMatch=true]
 * @param {number} [source.options.maxDetailFetches]
 * @param {number} [source.options.maxAgeDays]
 * @param {number} [source.options.maxPages]
 * @param {object} ctx adapter context
 * @returns {Promise<{ jobs: object[], errors: object[], cancelled: boolean }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const options = source.options ?? {};
  const boards = (Array.isArray(source.boards) ? source.boards : [])
    .map(normalizeBoard)
    .filter((b) => b.host);
  const boardConcurrency = ctx.boardConcurrency ?? DEFAULT_BOARD_CONCURRENCY;
  const detailConcurrency = ctx.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
  const maxDetailFetches = Number.isFinite(options.maxDetailFetches)
    ? Math.max(0, options.maxDetailFetches)
    : DEFAULT_MAX_DETAIL_FETCHES;
  const maxPages = Number.isFinite(options.maxPages)
    ? Math.min(MAX_PAGES, Math.max(1, Math.trunc(options.maxPages)))
    : MAX_PAGES;

  const titleGate = makeTitleGate({
    titles: options.titles ?? ctx.candidate?.targetTitles ?? [],
    strict: options.strictTitleMatch !== false,
    candidate: ctx.candidate ?? null,
  });
  const ageGate = makeAgeGate(options.maxAgeDays);
  // Spend the fixed detail budget on the most likely fits first. The gate is
  // now permissive (unknown titles are kept for the description to judge), so
  // without ordering the budget would be consumed by speculative rows before
  // reaching a certain match. Same request count, better spent.
  const vocab = profileVocabularyFor(ctx.candidate);
  const detailCache = ctx.detailCache ?? ctx.workdayDetailCache ?? null;

  const jobs = [];
  const errors = [];
  let cancelled = false;
  let reused = 0;

  const request = async (url) => {
    if (rateLimiter) await rateLimiter.wait(`icims:${new URL(url).host}`, source.rateLimitMs);
    const call = () => fetchText(fetchImpl, url, requestTimeoutMs);
    return withRetry(() => (hostGate ? hostGate.run(url, call) : call()), { maxRetries });
  };

  const perBoard = await mapWithConcurrency(boards, boardConcurrency, async (board) => {
    if (ctx.shouldCancel?.()) return { jobs: [], errors: [], cancelled: true };
    const boardErrors = [];
    let rows = [];

    // Page 0 first: it carries the "Page 1 of N" label, so the real page count
    // is read from the portal rather than probed for by requesting until empty.
    let pageCount = 1;
    try {
      const html = await request(listUrl(board.host, 0));
      rows = extractJobRows(html, board.host);
      pageCount = Math.min(maxPages, Math.max(1, totalPages(html)));
    } catch (err) {
      return {
        jobs: [],
        errors: [{
          board: board.host, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0,
        }],
      };
    }

    const pages = [];
    for (let p = 1; p < pageCount; p += 1) pages.push(p);
    const rest = await mapWithConcurrency(pages, 2, async (p) => {
      if (ctx.shouldCancel?.()) { cancelled = true; return []; }
      try {
        return extractJobRows(await request(listUrl(board.host, p)), board.host);
      } catch (err) {
        if (err?.cancelled) { cancelled = true; return []; }
        boardErrors.push({
          board: board.host, page: p, error: err.message, status: err.status ?? null,
        });
        return [];
      }
    });
    for (const r of rest) rows.push(...(r ?? []));

    // Dedupe on the posting id — a portal repeats a job across pages when the
    // result set shifts between requests.
    const seen = new Set();
    const unique = [];
    for (const row of rows) {
      if (!row.id || seen.has(row.id)) continue;
      seen.add(row.id);
      unique.push(row);
    }

    // Gate on the listing's own title before spending a detail request.
    const gated = unique.filter((row) => titleGate(row.title));
    // Postings read on an earlier run are rebuilt from the stored row (looked up
    // by URL — an iCIMS job id depends on what the detail page says) and cost no
    // request, so the budget below lands on postings never read before.
    const fromCache = [];
    const candidates = [];
    for (const row of gated) {
      const hit = lookupDetail(detailCache, { url: row.url, source: 'icims' });
      const job = hit ? jobFromCachedDetail(hit, {
        source: 'icims', url: row.url, title: row.title, rawMetadata: { portal: board.host },
      }) : null;
      if (job && ageGate(job.postedAt)) fromCache.push(job);
      else if (!job) candidates.push(row);
    }
    if (vocab) {
      candidates.splice(0, candidates.length, ...sortByTitleFit(candidates, (row) => row.title, vocab));
    }
    const budgeted = maxDetailFetches > 0 ? candidates.slice(0, maxDetailFetches) : [];
    const dropped = candidates.length - budgeted.length;

    const detailed = await mapWithConcurrency(budgeted, detailConcurrency, async (row) => {
      if (ctx.shouldCancel?.()) { cancelled = true; return null; }
      try {
        const html = await request(detailUrl(row.url));
        const job = mapJob(html, row, board);
        if (!job) return null;
        if (!ageGate(job.postedAt)) return null;
        return job;
      } catch (err) {
        if (err?.cancelled) return null;
        boardErrors.push({
          board: board.host, jobId: row.id, error: err.message, status: err.status ?? null,
        });
        return null;
      }
    });

    if (dropped > 0) {
      boardErrors.push({
        board: board.host,
        degraded: true,
        count: dropped,
        error: `${dropped} title match(es) on ${board.company ?? board.host} went unread: the `
          + `per-portal detail budget (maxDetailFetches=${maxDetailFetches}) was reached. `
          + 'Raise it, or narrow the target titles, to cover them.',
      });
    }
    return { jobs: [...fromCache, ...detailed.filter(Boolean)], errors: boardErrors, reused: fromCache.length };
  });

  for (const r of perBoard) {
    if (!r) continue;
    jobs.push(...(r.jobs ?? []));
    reused += Number(r.reused) || 0;
    errors.push(...(r.errors ?? []));
    cancelled ||= r.cancelled === true;
  }

  if (boards.length === 0) {
    errors.push({
      note: 'icims source enabled but no portals configured. Add hosts to `boards`, '
        + 'e.g. "careers-acme.icims.com" or { host, company }.',
    });
  }

  return { jobs, errors, cancelled, reused };
}

/** Accept either a bare host string or a `{ host, company }` object. */
function normalizeBoard(entry) {
  if (typeof entry === 'string') {
    return { host: entry.trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''), company: null };
  }
  return {
    host: String(entry?.host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    company: entry?.company ?? entry?.name ?? null,
  };
}

/** Build a listing URL. `pr` is a zero-indexed PAGE number, not a row offset. */
export function listUrl(host, page = 0) {
  return `https://${host}/jobs/search?ss=1&in_iframe=1&pr=${page}`;
}

/** Add the `in_iframe=1` that makes iCIMS serve the rendered document. */
export function detailUrl(url) {
  const u = new URL(url);
  u.searchParams.set('in_iframe', '1');
  return u.href;
}

/**
 * Read the portal's own "Page 1 of N" label.
 *
 * Probing until a page comes back empty would work but costs an extra request
 * per portal and, on a portal that repeats its last page, never terminates.
 *
 * @param {string} html listing HTML
 * @returns {number} total pages, 1 when the label is absent
 */
export function totalPages(html) {
  const m = /Page\s+\d+\s+of\s+(\d+)/i.exec(String(html ?? ''));
  const n = m ? Number(m[1]) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Extract `{ id, title, url }` for every job linked from a listing page.
 *
 * Anchor text is the job title on iCIMS listings, which is what lets the title
 * gate run BEFORE any detail request — the difference between a handful of
 * requests per portal and one per posting.
 *
 * @param {string} html listing HTML (must be the `in_iframe=1` variant)
 * @param {string} host portal host, for resolving relative links
 * @returns {Array<{id: string, title: string, url: string}>}
 */
export function extractJobRows(html, host) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']*\/jobs\/(\d+)\/[^"']*?\/job[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html ?? ''))) !== null) {
    let url;
    try {
      url = new URL(m[1], `https://${host}`).href;
    } catch {
      continue;
    }
    // The listing emits a `login` variant alongside the real link; robots.txt
    // disallows it, so it is dropped here rather than requested and discarded.
    if (isDisallowedPath(url)) continue;
    const id = m[2];
    // Store the CLEAN canonical URL — strip the tracking/frame params so the
    // saved apply link is the one a human would bookmark.
    const clean = `${new URL(url).origin}${new URL(url).pathname}`;
    if (seen.has(id)) continue;
    const title = htmlToText(m[3]).trim();
    if (!title) continue;
    seen.add(id);
    out.push({ id, title, url: clean });
  }
  return out;
}

/**
 * Drop iCIMS's `UNAVAILABLE` location placeholder.
 *
 * A remote or unspecified posting arrives as "UNAVAILABLE, UNAVAILABLE, US",
 * which is not a place and reads as corrupt data in the tracker. Only the
 * placeholder segments are removed — a real city keeps its country, and a row
 * that is nothing BUT placeholders becomes empty rather than being invented.
 *
 * @param {string} location
 * @returns {string}
 */
export function cleanLocation(location) {
  const parts = String(location ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p && !/^unavailable$/i.test(p));
  // A lone country left behind by the filter is not a location either.
  if (parts.length <= 1 && /^[A-Z]{2}$/.test(parts[0] ?? '')) return '';
  return parts.join(', ');
}

async function fetchText(fetchImpl, url, requestTimeoutMs) {
  // One deadline for headers AND body — see fetchTextWithTimeout.
  return fetchTextWithTimeout(fetchImpl, url, { headers: discoveryHeaders({ Accept: 'text/html,application/xhtml+xml' }) }, requestTimeoutMs, 'iCIMS');
}

/**
 * Build a normalized job from a detail page, preferring its schema.org JSON-LD.
 *
 * @param {string} html detail-page HTML (the `in_iframe=1` variant)
 * @param {{id: string, title: string, url: string}} row listing row
 * @param {{host: string, company: ?string}} board
 * @returns {object|null}
 */
export function mapJob(html, row, board = {}) {
  // The canonical, frame-free URL is what gets stored: a real 200 page with a
  // working Apply button. The page's own Apply href carries a server-generated
  // `hashed=` token that cannot be synthesized, so it is never reconstructed.
  const url = row.url;
  const [fromLd] = parseJsonLdJobs(html, { url, source: 'icims' });
  if (fromLd) {
    fromLd.sourceJobId = row.id;
    fromLd.url = url;
    if (!fromLd.title) fromLd.title = row.title;
    if (board.company) fromLd.company = board.company;
    fromLd.location = cleanLocation(fromLd.location);
    fromLd.rawMetadata = { ...(fromLd.rawMetadata ?? {}), portal: board.host, viaJsonLd: true };
    return fromLd;
  }

  // No JSON-LD (an older portal template). Keep the posting with the listing's
  // own title and whatever readable text the page carries, rather than dropping
  // a real job because its markup is a generation behind.
  const text = htmlToText(html).slice(0, 12000);
  if (!row.title) return null;
  return normalizeJob({
    source: 'icims',
    sourceJobId: row.id,
    company: board.company ?? board.host,
    title: row.title,
    url,
    jdText: text,
    rawMetadata: { portal: board.host, viaJsonLd: false },
  });
}
