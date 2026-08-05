/**
 * Cross-company ATS search — QUERY-FIRST discovery, no API key, no per-run cost.
 *
 * Every other discovery adapter in this codebase is COMPANY-FIRST: you name a
 * board (`greenhouse:databricks`, a Workday tenant) and it enumerates whatever
 * that one employer happens to be hiring for. That gives depth on a hand-curated
 * list and nothing outside it — measured against this candidate's target titles,
 * roughly 1-3% of what those adapters return is on-target, because they must
 * return the company's entire req list to find the few data roles in it.
 *
 * This adapter is the missing half: it asks an ATS vendor's own public job-search
 * endpoint "who, across ALL your customers, is hiring for this title right now?"
 * That is the capability the paid Apify actors were providing, and the reason a
 * $5 monthly cap could silently switch off the top of the funnel.
 *
 * Providers (each is the unauthenticated JSON endpoint the vendor's own public
 * job-search site calls to render its results — the same posture as the Workday
 * CXS feeds this codebase already reads):
 *
 *   workable         GET jobs.workable.com/api/v1/jobs?query=&location=
 *                    Real cursor pagination, and the FULL description ships
 *                    inline, so no per-job detail request is ever needed.
 *
 *   smartrecruiters  GET jobs.smartrecruiters.com/sr-jobs/search?keyword=
 *                    Returns the newest 100 matches; `offset` is accepted but
 *                    ignored by the server, so 100 per query is the real ceiling.
 *                    Results are newest-first, which is exactly the slice a
 *                    freshness-gated pipeline wants, so the cap costs us little.
 *                    Full descriptions come from an optional, budgeted detail
 *                    fetch against the documented public Posting API.
 *                    This endpoint also ignores EVERY country parameter that was
 *                    tried (`country`, `countryCode`, `countries`, `location`,
 *                    upper and lower case) — results were byte-identical with and
 *                    without them, and only 9 of 100 rows were US. Country is
 *                    therefore enforced client-side against `location.country`,
 *                    and no country param is sent, because sending one the server
 *                    discards would imply a filter that does not exist.
 *
 * Compliance posture:
 *   - Public, unauthenticated, vendor-published endpoints only. No login, no
 *     CAPTCHA solving, no bot-protection bypass, no browser impersonation. Every
 *     request carries the identifying User-Agent from httpClient.
 *   - robots.txt was checked for both hosts when this adapter was written:
 *     jobs.workable.com permits /api/ (it disallows only /search*?*, /profile*
 *     and company-login paths) and advertises `Content-Signal: search=yes,
 *     ai-input=yes`; jobs.smartrecruiters.com serves no robots directives.
 *     The optional SmartRecruiters detail fetch targets api.smartrecruiters.com,
 *     whose robots.txt is a blanket `Disallow: /` aimed at search-engine
 *     indexing — it is the officially documented public Posting API and this
 *     codebase already depends on it, but the enrichment is opt-OUT via
 *     `fetchDetails: false` for anyone who would rather not.
 *   - Failures are per-provider and per-query; nothing here can crash a run.
 *
 * REJECTED PROVIDERS (measured, not assumed — do not re-add without re-checking):
 *   himalayas.app/jobs/api   Honors ONLY `offset`. `search`, `q`, `keyword`,
 *                    `title`, `category`/`categories`, `skills` and
 *                    `parentCategories` are all accepted and silently ignored:
 *                    every one of them returned the same 20 rows and the same
 *                    totalCount of 96,651 (the entire worldwide index), led by
 *                    "Senior Underwriting Consultant". `limit` is pinned at 20
 *                    regardless of what is asked for. Covering that index for
 *                    US data roles would mean ~4,800 sequential requests per
 *                    run, so it cannot give coverage AND relevance. Its rows do
 *                    carry a useful employer `expiryDate`, which is the one
 *                    thing worth revisiting if they ever add a search param.
 *   remotive.com     robots.txt: `Disallow: /api/*`.
 *   remoteok.com     robots.txt: blanket `Disallow: /`.
 *   jobicy.com       robots.txt: blanket disallow plus `/api`.
 *   LinkedIn         No public, unauthenticated job-search API exists. The only
 *                    routes are login-gated or bot-protected, so reading it
 *                    would require exactly the evasion this file refuses. The
 *                    `linkedin` adapter therefore stays a URL-READER: it parses
 *                    posting URLs you paste and searches for nothing.
 *   iCIMS, Jobvite,
 *   SuccessFactors   Verified against live tenants: all three serve a JS
 *                    application shell to a plain fetch — Jobvite returns the
 *                    same 167KB SPA for every path (including a bogus
 *                    /api/v1/jobs), and none emit schema.org JobPosting JSON-LD
 *                    server-side. There is no public JSON feed to read. The
 *                    supported route for these is the `careers` adapter, which
 *                    takes a per-employer `careersUrl` or `sitemap` and reads
 *                    published posting pages.
 *
 * Relevance: both endpoints match query terms with OR semantics, so a bare
 * "data engineer" search returns anything containing "data" OR "engineer"
 * (44,506 US rows on SmartRecruiters, including Portuguese lab technicians).
 * Two things fix that: the query is phrase-quoted before it is sent (which took
 * that same search to 691 rows), and every result must clear a title gate built
 * from the candidate's own target titles before it is normalized.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout, httpError, discoveryHeaders } from '../../utils/httpClient.js';
import { normalizeText } from '../../utils/textNormalize.js';
import { usLocationSignal } from '../../utils/usGeography.js';

export const adapterId = 'atsSearch';

const WORKABLE_HOST = 'jobs.workable.com';
const SMARTRECRUITERS_SEARCH_HOST = 'jobs.smartrecruiters.com';
const SMARTRECRUITERS_API_HOST = 'api.smartrecruiters.com';

/** How many distinct title queries to run in parallel. */
const DEFAULT_QUERY_CONCURRENCY = 4;

