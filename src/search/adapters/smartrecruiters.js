/**
 * SmartRecruiters connector — uses the OFFICIAL public Posting API.
 *   https://api.smartrecruiters.com/v1/companies/{company}/postings
 *
 * No login, no scraping, no evasion. Reads published posting JSON only.
 *
 * WHY THIS ADAPTER FETCHES DETAILS
 * --------------------------------
 * The list endpoint omits the full description. This adapter used to stop
 * there, synthesizing a compact jdText from the metadata that IS present
 * (title, function, industry, type, location) and claiming "scoring still works
 * because the title/discovery filters carry most signal". Measured on this
 * database, that claim was false in both directions:
 *
 *   37,576 postings stored, 37,274 of them under 200 characters, of which
 *   37,567 were DISCARDED and 9 ever scored.
 *
 * The arithmetic makes that inevitable rather than unlucky: with no description
 * there are no stack, domain or keyword hits to find, so the reachable maximum
 * is ~44/100 against a 50 floor. Every summary-only posting is a guaranteed
 * discard no matter how well it fits. 11,131 of them were filed as "below score
 * threshold" — a fit conclusion the system never earned, because nothing had
 * read them.
 *
 * Two things fix it, and both are borrowed from the Workday adapter, which hit
 * the same wall and solved it already:
 *
 *   1. GATE ON THE TITLE FIRST. Every posting from all 119 companies used to be
 *      mapped unconditionally — the only enabled adapter with no title gate at
 *      all. That is what made this source 32% of the corpus for 9 scored rows.
 *   2. SPEND A DETAIL BUDGET, BEST-FIRST, AND BE HONEST ABOUT THE REST. What is
 *      fetched gets a real description; what is not keeps `summaryOnly = true`
 *      so the pipeline files it as `needs_description` instead of pretending it
 *      was judged, and `npm run enrich` can recover it later.
 */

import { normalizeJob } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchJsonWithTimeout, discoveryHeaders } from '../../utils/httpClient.js';
import { makeTitleGate, smartRecruitersJdText } from './atsSearch.js';
import { profileVocabularyFor, sortByTitleFit } from '../../scoring/profileFit.js';
import { hydrateFromDetailCache } from '../detailBudget.js';

export const adapterId = 'smartrecruiters';

/** Postings per request. 100 is the maximum the API serves in one page. */
const PAGE_LIMIT = 100;

/**
 * Hard ceiling on postings read per company, across all pages.
 *
 * This adapter used to issue exactly ONE request per company and keep whatever
 * the first 100 postings happened to be. That silently truncated every large
 * employer: ServiceNow publishes 442 postings and Experian 495, so more than
 * two thirds of both boards were never seen. Worse, it was invisible — the
 * window rotates as postings are added, so the database slowly accumulated
 * different first-100 slices and looked like healthy coverage.
 *
 * The API honors `offset`, so we now page until `totalFound` is reached. The
 * ceiling exists only to stop a runaway loop on a pathological board.
 */
const DEFAULT_MAX_POSTINGS_PER_COMPANY = 1000;

/** Default number of companies to fetch in parallel when ctx omits a ceiling. */
const DEFAULT_BOARD_CONCURRENCY = 8;

/**
 * Per-company ceiling on full-description fetches.
 *
 * Sized against what the title gate actually leaves behind: across 119
 * companies the gate keeps a small tail per board, so 40 covers most boards
 * outright while capping a pathological one. Postings past the budget are kept
 * as `summaryOnly` rather than dropped — they are still real openings, and the
 * enrich pass can read them later.
 */
const DEFAULT_MAX_DETAIL_FETCHES = 40;

/** Default parallelism for per-posting detail reads within one company. */
const DEFAULT_DETAIL_CONCURRENCY = 4;

/** Longest description we store, matching the other adapters. */
const MAX_JD_CHARS = 20_000;

/** Every SmartRecruiters company shares this host — key politeness on it. */
const SMARTRECRUITERS_HOST = 'api.smartrecruiters.com';