/** Pages to walk per Workable query. 20 rows/page, ranked by RELEVANCE. */
const DEFAULT_MAX_PAGES = 5;

/**
 * Default freshness window for Workable, in days.
 *
 * Workable offers no sort parameter (see `runWorkable`), so this is the only
 * lever on recency — and widening it does not merely admit older postings, it
 * DISPLACES fresh ones: relevance ranking spends the fixed page budget on
 * whatever it considers most relevant, so a bigger corpus buries today's jobs
 * behind last quarter's. Measured over the real 17 target titles, 5 pages each:
 *
 *   dayRange | total | jobs <7d | median age
 *          1 |     4 |        4 |       1.4d   (Workable's index lags ~1d)
 *          3 |    86 |       86 |       2.5d
 *          7 |   145 |      137 |       3.2d   <- best fresh yield
 *         30 |   197 |       76 |      10.4d
 *        365 |   259 |       72 |      22.3d   (≈ unbounded)
 *
 * So 7 returns FEWER jobs than 30 but nearly twice as many recent ones. Raise
 * it via `options.dayRange` only when back-filling a new board list, where
 * breadth matters more than being early.
 */
const DEFAULT_WORKABLE_DAY_RANGE = 7;

/**
 * Hard ceiling on the age of any posting this adapter will return, in days.
 *
 * Distinct from `dayRange`, and they are not redundant: `dayRange` is what we
 * ASK Workable for (a server-side capability that also improves fresh yield),
 * while this is what we ACCEPT from any provider. SmartRecruiters offers no
 * date parameter at all, so this is the only defense there — see `makeAgeGate`.
 */
const DEFAULT_MAX_AGE_DAYS = 180;

/**
 * Per-query ceiling on optional SmartRecruiters full-JD fetches.
 *
 * Descriptions are an enrichment, not the job: a posting that keeps its
 * synthesized summary still scores and is still reviewable. Budgeting them
 * keeps one broad query from turning into hundreds of detail requests.
 */
const DEFAULT_MAX_DETAIL_FETCHES = 25;

/** Generic role tokens that count as a title match even when not configured. */
const ROLE_TOKEN_RE = /\b(data|analytics|bi|business intelligence|etl|elt|warehouse|platform)\b[\w\s/-]*\b(engineer|developer|architect|analyst)\b|\bdata engineer(ing)?\b/i;

/**
 * Build the predicate that decides whether a search hit is worth keeping.
 *
 * Both vendors OR-match query terms, so this is the difference between feeding
 * the pipeline a few hundred on-target roles and feeding it tens of thousands of
 * unrelated ones. It is deliberately a TITLE gate and nothing more — location,
 * seniority, sponsorship and scoring all have their own stages downstream, and
 * duplicating their judgment here would hide jobs from them.
 *
 * @param {object} options
 * @param {string[]} [options.titles] candidate target titles
 * @param {boolean} [options.strict=true] when false, keep everything
 * @returns {(title: string) => boolean}
 */
export function makeTitleGate({ titles = [], strict = true } = {}) {
  if (!strict) return () => true;
  const needles = titles
    .map((t) => normalizeText(t))
    .filter((t) => t.length > 0);
  return (title) => {
    const t = String(title ?? '');
    if (!t.trim()) return false;
    if (ROLE_TOKEN_RE.test(t)) return true;
    const n = normalizeText(t);
    return needles.some((needle) => n.includes(needle));
  };
}

/**
 * Build the predicate that keeps a SmartRecruiters hit only if it is in the
 * wanted country.
 *
 * This exists because the search endpoint accepts and then silently discards
 * every country parameter (verified: identical payloads with and without, and
 * only 9 of 100 rows were US). Relying on the server's filter would have quietly
 * flooded the pipeline with roles on other continents.
 *
 * A row with no country at all is KEPT: the field is occasionally absent on
 * remote postings, and dropping an unlabelled job is a worse error than letting
 * the geography exclusion stage — which is designed for exactly this — judge it.
 *
 * @param {string} country ISO-3166 alpha-2, or '' to disable the gate
 * @returns {(location: object) => boolean}
 */
/**
 * Reject postings older than `maxAgeDays`.
 *
 * A cross-company search index is not a live board: nothing forces an employer
 * to close a requisition, so dead ones accumulate forever and still match on
 * title. On the real target titles, 89% of SmartRecruiters rows were over a
 * year old and the oldest was from 2014. They score like real jobs and would
 * consume a tailored resume and an application each.
 *
 * The default of 180 days is deliberately loose — it is a zombie guard, not a
 * freshness filter. Genuine requisitions routinely stay open for months, and
 * deciding what counts as "recent" belongs to the pipeline's freshness stage,
 * which can see every source at once. This only refuses the indefensible.
 *
 * A row with no date is KEPT, for the same reason the country gate keeps
 * unlabelled locations: absence of evidence is not evidence of staleness, and
 * the undated-review bucket exists to triage exactly these.
 *
 * @param {number} [maxAgeDays] days, or 0/Infinity to disable the gate
 * @returns {(value: string|null) => boolean}
 */
export function makeAgeGate(maxAgeDays) {
  // Any real number is honored, so 0 and Infinity can both mean "no ceiling".
  // Only a missing or non-numeric value falls back to the default.
  const days = typeof maxAgeDays === 'number' && !Number.isNaN(maxAgeDays)
    ? maxAgeDays
    : DEFAULT_MAX_AGE_DAYS;
  if (!(days > 0) || !Number.isFinite(days)) return () => true;
  const floor = Date.now() - days * 86_400_000;
  return (value) => {
    if (!value) return true;
    const t = Date.parse(value);
    return Number.isNaN(t) ? true : t >= floor;
  };
}

export function makeCountryGate(country) {
  const want = String(country ?? '').trim().toLowerCase();
  if (!want) return () => true;
  return (location) => {
    const got = String(location?.country ?? '').trim().toLowerCase();
    return got === '' || got === want;
  };
}

/** Placeholder "cities" that carry no geography and must not be shown as one. */
const PLACEHOLDER_LOCATION_RE = /^(telecommute|remote|anywhere|anywhere in the world|virtual|home based|work from home|n\/?a|various|multiple locations|worldwide|global|global remote|remote worldwide)$/i;

/**
 * Phrase-quote a query so the vendor matches the whole phrase, not each token.
 * Already-quoted input is left alone; a single word gains nothing from quoting.
 *
 * @param {string} query
 * @returns {string}
 */
export function phraseQuote(query) {
  const q = String(query ?? '').trim();
  if (!q) return '';
  if (q.startsWith('"') && q.endsWith('"')) return q;
  return /\s/.test(q) ? `"${q}"` : q;
}

/**
 * @param {object} source jobboards source entry
 * @param {object} source.options
 * @param {string[]} [source.options.providers=['workable','smartrecruiters']]
 * @param {string[]} [source.options.queries] overrides candidate.targetTitles
 * @param {string}   [source.options.location='United States'] Workable location
 * @param {string}   [source.options.country='us'] SmartRecruiters country code
 * @param {number}   [source.options.maxPages] Workable pages per query
 * @param {number}   [source.options.maxDetailFetches] SR full-JD budget per query
 * @param {boolean}  [source.options.fetchDetails=true] SR full-JD enrichment
 * @param {boolean}  [source.options.strictTitleMatch=true]
 * @param {object} ctx adapter context
 * @returns {Promise<{ jobs: object[], errors: object[], cancelled: boolean }>}
 */