/**
 * @param {object} source jobboards source entry ({ boards: string[] } — SmartRecruiters company identifiers)
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {{ wait: Function }} [ctx.rateLimiter]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.boardConcurrency]
 * @param {number} [ctx.requestTimeoutMs]
 * @returns {Promise<{ jobs: object[], errors: Array<{company: string, error: string}> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const detailCache = ctx.detailCache ?? ctx.workdayDetailCache ?? null;
  const companies = Array.isArray(source.boards) ? source.boards : [];
  const concurrency = ctx.boardConcurrency ?? DEFAULT_BOARD_CONCURRENCY;
  const options = source.options ?? {};
  const maxPostings = Number.isFinite(source.maxPostingsPerCompany)
    ? Math.max(0, source.maxPostingsPerCompany)
    : DEFAULT_MAX_POSTINGS_PER_COMPANY;
  const maxDetailFetches = Number.isFinite(options.maxDetailFetches)
    ? Math.max(0, options.maxDetailFetches)
    : DEFAULT_MAX_DETAIL_FETCHES;
  const detailConcurrency = ctx.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;

  // The gate answers "is this CLEARLY NOT for me?" — it rejects only titles that
  // positively name another profession, so an unfamiliar title is kept and
  // decided on its description. `strictTitleMatch: false` disables it entirely.
  const titleGate = makeTitleGate({
    titles: ctx.candidate?.targetTitles ?? [],
    strict: options.strictTitleMatch !== false,
    candidate: ctx.candidate ?? null,
  });
  const vocab = profileVocabularyFor(ctx.candidate);

  const jobs = [];
  const errors = [];
  let cancelled = false;

  const perCompany = await mapWithConcurrency(companies, concurrency, async (company) => {
    if (ctx.shouldCancel?.()) { cancelled = true; return null; }
    const collected = [];
    try {
      // Page until the API says we have them all. Pages are sequential because
      // each one's necessity depends on the previous page's `totalFound`.
      for (let offset = 0; offset < maxPostings;) {
        if (ctx.shouldCancel?.()) { cancelled = true; break; }
        const limit = Math.min(PAGE_LIMIT, maxPostings - offset);
        const url = `https://${SMARTRECRUITERS_HOST}/v1/companies/${encodeURIComponent(company)}`
          + `/postings?limit=${limit}&offset=${offset}`;
        const call = () => fetchJson(fetchImpl, url, requestTimeoutMs);
        const data = await withRetry(
          () => (hostGate ? hostGate.run(url, call) : call()),
          { maxRetries },
        );
        const page = Array.isArray(data.content) ? data.content : [];
        collected.push(...page);
        // An empty or short page means the board is exhausted; without this a
        // board whose `totalFound` over-reports would loop to the ceiling.
        if (page.length === 0 || page.length < limit) break;
        offset += page.length;
        const total = Number(data.totalFound);
        if (Number.isFinite(total) && offset >= total) break;
      }
      const kept = await enrichCompany(collected, company, {
        titleGate, vocab, maxDetailFetches, detailConcurrency, detailCache,
        fetchImpl, hostGate, maxRetries, requestTimeoutMs, ctx,
      });
      return { ...kept, error: null };
    } catch (err) {
      // Keep whatever pages already succeeded — a failure on page 4 must not
      // discard pages 1-3. They stay summary-level: the listing is trustworthy
      // even when the run that would have enriched it died.
      //
      // Stored descriptions still apply here: without them a board whose 4th
      // page failed reported every posting as unread, even ones read last run.
      const partial = collected.filter((p) => titleGate(p?.name)).map((p) => mapPosting(p, company));
      const reused = hydrateFromDetailCache(partial, detailCache);
      return {
        jobs: partial,
        reused,
        error: { company, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0 },
      };
    }
  });

  let unread = 0;
  let failed = 0;
  let reused = 0;
  const statuses = new Set();
  for (const r of perCompany) {
    if (!r) continue;
    jobs.push(...r.jobs);
    if (r.error) errors.push(r.error);
    if (Array.isArray(r.errors)) errors.push(...r.errors);
    unread += r.unread ?? 0;
    failed += r.failed ?? 0;
    reused += r.reused ?? 0;
    for (const s of r.statuses ?? []) if (s) statuses.add(s);
  }

  // ONE note for the whole source. Saying nothing would let a run that read 4%
  // of what it found report as fully covered; saying it per company would say
  // the same thing 123 times.
  if (failed > 0) {
    errors.push({
      degraded: true,
      count: failed,
      error: `${failed} description fetch(es) failed`
        + `${statuses.size ? ` (HTTP ${[...statuses].join('/')})` : ''}; those postings were kept `
        + 'as summary-only and can be recovered with `npm run enrich`.',
    });
  }
  if (unread > 0) {
    errors.push({
      degraded: true,
      count: unread,
      error: `${unread} title match(es) were kept WITHOUT a description: the per-company detail `
        + `budget (maxDetailFetches=${maxDetailFetches}) was reached. They are stored as `
        + 'needs_description, not judged — run `npm run enrich` to read and score them.',
    });
  }
  return { jobs, errors, cancelled, reused };
}

/**
 * Gate one company's postings on title, then spend the detail budget best-first.
 *
 * Nothing is DROPPED for want of budget — a posting past the ceiling keeps
 * `summaryOnly = true` and reaches the pipeline as `needs_description`. Dropping
 * it would hide a real opening; mislabeling it as scored would assert a
 * judgement no one made.
 *
 * @returns {Promise<{ jobs: object[], errors: object[] }>}
 */
async function enrichCompany(postings, company, cfg) {
  const {
    titleGate, vocab, maxDetailFetches, detailConcurrency, detailCache,
    fetchImpl, hostGate, maxRetries, requestTimeoutMs, ctx,
  } = cfg;

  const gated = postings.filter((p) => titleGate(p?.name));
  const jobs = gated.map((p) => mapPosting(p, company));
  const errors = [];

  // A description already stored by an earlier run is just as accurate as
  // buying the same posting again. Hydrating first was the single largest cost
  // in discovery: ~3,700 of this adapter's ~3,800 requests per run were detail
  // reads, and at 4 in-flight against a ~500ms endpoint that is ~8 minutes of
  // wall clock spent re-reading postings already on disk. Workday has hydrated
  // from this cache for some time; this adapter never did.
  const reused = hydrateFromDetailCache(jobs, detailCache);

  // Only postings we still have no description for can consume budget. Nothing
  // is "unread" here: `maxDetailFetches: 0` is an explicit list-only choice,
  // and an empty `needDetail` means the cache already answered for every one.
  const needDetail = jobs.filter((j) => j.rawMetadata?.summaryOnly !== false);
  if (maxDetailFetches === 0 || needDetail.length === 0) return { jobs, errors, reused };

  // Best-first: an exact target-title match is enriched before a speculative
  // one, so a small budget buys the descriptions most likely to matter.
  const ordered = vocab
    ? sortByTitleFit(needDetail, (job) => job.title, vocab)
    : needDetail;
  const budgeted = ordered.slice(0, maxDetailFetches);
  const unread = ordered.length - budgeted.length;

  const failures = [];
  await mapWithConcurrency(budgeted, detailConcurrency, async (job) => {
    if (ctx.shouldCancel?.()) return null;
    const detailsUrl = job.rawMetadata?.detailsUrl;
    if (!detailsUrl) return null;
    // The host already asked us to slow down — a nice-to-have description is not
    // worth spending a retry budget against a server that is refusing us.
    if (hostGate?.isOpen?.(detailsUrl)) {
      job.rawMetadata.detailSkipped = 'host-throttled';
      return null;
    }
    try {
      const call = () => fetchJson(fetchImpl, detailsUrl, requestTimeoutMs);
      const data = await withRetry(
        () => (hostGate ? hostGate.run(detailsUrl, call) : call()),
        { maxRetries },
      );
      const text = smartRecruitersJdText(data);
      if (text) {
        job.jdText = text.slice(0, MAX_JD_CHARS);
        job.rawMetadata.summaryOnly = false;
        job.rawMetadata.detailFetched = true;
      }
    } catch (err) {
      job.rawMetadata.detailError = err.message;
      failures.push({ status: err.status ?? null });
    }
    return null;
  });

  // Counts are returned, not turned into notes here. One note per company would
  // mean up to one per configured board on every run — 123 near-identical rows
  // that bury whatever actually went wrong. The caller folds them into one.
  return { jobs, errors, unread, reused, failed: failures.length, statuses: failures.map((f) => f.status) };
}

async function fetchJson(fetchImpl, url, requestTimeoutMs) {
  // One deadline for headers AND body — see fetchJsonWithTimeout.
  return fetchJsonWithTimeout(fetchImpl, url, { headers: discoveryHeaders() }, requestTimeoutMs, 'SmartRecruiters');
}

/** Map one SmartRecruiters posting (list shape) to the normalized form. */
export function mapPosting(p, company) {
  const loc = p.location ?? {};
  const postingId = String(p.id ?? '').trim();
  const identifier = String(p.company?.identifier ?? company ?? '').trim();
  const locationLabel = [loc.city, loc.region, loc.country?.toUpperCase()]
    .filter(Boolean).join(', ');
  // SmartRecruiters states the country as an ISO-3166 alpha-2 code on every
  // posting. That is ground truth, and the US-only gate treats an explicit
  // country as decisive — far more reliable than trying to recognize a city
  // name, which is how offshore roles slipped through a filter that was on.
  const countryCode = String(loc.country ?? '').trim().toLowerCase();
  const jdBits = [
    p.name,
    p.typeOfEmployment?.label,
    p.experienceLevel?.label,
    p.function?.label,
    p.industry?.label,
    loc.remote ? 'Remote' : locationLabel,
  ].filter(Boolean);
  return normalizeJob({
    source: 'smartrecruiters',
    sourceJobId: String(p.id ?? p.refNumber ?? ''),
    company: p.company?.name ?? company,
    title: p.name ?? '',
    location: loc.remote ? (locationLabel ? `Remote — ${locationLabel}` : 'Remote') : locationLabel,
    // Without a posting id there is no per-posting page. Falling back to the
    // company URL would hand every such row the SAME link, which the dedup
    // stage reads as one job and collapses — losing all but one of them.
    url: postingId
      ? `https://jobs.smartrecruiters.com/${encodeURIComponent(identifier)}/${encodeURIComponent(postingId)}`
      : '',
    jdText: jdBits.join('. '),
    postedAt: p.releasedDate ?? null,
    employmentType: p.typeOfEmployment?.label ?? '',
    rawMetadata: {
      company,
      refNumber: p.refNumber ?? null,
      experienceLevel: p.experienceLevel?.label ?? null,
      ...(countryCode ? { country: countryCode } : {}),
      // jdText above is SYNTHESIZED from list metadata, not the employer's
      // description. Saying so is what routes the row to `needs_description`
      // instead of letting a ~150-character teaser be scored as if it were the
      // real posting and then discarded as a poor fit.
      summaryOnly: true,
      ...(postingId && identifier
        ? { detailsUrl: `https://${SMARTRECRUITERS_HOST}/v1/companies/${encodeURIComponent(identifier)}/postings/${encodeURIComponent(postingId)}` }
        : {}),
    },
  });
}