export async function run(source = {}, ctx = {}) {
  const options = source.options ?? {};
  const providers = Array.isArray(options.providers) && options.providers.length
    ? options.providers
    : ['workable', 'smartrecruiters'];

  // Queries default to the candidate's own target titles so the title list lives
  // in exactly one place (config/candidate.json) instead of being duplicated —
  // and drifting — inside the board config.
  const queries = resolveQueries(options, ctx);
  const jobs = [];
  const errors = [];
  let cancelled = false;

  if (queries.length === 0) {
    errors.push({
      error: 'atsSearch is enabled but has no queries. Add `options.queries`, or set '
        + '`targetTitles` in config/candidate.json (the default source of queries).',
    });
    return { jobs, errors, cancelled };
  }

  const titleGate = makeTitleGate({
    titles: options.queries ?? ctx.candidate?.targetTitles ?? [],
    strict: options.strictTitleMatch !== false,
  });

  // One work item per (provider, query) pair, all independent.
  const tasks = [];
  for (const provider of providers) {
    for (const query of queries) tasks.push({ provider, query });
  }

  const concurrency = ctx.queryConcurrency ?? options.queryConcurrency ?? DEFAULT_QUERY_CONCURRENCY;
  const results = await mapWithConcurrency(tasks, concurrency, async ({ provider, query }) => {
    if (ctx.shouldCancel?.()) { cancelled = true; return null; }
    const runner = PROVIDERS[provider];
    if (!runner) {
      return { jobs: [], error: { provider, error: `Unknown atsSearch provider: ${provider}` } };
    }
    try {
      const found = await runner({ query, source, options, ctx, titleGate });
      return { jobs: found, error: null };
    } catch (err) {
      return {
        jobs: [],
        error: {
          provider, query, error: err.message,
          status: err.status ?? null, attempts: err.attempts ?? 0,
        },
      };
    }
  });

  for (const r of results) {
    if (!r) continue;
    jobs.push(...r.jobs);
    if (r.error) errors.push(r.error);
  }
  return { jobs, errors, cancelled };
}

/** Queries come from explicit config, else the candidate's target titles. */
function resolveQueries(options, ctx) {
  const explicit = Array.isArray(options.queries) ? options.queries : null;
  const fromCandidate = Array.isArray(ctx.candidate?.targetTitles) ? ctx.candidate.targetTitles : [];
  const list = explicit ?? fromCandidate;
  const seen = new Set();
  const out = [];
  for (const q of list) {
    const trimmed = String(q ?? '').trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  const max = Number.isFinite(options.maxQueries) ? Math.max(0, options.maxQueries) : out.length;
  return out.slice(0, max);
}

/* ------------------------------------------------------------------ *
 * Provider: Workable
 * ------------------------------------------------------------------ */

/**
 * Search every Workable-hosted board for one title.
 *
 * Workable is the better-behaved of the two providers: it paginates properly via
 * an opaque `nextPageToken`, and each row already carries the full description,
 * requirements and benefits — so a complete, scoreable job comes out of the
 * search response with no follow-up request at all.
 *
 * `day_range` is not optional in practice. Workable ranks by RELEVANCE and
 * accepts no sort parameter (`sort`, `sort_by`, `sortBy` were each probed and
 * each left the order unchanged), so an unbounded search returns postings up to
 * 192 days old interleaved with today's. Measured max age by `day_range`:
 * unset 192d, 30 → 25d, 7 → 7.8d, 3 → 3.5d, 1 → 1.4d. It composes with
 * pagination, so it narrows the corpus rather than just truncating page one.
 *
 * SmartRecruiters needs no equivalent: it already returns newest-first (a
 * default 100-row page measured 1.2d–10.7d, median 4.3d).
 */
async function runWorkable({ query, source, options, ctx, titleGate }) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const location = options.location ?? 'United States';
  const dayRange = Number.isFinite(options.dayRange)
    ? Math.max(1, Math.trunc(options.dayRange))
    : DEFAULT_WORKABLE_DAY_RANGE;
  const ageGate = makeAgeGate(options.maxAgeDays);
  const maxPages = Number.isFinite(options.maxPages) ? Math.max(1, options.maxPages) : DEFAULT_MAX_PAGES;
  const jobs = [];
  let pageToken = null;

  for (let page = 0; page < maxPages; page += 1) {
    if (ctx.shouldCancel?.()) break;
    if (rateLimiter) await rateLimiter.wait(`atsSearch:${WORKABLE_HOST}`, source.rateLimitMs);

    const url = new URL(`https://${WORKABLE_HOST}/api/v1/jobs`);
    url.searchParams.set('query', phraseQuote(query));
    if (location) url.searchParams.set('location', location);
    url.searchParams.set('day_range', String(dayRange));
    // Verified live: `pageToken` advances the cursor (18 of 20 rows new on
    // page 2); the snake_case spelling is ignored and refetches page one.
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const href = url.href;
    const call = () => fetchJson(fetchImpl, href, 'Workable search', requestTimeoutMs);
    const data = await withRetry(
      () => (hostGate ? hostGate.run(href, call) : call()),
      { maxRetries },
    );

    const rows = Array.isArray(data.jobs) ? data.jobs : [];
    for (const row of rows) {
      if (!titleGate(row.title)) continue;
      // Belt and braces: `day_range` already bounds this server-side, but the
      // gate keeps the adapter's contract identical across both providers.
      if (!ageGate(row.created ?? row.updated)) continue;
      const job = mapWorkableJob(row, query);
      if (job) jobs.push(job);
    }

    pageToken = data.nextPageToken ?? null;
    if (!pageToken || rows.length === 0) break;
  }
  return jobs;
}

/**
 * Map one Workable search row to the normalized shape.
 *
 * `requirementsSection` is appended to the description because it routinely
 * holds the entire skills list — dropping it would strip exactly the keywords
 * the scorer matches on.
 *
 * @param {object} row raw Workable search row
 * @param {string} [query] the query that surfaced it (provenance only)
 * @returns {object|null}
 */
export function mapWorkableJob(row, query = '') {
  if (!row || typeof row !== 'object') return null;
  const title = String(row.title ?? '').trim();
  const url = String(row.url ?? '').trim();
  if (!title && !url) return null;

  const body = [row.description, row.requirementsSection]
    .filter((s) => typeof s === 'string' && s.trim())
    .join('\n\n');

  return normalizeJob({
    source: 'atsSearch',
    sourceJobId: String(row.id ?? ''),
    company: row.company?.title ?? row.company?.name ?? '',
    title,
    location: formatWorkableLocation(row),
    url,
    jdText: htmlToText(body).slice(0, 20000),
    postedAt: row.created ?? row.updated ?? null,
    employmentType: row.employmentType ?? '',
    rawMetadata: {
      provider: 'workable',
      ats: 'workable',
      query,
      workplace: row.workplace ?? null,
      companyUrl: row.company?.url ?? null,
    },
  });
}

/** "Remote — Austin, Texas, United States" / "Austin, Texas, United States". */
function formatWorkableLocation(row) {
  const listed = Array.isArray(row.locations)
    ? row.locations.filter((l) => typeof l === 'string' && l.trim() && !PLACEHOLDER_LOCATION_RE.test(l.trim()))
    : [];
  const loc = row.location ?? {};
  const composed = [loc.city, loc.subregion ?? loc.region, loc.countryName]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p && !PLACEHOLDER_LOCATION_RE.test(p))
    .join(', ');
  const label = listed[0] || composed;
  // `workplace` is the authoritative remote signal; the location string is often
  // still a city even for a fully remote role.
  if (row.workplace === 'remote') return label ? `Remote — ${label}` : 'Remote';
  if (row.workplace === 'hybrid' && label) return `Hybrid — ${label}`;
  return label;
}

/* ------------------------------------------------------------------ *
 * Provider: SmartRecruiters
 * ------------------------------------------------------------------ */

/**
 * Search every SmartRecruiters-hosted board for one title.
 *
 * The server accepts `offset`/`page`/`limit` and ignores all three — every
 * request returns the same newest 100 matches. Rather than pretend to paginate,
 * this takes the 100 and relies on the caller running many narrow title queries.
 *
 * Newest-first is NOT the same as fresh. For a high-volume title the 100 newest
 * really are recent ("Data Engineer" measured 1.2d–10.7d), but for a niche one
 * the index has no recent supply and returns whatever it has — measured across
 * the real 17 target titles, 227 of 254 rows were over a YEAR old and the oldest
 * was from 2014. Those are requisitions nobody ever closed, and they are
 * indistinguishable from live ones by title alone, so the age gate below is
 * what stops them entering the pipeline as plausible-looking work.
 */
async function runSmartRecruitersSearch({ query, source, options, ctx, titleGate }) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const countryGate = makeCountryGate(options.country ?? 'us');
  const ageGate = makeAgeGate(options.maxAgeDays);

  if (rateLimiter) await rateLimiter.wait(`atsSearch:${SMARTRECRUITERS_SEARCH_HOST}`, source.rateLimitMs);

  const url = new URL(`https://${SMARTRECRUITERS_SEARCH_HOST}/sr-jobs/search`);
  url.searchParams.set('keyword', phraseQuote(query));

  const href = url.href;
  const call = () => fetchJson(fetchImpl, href, 'SmartRecruiters search', requestTimeoutMs);
  const data = await withRetry(
    () => (hostGate ? hostGate.run(href, call) : call()),
    { maxRetries },
  );

  const rows = Array.isArray(data.content) ? data.content : [];
  const jobs = [];
  for (const row of rows) {
    if (!titleGate(row.name)) continue;
    if (!countryGate(row.location)) continue;
    if (!ageGate(row.releasedDate)) continue;
    const job = mapSmartRecruitersHit(row, query);
    if (job) jobs.push(job);
  }

  // Optional full-JD enrichment. The search row carries no description at all,
  // so without this these jobs reach the scorer with title+location only.
  if (options.fetchDetails !== false) {
    await enrichSmartRecruiters(jobs, { source, options, ctx });
  }
  return jobs;
}

/**
 * Fetch full descriptions for SmartRecruiters hits, within budget.
 *
 * Mirrors the Workday enrichment contract deliberately: a failure downgrades one
 * job to `summaryOnly` and is otherwise silent, because a job with a thin
 * description is still a job and must not be lost or turned into noise.
 */
async function enrichSmartRecruiters(jobs, { source, options, ctx }) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const budget = Number.isFinite(options.maxDetailFetches)
    ? Math.max(0, options.maxDetailFetches)
    : DEFAULT_MAX_DETAIL_FETCHES;
  const concurrency = ctx.detailConcurrency ?? 4;
  const targets = jobs.filter((j) => j.rawMetadata?.detailsUrl).slice(0, budget);

  await mapWithConcurrency(targets, concurrency, async (job) => {
    if (ctx.shouldCancel?.()) return null;
    const detailsUrl = job.rawMetadata.detailsUrl;
    // The host already asked us to slow down — a nice-to-have description is not
    // worth spending a retry budget against a server that is refusing us.
    if (hostGate?.isOpen(detailsUrl)) {
      job.rawMetadata.detailSkipped = 'host-throttled';
      return null;
    }
    try {
      if (rateLimiter) await rateLimiter.wait(`atsSearch:${SMARTRECRUITERS_API_HOST}`, source.rateLimitMs);
      const call = () => fetchJson(fetchImpl, detailsUrl, 'SmartRecruiters posting', requestTimeoutMs);
      const data = await withRetry(
        () => (hostGate ? hostGate.run(detailsUrl, call) : call()),
        { maxRetries },
      );
      const text = smartRecruitersJdText(data);
      if (text) {
        job.jdText = text.slice(0, 20000);
        job.rawMetadata.summaryOnly = false;
        job.rawMetadata.detailFetched = true;
      }
    } catch (err) {
      job.rawMetadata.summaryOnly = true;
      job.rawMetadata.detailError = err.message;
    }
    return null;
  });
}

/**
 * Flatten a SmartRecruiters posting's jobAd sections into plain text.
 * @param {object} data posting detail payload
 * @returns {string}
 */
export function smartRecruitersJdText(data) {
  const sections = data?.jobAd?.sections ?? {};
  const order = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'];
  const parts = [];
  for (const key of order) {
    const raw = sections[key]?.text;
    if (typeof raw === 'string' && raw.trim()) parts.push(raw);
  }
  return htmlToText(parts.join('\n\n'));
}

/**
 * Map one SmartRecruiters search hit to the normalized shape.
 *
 * The search row has no description, so jdText is synthesized from the metadata
 * that IS present and `summaryOnly` is set — the same honest contract the
 * Workday adapter uses when a detail fetch is unavailable.
 *
 * @param {object} row raw search hit
 * @param {string} [query] provenance
 * @returns {object|null}
 */
export function mapSmartRecruitersHit(row, query = '') {
  if (!row || typeof row !== 'object') return null;
  const title = String(row.name ?? '').trim();
  const url = String(row.applyUrl ?? '').trim();
  if (!title && !url) return null;

  const loc = row.location ?? {};
  // Some boards put a placeholder like "TELECOMMUTE" in the city field, which
  // rendered as the nonsense label "Remote — TELECOMMUTE" and gave the
  // geography rules a fake city to reason about. Drop those before composing.
  const city = PLACEHOLDER_LOCATION_RE.test(String(loc.city ?? '').trim()) ? '' : loc.city;
  const label = [city, loc.region, loc.country ? String(loc.country).toUpperCase() : '']
    .filter(Boolean)
    .join(', ');
  const location = loc.remote
    ? (label ? `Remote — ${label}` : 'Remote')
    : (loc.hybrid && label ? `Hybrid — ${label}` : label);

  return normalizeJob({
    source: 'atsSearch',
    sourceJobId: String(row.id ?? ''),
    company: row.company?.name ?? row.company?.identifier ?? '',
    title,
    location,
    url,
    jdText: [title, location, row.typeOfEmployment?.label, row.function?.label, row.industry?.label]
      .filter(Boolean).join('. '),
    postedAt: row.releasedDate ?? null,
    employmentType: row.typeOfEmployment?.label ?? '',
    rawMetadata: {
      provider: 'smartrecruiters',
      ats: 'smartrecruiters',
      query,
      // The company slug is the payload's most valuable by-product: it is a
      // ready-to-use board id for the company-first SmartRecruiters adapter, and
      // scripts/harvestSources.mjs turns it into permanent configured coverage.
      companyIdentifier: row.company?.identifier ?? null,
      detailsUrl: row.actions?.details ?? null,
      summaryOnly: true,
    },
  });
}

/**
 * Keep a posting whose free-text location is US-resolvable, or carries no
 * geography at all.
 *
 * For the providers that expose no country parameter (Himalayas indexes the whole
 * world; The Muse filters only by its own category/location vocabulary), the
 * country decision has to be made here. It deliberately does NOT do its own
 * string matching against country names: `usLocationSignal` is this codebase's
 * single source of truth for reading a location, it already distinguishes a
 * spelled-out state from a bare two-letter code, and a second, weaker
 * implementation living here is exactly how two halves of a filter come to
 * disagree.
 *
 * Three outcomes, following the same "absence of evidence is not evidence" rule
 * as the country and age gates above:
 *   - no location at all            -> KEEP (the exclusion stage judges it)
 *   - a placeholder like "Remote" /
 *     "Worldwide" / "Anywhere"      -> KEEP (borderless, so open to the US)
 *   - resolves to a real place      -> keep only if that place is in the US
 *
 * Multi-location strings are split, and any US part keeps the row: a req open in
 * "London; Austin, TX" is a US opening.
 *
 * @param {boolean} [enabled=true] pass false to disable the gate entirely
 * @returns {(value: string) => boolean}
 */
export function makeUsLocationGate(enabled = true) {
  if (enabled === false) return () => true;
  return (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return true;
    const parts = raw.split(/[;|/]|\band\b/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return true;
    let sawPlaceable = false;
    for (const part of parts) {
      // A geography-free label is not a foreign location — it is no location.
      if (PLACEHOLDER_LOCATION_RE.test(part)) return true;
      if (usLocationSignal(part).isUs) return true;
      sawPlaceable = true;
    }
    return !sawPlaceable;
  };
}

/* ------------------------------------------------------------------ *
 * Provider: The Muse
 * ------------------------------------------------------------------ */

/**
 * Search The Muse's documented public jobs API for one title.
 *
 *   GET www.themuse.com/api/public/jobs?page=&category=&location=
 *
 * Complements Himalayas rather than duplicating it: The Muse indexes large,
 * mostly US-based employers (SpaceX, Nike, banks) whose reqs are hosted on ATSes
 * this codebase has no per-company entry for, and every row ships the full
 * `contents` HTML plus a real `publication_date`.
 *
 * The API has no free-text search parameter — it filters by `category` and
 * `location` and returns newest-first pages. The title gate is therefore doing
 * the relevance work here, which is why `category` defaults to the data/analytics
 * families rather than being left open.
 *
 * Like Himalayas, `refs.landing_page` is a themuse.com URL, so rows are tagged
 * `aggregator: true`. Note the API exposes no direct employer link at all: the
 * only apply path it offers is `/job/redirect/*`, which the site's robots.txt
 * disallows, so it is deliberately NOT requested.
 *
 * robots.txt (checked when this was written): the only `/api` rule is
 * `Disallow: /api/users*`; `/api/public/jobs` is not restricted.
 */
const THEMUSE_HOST = 'www.themuse.com';

/** Muse categories that map to this candidate's field. */
const DEFAULT_THEMUSE_CATEGORIES = Object.freeze([
  'Data and Analytics', 'Data Science', 'Software Engineering', 'IT',
]);

/** Muse pages to walk per category. 20 rows/page, newest first. */
const DEFAULT_THEMUSE_MAX_PAGES = 3;

/**
 * The Muse ignores the query text, so running it once per target title would
 * re-fetch identical pages N times. It runs on the FIRST query only and covers
 * its breadth through categories and pages instead; the title gate still applies
 * the candidate's full title list to every row.
 */
async function runTheMuse({ query, source, options, ctx, titleGate }) {
  if (!isFirstQuery(query, options, ctx)) return [];

  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const ageGate = makeAgeGate(options.maxAgeDays);
  const locationGate = makeUsLocationGate(options.usOnly);
  const categories = Array.isArray(options.museCategories) && options.museCategories.length
    ? options.museCategories
    : DEFAULT_THEMUSE_CATEGORIES;
  const maxPages = Number.isFinite(options.museMaxPages)
    ? Math.max(1, options.museMaxPages)
    : DEFAULT_THEMUSE_MAX_PAGES;

  const jobs = [];
  const seen = new Set();
  for (const category of categories) {
    for (let page = 1; page <= maxPages; page += 1) {
      if (ctx.shouldCancel?.()) return jobs;
      if (rateLimiter) await rateLimiter.wait(`atsSearch:${THEMUSE_HOST}`, source.rateLimitMs);
      const url = new URL(`https://${THEMUSE_HOST}/api/public/jobs`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('category', category);
      const href = url.href;
      const call = () => fetchJson(fetchImpl, href, 'The Muse search', requestTimeoutMs);
      const data = await withRetry(
        () => (hostGate ? hostGate.run(href, call) : call()),
        { maxRetries },
      );
      const rows = Array.isArray(data?.results) ? data.results : [];
      if (rows.length === 0) break;
      for (const row of rows) {
        if (!titleGate(row?.name)) continue;
        if (!ageGate(row?.publication_date ?? null)) continue;
        const locations = museLocations(row);
        if (!locationGate(locations)) continue;
        const id = String(row?.id ?? '');
        // The same req appears under several categories; keep the first.
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        jobs.push(mapTheMuseHit(row, { query, locations, category }));
      }
    }
  }
  return jobs;
}

/**
 * True when `query` is the first of the resolved query list.
 *
 * A provider whose endpoint takes no search term must not run once per title —
 * that would issue the same requests N times for one set of results.
 */
function isFirstQuery(query, options, ctx) {
  const queries = resolveQueries(options, ctx);
  return queries.length === 0 || queries[0] === query;
}

/** Join a Muse row's locations into one display string. */
export function museLocations(row) {
  const list = Array.isArray(row?.locations) ? row.locations : [];
  return list.map((l) => String(l?.name ?? '').trim()).filter(Boolean).join('; ');
}

function mapTheMuseHit(row, { query, locations, category }) {
  const levels = Array.isArray(row?.levels)
    ? row.levels.map((l) => String(l?.name ?? '').trim()).filter(Boolean)
    : [];
  return normalizeJob({
    source: 'themuse',
    sourceJobId: String(row?.id ?? ''),
    company: row?.company?.name ?? '',
    title: row?.name ?? '',
    location: locations,
    url: row?.refs?.landing_page ?? '',
    jdText: htmlToText(String(row?.contents ?? '')).slice(0, 20000),
    postedAt: row?.publication_date ?? null,
    employmentType: String(row?.type ?? ''),
    rawMetadata: {
      provider: 'themuse',
      query,
      // themuse.com hosts the landing page; the employer's own form is behind a
      // redirect their robots.txt disallows, so this is an aggregator row.
      aggregator: true,
      category,
      levels,
      companySlug: row?.company?.short_name ?? null,
    },
  });
}

/** provider id -> runner. */
const PROVIDERS = {
  workable: runWorkable,
  smartrecruiters: runSmartRecruitersSearch,
  themuse: runTheMuse,
};

/** Exported so tests can assert the supported provider set. */
export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

async function fetchJson(fetchImpl, url, label, requestTimeoutMs) {
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    { headers: discoveryHeaders({ Accept: 'application/json' }) },
    requestTimeoutMs,
  );
  if (!res.ok) throw httpError(res, label, url);
  return res.json();
}
