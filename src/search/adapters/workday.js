/**
 * Workday connector — uses the PUBLIC Workday CXS jobs endpoint that a tenant's
 * own public career site calls to render its job list:
 *
 *   POST https://{host}/wday/cxs/{tenant}/{site}/jobs
 *   body: { "limit": <pageSize>, "offset": <n>, "searchText": "", "appliedFacets": {} }
 *
 * This is the same unauthenticated JSON a public career page loads. This adapter
 * does NOT log in, solve CAPTCHAs, bypass bot protection, or hit private/internal
 * endpoints. It only runs for tenants/sites the user explicitly configures.
 *
 * Config (per entry in source.tenants[]):
 *   { host, tenant, site, locale?, pageSize?, searchText?, fetchDetails? }
 *     host     e.g. "company.wd1.myworkdayjobs.com"
 *     tenant   e.g. "company"
 *     site     e.g. "External" (the public site name)
 *     locale   optional, used only to build the human job URL (e.g. "en-US")
 *     pageSize optional, default 20
 *     searchText optional server-side query string (Workday's own search box)
 *     fetchDetails optional (default true) — when true, the adapter also GETs the
 *                  PUBLIC per-job CXS detail endpoint to enrich the summary with
 *                  the full job description. If a detail fetch is unavailable
 *                  (404/403/429/etc.), the job keeps rawMetadata.summaryOnly=true
 *                  and the reason is reported. Detail fetch is public-only — no
 *                  login, CAPTCHA, private endpoint, or bot-protection bypass.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchJsonWithTimeout } from '../../utils/httpClient.js';
import { createHostGate } from '../../utils/hostGate.js';
import { profileVocabularyFor, titleFitPriority } from '../../scoring/profileFit.js';
import { hydrateFromDetailCache } from '../detailBudget.js';

export const adapterId = 'workday';

/** Hard cap on pagination to avoid runaway loops on misconfigured tenants. */
const MAX_PAGES = 50;

/**
 * Optional per-term page cap — the one knob that trades COVERAGE for speed.
 *
 * Defaults to `MAX_PAGES`, i.e. no behaviour change. It exists because after the
 * pod gate was retuned, the remaining run time is genuine volume: a fuzzy
 * `searchText` matches far more than it should (Citi returns 927 hits for "data
 * engineer", of which ~90 are on-target), and every 20 of them is a request.
 *
 * Lowering it is NOT free. Measured cumulative on-target recall against pages
 * fetched, over the four largest configured tenants:
 *
 *   cap  3 pages (60 jobs)   ->  39.8% of on-target jobs recovered
 *   cap  5 pages (100 jobs)  ->  50.4%
 *   cap  8 pages (160 jobs)  ->  64.8%
 *   cap 12 pages (240 jobs)  ->  71.1%
 *   cap 25 pages (500 jobs)  -> 100%
 *
 * Results are only WEAKLY relevance-ordered, and unevenly so: Citi recovers 50%
 * in three pages while Genpact recovers 5%, its on-target roles spread through
 * the whole list. So a low cap silently drops real matches, which is why this
 * defaults to off and is left as a deliberate, documented choice rather than a
 * default someone would never notice.
 */
const DEFAULT_MAX_PAGES_PER_TERM = MAX_PAGES;

/** Optional full-JD enrichment budget per tenant. Summaries remain usable. */
const DEFAULT_MAX_DETAIL_FETCHES = 20;

/** Default number of tenants fetched in parallel. */
const DEFAULT_TENANT_CONCURRENCY = 6;

/** Default number of list pages fetched in parallel per tenant. */
const DEFAULT_PAGE_CONCURRENCY = 4;

/**
 * How many distinct search phrases to run against each tenant.
 *
 * Every extra term multiplies the tenant's page cost, so this is deliberately
 * small — see `deriveSearchTerms` for why two is enough.
 */
const DEFAULT_MAX_SEARCH_TERMS = 2;

/** Level/seniority words: they never change WHICH role a title refers to. */
const SENIORITY_TOKENS = new Set([
  'senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'mid', 'level',
  'associate', 'entry', 'i', 'ii', 'iii', 'iv', 'v', 'vp', 'head',
]);

/** Words that carry no search signal. */
const STOP_TOKENS = new Set(['the', 'of', 'and', 'an', 'for', 'to', 'in', 'with', 'at', 'on']);

/**
 * Significant, lowercased tokens of a job title.
 * @param {string} title
 * @returns {string[]}
 */
function titleTokens(title) {
  return String(title ?? '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length > 1 && !STOP_TOKENS.has(t) && !SENIORITY_TOKENS.has(t));
}

/** Do two token sets share at least one member? */
function overlaps(a, b) {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

/** Role-shaped titles worth a full description even when off the exact list. */
const ROLE_SHAPED_RE = /\b(data|analytics|bi|business intelligence|etl|elt|warehouse|lakehouse|platform)\b[\w\s/&-]*\b(engineer|developer|architect|analyst)\b/i;

/**
 * How much a job deserves one of the tenant's few full-description fetches.
 *
 * A tenant commonly returns 100-200 postings while the budget is a handful, so
 * WHICH ones get enriched decides whether the budget is useful at all. Ranking:
 *
 *   2  the title contains one of the candidate's own target titles
 *   1  the title is role-shaped ("Senior Data Platform Engineer") but not an
 *      exact target-title match
 *   0  everything else
 *
 * Ties keep the tenant's original list order (Array#sort is stable), so the
 * result stays deterministic — the same tenant always enriches the same jobs.
 *
 * @param {object} job normalized job
 * @param {string[]} targetTitles candidate.targetTitles
 * @returns {0|1|2}
 */
function detailPriority(job, targetTitles = [], vocab = null) {
  const title = String(job?.title ?? '');
  if (!title) return 0;
  // Profile-driven when a profile is available. The old substring-and-regex
  // ranking recognized far less than the profile actually implies — it scored
  // "Databricks Senior Architect" and "Senior Engineer, Business Intelligence"
  // at 0, i.e. last in line for the budget, so on this corpus 2,541 Workday
  // postings whose titles clearly fit were never read at all and were then
  // reported as poor fits on the strength of a location string.
  if (vocab) return titleFitPriority(title, vocab);
  const lower = title.toLowerCase();
  for (const want of targetTitles) {
    const w = String(want ?? '').trim().toLowerCase();
    if (w && lower.includes(w)) return 2;
  }
  return ROLE_SHAPED_RE.test(title) ? 1 : 0;
}

/**
 * Choose the search phrases to send this tenant, derived from the candidate's
 * own target titles rather than a hardcoded string.
 *
 * Two measured facts about Workday's public CXS search drive the design:
 *
 *  1. It NARROWS as tokens are added — it is fuzzy-AND, not OR. On one tenant:
 *     "data" 115 hits, "engineer" 57, "data engineer" 51, "data engineer bi" 27,
 *     "data engineer bi developer analytics" 13, and a nine-word query 0. So a
 *     long "cover everything" phrase is the worst possible query, and each term
 *     is kept to the trailing two significant tokens of a title.
 *  2. It is fuzzy enough that one phrase already reaches sibling titles:
 *     "data engineer" surfaced "Senior Business Intelligence Engineer". Measured
 *     across 12 configured tenants, that single phrase recovered every on-target
 *     title except three — two "ETL Developer" roles and one "Quantitative
 *     Analytics Engineer" — all of which share the token `developer`/`analytics`
 *     rather than `data`/`engineer`.
 *
 * So the job is a small set cover: pick the fewest phrases such that every
 * target title shares a token with at least one of them. For the 17 real target
 * titles this yields ["data engineer", "bi developer"] — the first covering the
 * 12 data/engineer titles, the second the five developer-suffixed ones that the
 * old hardcoded string missed entirely.
 *
 * @param {string[]} titles candidate.targetTitles
 * @param {number} [maxTerms]
 * @returns {string[]} search phrases, most valuable first
 */
export function deriveSearchTerms(titles, maxTerms = DEFAULT_MAX_SEARCH_TERMS) {
  const cap = Number.isFinite(maxTerms) ? Math.max(0, Math.trunc(maxTerms)) : DEFAULT_MAX_SEARCH_TERMS;
  if (cap === 0) return [];

  const entries = [];
  for (const raw of Array.isArray(titles) ? titles : []) {
    const tokens = titleTokens(raw);
    if (tokens.length) entries.push({ tokens, set: new Set(tokens) });
  }
  if (!entries.length) return [];

  // How central each token is across the whole title list — used only to break
  // ties, so the chosen phrase is the one most representative of the profile.
  const freq = new Map();
  for (const e of entries) for (const t of e.set) freq.set(t, (freq.get(t) ?? 0) + 1);

  const candidates = [];
  const seen = new Set();
  for (const e of entries) {
    const tail = e.tokens.slice(-2);
    const term = tail.join(' ');
    if (seen.has(term)) continue;
    seen.add(term);
    candidates.push({
      term,
      set: new Set(tail),
      weight: tail.reduce((s, t) => s + (freq.get(t) ?? 0), 0),
    });
  }

  const uncovered = new Set(entries.keys());
  const chosen = [];
  while (chosen.length < cap && uncovered.size) {
    let best = null;
    for (const c of candidates) {
      if (chosen.includes(c.term)) continue;
      let n = 0;
      for (const i of uncovered) if (overlaps(c.set, entries[i].set)) n += 1;
      if (n === 0) continue;
      if (!best || n > best.n || (n === best.n && c.weight > best.c.weight)) best = { c, n };
    }
    if (!best) break;
    chosen.push(best.c.term);
    for (const i of [...uncovered]) if (overlaps(best.c.set, entries[i].set)) uncovered.delete(i);
  }
  return chosen;
}

/**
 * The search phrases to use for a candidate, preferring the profile's own.
 *
 * `deriveSearchTerms` below is the fallback: a token set-cover over the literal
 * target titles, which picks the TRAILING two tokens of each. That is right for
 * "Senior Data Engineer" -> "data engineer" and wrong for "Regulatory Affairs
 * Specialist" -> "affairs specialist", which keeps the word every field shares
 * and drops the one that identifies the field.
 *
 * When a search profile has been activated, `candidate.searchPhrases` already
 * holds a family-aware cover built in src/profile/roleFamilies.js — it knows
 * "regulatory affairs" is one term and uses it whole. Preferring it here means
 * every adapter that searches by phrase (Workday, Amazon, Oracle) gets the
 * better queries from one change.
 *
 * @param {object} candidate
 * @param {number} [maxTerms]
 * @returns {string[]}
 */
export function searchTermsFor(candidate, maxTerms = DEFAULT_MAX_SEARCH_TERMS) {
  const phrases = Array.isArray(candidate?.searchPhrases) ? candidate.searchPhrases.filter(Boolean) : [];
  const cap = Number.isFinite(maxTerms) ? Math.max(0, Math.trunc(maxTerms)) : DEFAULT_MAX_SEARCH_TERMS;
  if (phrases.length) return phrases.slice(0, cap);
  return deriveSearchTerms(candidate?.targetTitles, maxTerms);
}

/**
 * Default number of per-job detail GETs in flight per tenant. Bounded
 * concurrency (NOT a fixed inter-request delay) is the politeness mechanism.
 *
 * NOTE: this ceiling is PER TENANT, and many tenants share one Workday pod
 * (`*.wd5.myworkdayjobs.com`). Tenant-level ceilings alone let 8 tenants × 6
 * details = 48 requests land on one pod at once, which is what earned us the
 * HTTP 429s. The real ceiling is enforced per pod by the host gate below.
 */
const DEFAULT_DETAIL_CONCURRENCY = 6;

/**
 * Max requests in flight against a single Workday POD, across every tenant on
 * it. This is the ceiling the server actually counts against.
 */
const DEFAULT_HOST_CONCURRENCY = 8;

/**
 * Minimum gap between request STARTS against one pod.
 *
 * PERFORMANCE — this was 500ms, and at scale it was the single thing making a
 * discovery run take ten minutes.
 *
 * `minSpacingMs` and `maxConcurrent` are redundant controls, and spacing wins:
 * the gate serializes starts, so 500ms pinned the pod to 2 requests/second no
 * matter how high concurrency went. Every tenant on a pod shares that gate
 * (`hostKeyFor` deliberately maps `nvidia.wd5…` and `citi.wd5…` to
 * `wd5.myworkdayjobs.com`), and 87 of the configured tenants sit on wd1 alone.
 * At ~14 requests per tenant that is ~1,218 requests through one 2/s gate — a
 * ~609-second floor. Measured run: 602s for this source, 96% of the whole run.
 * The knob was tuned when 14 tenants were configured, where it never bound.
 *
 * Measured against wd1 directly (24 distinct tenants, escalating concurrency,
 * no added spacing, stopping on the first throttle):
 *
 *   concurrency  4 -> 3.7 req/s, p50 914ms, p95 2946ms, 0 throttles
 *   concurrency  8 -> 6.6 req/s, p50 801ms, p95 1843ms, 0 throttles
 *   concurrency 16 -> 9.6 req/s, p50 849ms, p95 1866ms, 0 throttles
 *
 * Latency did not degrade as concurrency rose, so we were nowhere near the
 * pod's limit. `maxConcurrent` alone is the honest bound — it caps simultaneous
 * load, which is what the server experiences — and the Retry-After handling and
 * circuit breaker remain the real safety net, reacting to actual throttling
 * instead of guessing at it. 8 in flight against infrastructure serving
 * thousands of enterprises stays conservative.
 */
const DEFAULT_HOST_SPACING_MS = 0;

/**
 * @param {object} source jobboards entry: { tenants: object[] }
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {{ wait: Function }} [ctx.rateLimiter]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.boardConcurrency] tenants in parallel
 * @param {number} [ctx.pageConcurrency] list pages in parallel per tenant
 * @param {number} [ctx.detailConcurrency] detail GETs in parallel per tenant
 * @param {number} [ctx.requestTimeoutMs]
 * @returns {Promise<{ jobs: object[], errors: Array<object> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, maxRetries = 3, requestTimeoutMs } = ctx;
  const tenants = Array.isArray(source.tenants) ? source.tenants : [];
  // Tenant parallelism is cheap and safe to raise: every tenant is a DIFFERENT
  // host, and per-host politeness is enforced by the host gate regardless. With
  // 200+ boards the wall clock is (waves x slowest tenant in the wave), so a
  // low tenant concurrency is pure serialization, not courtesy. The source may
  // therefore raise it above the global board default.
  const tenantConcurrency = source.boardConcurrency ?? ctx.boardConcurrency ?? DEFAULT_TENANT_CONCURRENCY;
  const pageConcurrency = ctx.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
  const detailConcurrency = ctx.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
  const maxDetailFetches = Number.isFinite(source.maxDetailFetches)
    ? Math.max(0, source.maxDetailFetches)
    : DEFAULT_MAX_DETAIL_FETCHES;
  // Never above MAX_PAGES — that stays a hard runaway guard, not a preference.
  const maxPagesPerTerm = Number.isFinite(source.maxPagesPerTerm)
    ? Math.min(MAX_PAGES, Math.max(1, Math.trunc(source.maxPagesPerTerm)))
    : DEFAULT_MAX_PAGES_PER_TERM;
  // Politeness knobs. The SOURCE wins over the global default, because the
  // global default cannot know that this source funnels 200+ tenants through a
  // handful of shared pod gates — `ctx.*` first made the source-level value
  // unreachable, so tuning it in jobboards.json silently did nothing.
  const hostSpacingMs = source.rateLimitMs === 0
    ? 0
    : Math.max(0, source.hostSpacingMs ?? ctx.workdayHostSpacingMs ?? DEFAULT_HOST_SPACING_MS);
  // One gate shared by every tenant in this source, so tenants that sit on the
  // same Workday pod share the pod's budget instead of each assuming it owns it.
  const hostGate = ctx.hostGate ?? createHostGate({
    maxConcurrent: source.hostConcurrency ?? ctx.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY,
  });
  // A SHARED gate (the orchestrator always passes one) ignored the source's own
  // `hostConcurrency`, so the measured 8-per-pod ceiling documented above ran at
  // the global default of 4. Configure this source's pods on the shared gate —
  // only when the source states a value, so a user who lowered the global
  // ceiling is never silently overruled.
  if (ctx.hostGate && Number.isFinite(source.hostConcurrency) && typeof hostGate.configure === 'function') {
    for (const t of tenants) {
      const host = String(t?.host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (host) hostGate.configure(host, source.hostConcurrency);
    }
  }
  const jobs = [];
  const errors = [];
  let cancelled = false;
  let reusedTotal = 0;

  // Search phrases for tenants that do not pin their own. Derived from the
  // candidate's target titles so the profile is the single source of truth —
  // adding a title to candidate.json changes what every tenant is searched for,
  // with no per-tenant edit. `source.searchTexts` overrides the derivation.
  const defaultTerms = Array.isArray(source.searchTexts) && source.searchTexts.length
    ? source.searchTexts.map((s) => String(s ?? '').trim())
    : searchTermsFor(ctx.candidate, source.maxSearchTerms);

  // Tenants are independent public career sites — fetch them in parallel.
  const perTenant = await mapWithConcurrency(tenants, tenantConcurrency, async (tenant) => {
    if (ctx.shouldCancel?.()) return { jobs: [], errors: [], cancelled: true };
    const cfg = validateTenant(tenant, defaultTerms);
    if (cfg.error) {
      return { jobs: [], errors: [{ tenant: tenant?.tenant ?? null, error: cfg.error }] };
    }
    try {
      const { jobs: found, errors: detailErrors, cancelled: tenantCancelled = false, reused = 0 } = await fetchTenant(cfg, {
        fetchImpl, rateLimiter, hostGate, maxRetries, rateLimitMs: source.rateLimitMs,
        requestTimeoutMs, pageConcurrency, detailConcurrency, hostSpacingMs,
        maxDetailFetches, workdayDetailCache: ctx.workdayDetailCache, shouldCancel: ctx.shouldCancel,
        targetTitles: ctx.candidate?.targetTitles ?? [],
        profileVocab: profileVocabularyFor(ctx.candidate),
        abortSignal: ctx.abortSignal, maxPagesPerTerm,
      });
      return {
        jobs: found, errors: detailErrors.map((e) => ({ tenant: cfg.tenant, site: cfg.site, ...e })),
        cancelled: tenantCancelled, reused,
      };
    } catch (err) {
      return {
        jobs: [],
        errors: [{
          tenant: cfg.tenant, site: cfg.site, error: err.message,
          status: err.status ?? null, attempts: err.attempts ?? 0,
        }],
      };
    }
  });

  for (const r of perTenant) {
    if (!r) continue;
    jobs.push(...r.jobs);
    errors.push(...r.errors);
    cancelled ||= r.cancelled === true;
    reusedTotal += r.reused ?? 0;
  }

  if (tenants.length === 0) {
    errors.push({ note: 'Workday source enabled but no tenants configured. Add { host, tenant, site } entries to `tenants`.' });
  }

  return { jobs, errors, cancelled, reused: reusedTotal };
}

/**
 * Validate and normalize a tenant config entry.
 * @param {object} t raw tenant entry
 * @param {string[]} [defaultTerms] phrases to search when the tenant names none
 */
function validateTenant(t = {}, defaultTerms = []) {
  const host = String(t.host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const tenant = String(t.tenant ?? '').trim();
  const site = String(t.site ?? '').trim();
  if (!host || !tenant || !site) {
    return { error: 'workday tenant requires host, tenant, and site' };
  }
  const searchText = String(t.searchText ?? '').trim();

  // Precedence: an explicit per-tenant list, then the legacy single string,
  // then the phrases derived from the candidate's own target titles. A tenant
  // that deliberately sets `searchText: ""` still means "enumerate everything",
  // so an EMPTY STRING is only overridden when the key is absent entirely.
  let searchTexts;
  if (Array.isArray(t.searchTexts) && t.searchTexts.length) {
    searchTexts = t.searchTexts.map((s) => String(s ?? '').trim());
  } else if (t.searchText !== undefined) {
    searchTexts = [searchText];
  } else {
    searchTexts = defaultTerms.length ? [...defaultTerms] : [''];
  }

  return {
    host,
    tenant,
    site,
    // Optional human company name for the board/tracker; falls back to the slug.
    company: String(t.company ?? t.name ?? '').trim() || tenant,
    locale: String(t.locale ?? '').trim(),
    // Workday's PUBLIC CXS endpoint hard-caps `limit` at 20 and returns HTTP 400
    // for anything larger. Clamp here so a generous config value never breaks
    // the request — pagination still walks the full result set across pages.
    pageSize: Number.isFinite(t.pageSize) && t.pageSize > 0 ? Math.min(t.pageSize, 20) : 20,
    searchText,
    searchTexts: [...new Set(searchTexts)],
    fetchDetails: t.fetchDetails !== false,
  };
}

/** Page through one tenant/site's public CXS jobs endpoint. */
async function fetchTenant(cfg, ctx) {
  const {
    fetchImpl, rateLimiter, hostGate, maxRetries, rateLimitMs, requestTimeoutMs,
    pageConcurrency, detailConcurrency, hostSpacingMs, maxDetailFetches,
    workdayDetailCache, shouldCancel, targetTitles = [], profileVocab = null, abortSignal,
    maxPagesPerTerm = MAX_PAGES,
  } = ctx;
  const endpoint = `https://${cfg.host}/wday/cxs/${encodeURIComponent(cfg.tenant)}/${encodeURIComponent(cfg.site)}/jobs`;
  const errors = [];
  let cancelled = false;

  // Spacing is keyed on the HOST, not the tenant: a key used once per run never
  // has a previous call to space against, so a tenant-keyed wait always
  // returned instantly and the limiter did nothing.
  const spacingKey = `workday:${cfg.host}`;

  /** Walk every page for ONE search phrase. */
  const fetchTerm = async (searchText) => {
    // Page 0 — fetched first so we learn `total` and can fan out the rest.
    if (rateLimiter) await rateLimiter.wait(spacingKey, rateLimitMs);
    const body = (offset) => pageBody(cfg, offset, searchText);
    const first = await withRetry(
      () => hostGate.run(endpoint, () => postJson(fetchImpl, endpoint, body(0), requestTimeoutMs, abortSignal), { minSpacingMs: hostSpacingMs, signal: abortSignal }),
      { maxRetries },
    );
    const firstPostings = Array.isArray(first.jobPostings) ? first.jobPostings : [];
    // `total` is reported on the FIRST page only — later pages return 0, so it
    // must be read here and never re-derived mid-walk.
    const total = Number.isFinite(first.total) ? first.total : firstPostings.length;
    const pageCount = Math.min(maxPagesPerTerm, Math.max(1, Math.ceil(total / cfg.pageSize)));

    // Remaining pages have computable offsets, so fetch them concurrently. The
    // host gate — not a per-offset rate-limit key — is what keeps the fan-out
    // polite, and it counts against the whole pod.
    const remainingOffsets = [];
    for (let page = 1; page < pageCount; page += 1) remainingOffsets.push(page * cfg.pageSize);
    const restPages = await mapWithConcurrency(remainingOffsets, pageConcurrency, async (offset) => {
      if (shouldCancel?.()) { cancelled = true; return { postings: [], error: null }; }
      try {
        const data = await withRetry(
          () => hostGate.run(endpoint, () => postJson(fetchImpl, endpoint, body(offset), requestTimeoutMs, abortSignal), { minSpacingMs: hostSpacingMs, signal: abortSignal }),
          { maxRetries },
        );
        return { postings: Array.isArray(data.jobPostings) ? data.jobPostings : [], error: null };
      } catch (err) {
        // A cancel legitimately drops every queued and in-flight request. Those
        // are not faults, and reporting one RCA entry per dropped request would
        // bury the real errors under hundreds of "cancelled" lines.
        if (err?.cancelled) { cancelled = true; return { postings: [], error: null }; }
        return {
          postings: [],
          error: {
            offset, searchText, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0,
          },
        };
      }
    });

    const found = [...firstPostings];
    for (const r of restPages) {
      if (!r) continue;
      found.push(...r.postings);
      if (r.error) errors.push(r.error);
    }
    return found;
  };

  // Each term is a separate search, so the SAME requisition comes back under
  // more than one of them. Dedupe on the posting's own path before mapping —
  // detail enrichment and its per-tenant budget must be spent once per job,
  // not once per phrase that happened to match it.
  const postings = [];
  const seenPostings = new Set();
  for (const term of cfg.searchTexts) {
    if (shouldCancel?.()) { cancelled = true; break; }
    let found;
    try {
      found = await fetchTerm(term);
    } catch (err) {
      // A cancel is not a phrase failure — record it as stopped and move on.
      if (err?.cancelled) { cancelled = true; break; }
      // One failing phrase must not cost the tenant the other phrase's results.
      errors.push({
        searchText: term, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0,
      });
      continue;
    }
    for (const p of found) {
      const key = p?.externalPath ?? p?.id ?? p?.title;
      if (key == null || seenPostings.has(key)) continue;
      seenPostings.add(key);
      postings.push(p);
    }
  }
  if (!postings.length && errors.length === cfg.searchTexts.length && cfg.searchTexts.length > 0) {
    // Every phrase failed — that is a tenant-level failure, not a partial one.
    throw Object.assign(new Error(errors[0].error), { status: errors[0].status });
  }

  const out = postings.map((p) => mapJob(p, cfg));

  // A previously stored full description is just as accurate as fetching the
  // same immutable requisition again. Hydrate it before spending detail budget.
  //
  // The stored LOCATION comes back with it (see hydrateFromDetailCache): the
  // list row blanks "2 Locations", and hydrating only the text left thousands
  // of offshore requisitions with a JD and no location for the US gate to read.
  const reused = hydrateFromDetailCache(out, workdayDetailCache);

  // Enrich only uncached jobs, within the configured per-tenant budget.
  // PUBLIC detail endpoint — concurrently (bounded).
  //
  // Detail enrichment is OPTIONAL: a job that keeps its summary is still a
  // usable job. So a throttled host must not produce one screaming error per
  // posting — it produces ONE note saying how many jobs stayed summary-only.
  if (cfg.fetchDetails) {
    // Spend the budget on the jobs most likely to matter, not on whichever ones
    // the tenant happened to list first.
    //
    // A tenant commonly returns 100-200 postings and the budget is a handful, so
    // `.slice(0, budget)` on raw list order gave ~5% coverage chosen at random —
    // full descriptions for four arbitrary requisitions while genuinely on-target
    // ones stayed summary-only. Sorting by title relevance first costs nothing
    // extra (same request count) and makes those few fetches the useful ones.
    //
    // Priorities are computed ONCE per job before sorting (decorate-sort):
    // inside the comparator they ran O(n log n) times — ~1 s per 150 titles.
    const pairs = out
      .map((job, i) => ({ job, posting: postings[i], i }))
      .filter(({ job }) => job.rawMetadata?.summaryOnly !== false)
      .map((pair) => ({ ...pair, p: detailPriority(pair.job, targetTitles, profileVocab) }))
      .sort((a, b) => (b.p - a.p) || (a.i - b.i))
      .slice(0, maxDetailFetches);
    const notes = await mapWithConcurrency(pairs, detailConcurrency, ({ job, posting }) => {
      if (shouldCancel?.()) { cancelled = true; return null; }
      return enrichWithDetail(job, posting, cfg, {
        fetchImpl, hostGate, maxRetries, requestTimeoutMs, hostSpacingMs, abortSignal,
      });
    });
    const failed = notes.filter(Boolean);
    if (failed.length > 0) errors.push(summarizeDetailFailures(failed, cfg, out.length));
  }

  return { jobs: out, errors, cancelled, reused };
}

/**
 * Fold every failed detail fetch for a tenant into ONE reportable note.
 *
 * Previously each of up to 200 postings emitted its own RCA entry, so a single
 * throttled pod buried the dashboard under identical rows and made a degraded
 * run look like a catastrophic one.
 *
 * @param {object[]} failed per-job failure notes
 * @param {object} cfg tenant config
 * @param {number} totalJobs jobs kept for this tenant
 * @returns {object} one aggregated error note
 */
function summarizeDetailFailures(failed, cfg, totalJobs) {
  // Report the dominant status (throttling beats an incidental 404).
  const byStatus = new Map();
  let attempts = 0;
  for (const f of failed) {
    const key = f.status ?? 0;
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    attempts = Math.max(attempts, f.attempts ?? 0);
  }
  const throttled = (byStatus.get(429) ?? 0) + (byStatus.get(503) ?? 0);
  const status = throttled > 0
    ? 429
    : [...byStatus.entries()].sort((a, b) => b[1] - a[1])[0][0] || null;

  const reason = throttled > 0
    ? `${cfg.host} rate-limited the per-job detail endpoint (HTTP 429)`
    : `the per-job detail endpoint was unavailable (${failed[0].error})`;

  return {
    error: `${failed.length} of ${totalJobs} jobs kept a summary-only description: ${reason}`,
    status: status || null,
    attempts,
    // The jobs are IN the results — this is a fidelity loss, not a data loss.
    degraded: true,
    count: failed.length,
    sample: failed[0].url ?? null,
  };
}

/** Build the CXS list-request body for a given offset and search phrase. */
function pageBody(cfg, offset, searchText = cfg.searchText) {
  return { limit: cfg.pageSize, offset, searchText: searchText ?? '', appliedFacets: {} };
}

async function postJson(fetchImpl, url, body, requestTimeoutMs, signal) {
  // One deadline for headers AND body — see fetchJsonWithTimeout.
  return fetchJsonWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    // `fetchWithTimeout` composes this with its own timeout controller, so a
    // cancelled run aborts the request already on the wire instead of waiting
    // out the full requestTimeoutMs.
    ...(signal ? { signal } : {}),
  }, requestTimeoutMs, 'Workday');
}

/**
 * GET a posting's PUBLIC CXS detail endpoint and merge the full job description
 * into the summary job. The detail endpoint is the same unauthenticated JSON a
 * public career page loads when a candidate opens a posting:
 *
 *   GET https://{host}/wday/cxs/{tenant}/{site}{externalPath}
 *   -> { jobPostingInfo: { jobDescription: "<html>", startDate, jobReqId, ... } }
 *
 * On any failure the job is left summary-level (rawMetadata.summaryOnly=true)
 * and a clear note is returned. Returns an error-note object or null.
 *
 * @param {object} job normalized summary job (mutated in place on success)
 * @param {object} posting raw CXS posting
 * @param {object} cfg validated tenant config
 * @param {object} ctx { fetchImpl, maxRetries, requestTimeoutMs }
 * @returns {Promise<object|null>}
 */
export async function enrichWithDetail(job, posting, cfg, ctx) {
  const { fetchImpl, hostGate, maxRetries, requestTimeoutMs, hostSpacingMs, abortSignal } = ctx;
  const externalPath = String(posting.externalPath ?? '').trim();
  if (!externalPath) {
    job.rawMetadata.summaryOnly = true;
    return null;
  }
  const path = externalPath.startsWith('/') ? externalPath : `/${externalPath}`;
  const url = `https://${cfg.host}/wday/cxs/${encodeURIComponent(cfg.tenant)}/${encodeURIComponent(cfg.site)}${path}`;

  // The host already told us to slow down. Detail text is a nice-to-have, so
  // stop asking rather than spending a retry budget per job on a pod that is
  // refusing us — that is what turned one 429 into hundreds.
  if (hostGate?.isOpen(url)) {
    job.rawMetadata.summaryOnly = true;
    job.rawMetadata.detailSkipped = 'host-throttled';
    return { url, error: 'skipped: host is rate-limiting (backed off)', status: 429, attempts: 0, summaryOnly: true };
  }

  try {
    const call = () => getJson(fetchImpl, url, requestTimeoutMs);
    const data = await withRetry(
      () => (hostGate ? hostGate.run(url, call, { minSpacingMs: hostSpacingMs, signal: abortSignal }) : call()),
      { maxRetries },
    );
    const info = data?.jobPostingInfo ?? {};
    const desc = info.jobDescription ?? info.jobDescriptionText ?? '';
    const text = htmlToText(desc);
    if (text && text.length > 0) {
      job.jdText = text.slice(0, 20000);
      job.rawMetadata.summaryOnly = false;
      job.rawMetadata.detailFetched = true;
      // The detail endpoint carries the only EXACT date Workday publishes, so it
      // supersedes the day-accurate value derived from "Posted N Days Ago".
      if (info.startDate) {
        job.postedAt = String(info.startDate);
        delete job.rawMetadata.postedAtApprox;
      }
      if (info.jobReqId) job.rawMetadata.jobReqId = String(info.jobReqId);

      // RESOLVE THE REAL LOCATION. The CXS LIST endpoint collapses a
      // multi-location requisition to the placeholder "2 Locations", and that
      // string was being stored as the job's location — so a Manulife role in
      // Quezon City and Lapu Lapu City reached the board with no city, no
      // country, and nothing for the US-only filter to judge. The detail
      // endpoint carries the actual places AND an explicit `country`, which is
      // authoritative in a way that string-matching a location never is.
      const places = [info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : [])]
        .map((p) => String(p ?? '').replace(/,\s*$/, '').trim())
        .filter(Boolean);
      if (places.length) job.location = places.join('; ');
      const country = info.country?.descriptor ?? info.country;
      if (country && typeof country === 'string') job.rawMetadata.country = country.trim();
      return null;
    }
    // Reached the endpoint but found no description field — stay summary-level.
    job.rawMetadata.summaryOnly = true;
    job.rawMetadata.detailFetched = false;
    return null;
  } catch (err) {
    // A cancelled run drops every queued detail fetch. The job simply keeps its
    // summary — that is the documented, harmless outcome, not a degradation
    // worth reporting. Without this, stopping a run produced one "kept a
    // summary-only description" note per tenant still in flight, which reads as
    // a wall of failures caused by the user's own Stop click.
    if (err?.cancelled) {
      job.rawMetadata.summaryOnly = true;
      job.rawMetadata.detailSkipped = 'run-cancelled';
      return null;
    }
    // Public detail not available (404/403/429/etc.) — keep summary, log clearly.
    job.rawMetadata.summaryOnly = true;
    job.rawMetadata.detailError = err.message;
    return {
      url,
      error: `detail fetch failed (${err.message}); kept summaryOnly`,
      // Carry the status structurally. Left to prose, "detail fetch failed"
      // matched the classifier's "fetch failed" network rule and a plain 429
      // was reported to the user as "check your internet connection".
      status: err.status ?? (err.circuitOpen ? 429 : null),
      attempts: err.attempts ?? 0,
      summaryOnly: true,
    };
  }
}

async function getJson(fetchImpl, url, requestTimeoutMs) {
  return fetchJsonWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json' } }, requestTimeoutMs, 'Workday detail');
}

/**
 * Turn Workday's RELATIVE posting label into a real date.
 *
 * The public CXS list endpoint does not send a date. It sends `postedOn` as
 * human prose — "Posted Today", "Posted 5 Days Ago", "Posted 30+ Days Ago" —
 * and the ISO `startDate` exists ONLY on the per-job detail endpoint.
 *
 * That mattered far more than it looks: the adapter used to read a
 * `postedOnDate` field that the API does not send, so every Workday job arrived
 * with postedAt=null, and the freshness filter DROPS undated jobs by default.
 * A tenant whose detail endpoint was rate-limited therefore lost every one of
 * its jobs silently — the 429 looked like "missing descriptions" and was
 * actually total data loss for that source.
 *
 * This reads the source's own metadata; it never invents a date. "30+ Days Ago"
 * is a lower bound, so it resolves to exactly 30 days — old enough to be stale
 * under any window we support, which is all the precision the bound supports.
 *
 * @param {unknown} postedOn e.g. "Posted 5 Days Ago"
 * @param {Date} [now]
 * @returns {string|null} ISO-8601 date, or null when there is nothing to read
 */
export function parseWorkdayPostedOn(postedOn, now = new Date()) {
  const s = String(postedOn ?? '').trim().toLowerCase();
  if (!s) return null;

  const daysAgo = (n) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  if (/\bposted\s+today\b/.test(s)) return now.toISOString();
  if (/\bposted\s+yesterday\b/.test(s)) return daysAgo(1);

  const days = /\bposted\s+(\d+)\+?\s*days?\s+ago\b/.exec(s);
  if (days) return daysAgo(Number(days[1]));

  const months = /\bposted\s+(\d+)\+?\s*months?\s+ago\b/.exec(s);
  if (months) return daysAgo(Number(months[1]) * 30);

  return null;
}

/**
 * Map one Workday CXS posting to the normalized shape.
 *
 * The list endpoint returns summary fields only (no full description). We compose
 * a useful jdText from the title, location, and bulletFields so discovery + scoring
 * have signal; the full JD comes from the per-job detail endpoint.
 *
 * @param {object} p posting
 * @param {object} cfg validated tenant config
 * @param {object} [opts]
 * @param {Date} [opts.now] reference time for relative posting labels
 * @returns {object} normalized job
 */
export function mapJob(p, cfg, { now = new Date() } = {}) {
  const externalPath = String(p.externalPath ?? '');
  const base = `https://${cfg.host}${cfg.locale ? `/${cfg.locale}` : ''}/${cfg.site}`;
  const url = jobUrl(base, externalPath);
  const bullets = Array.isArray(p.bulletFields) ? p.bulletFields.filter(Boolean) : [];
  // "2 Locations" / "3 Locations" is Workday's AGGREGATE label, not a place.
  // Storing it verbatim gave the geography filter a string it could never
  // judge, so offshore multi-location reqs passed a US-only gate untouched.
  const rawLocation = String(p.locationsText ?? p.location ?? '');
  const isAggregate = /^\s*\d+\s+locations?\s*$/i.test(rawLocation);
  // The primary place is ALSO in the requisition's own path —
  // `/job/Hyderabad/Data-Engineer_ATCI-…`, `/job/US-CA-Santa-Clara/…` — so a
  // blanked aggregate (or a tenant that sends no location at all) still has a
  // real place for the geography gate. Measured: the only two Apply-tier
  // Workday rows on the live board were Accenture `/job/Hyderabad/…` postings
  // stored with an EMPTY location. The detail endpoint, when read, replaces
  // this with the full list of places.
  const fromPath = (isAggregate || !rawLocation.trim()) ? locationFromExternalPath(externalPath) : '';
  const location = isAggregate ? fromPath : (rawLocation.trim() ? rawLocation : fromPath);
  const jdText = htmlToText([p.title, location, ...bullets].filter(Boolean).join('. '));

  // An exact date if the tenant sends one; otherwise derive it from the
  // relative label the API actually returns. Only a truly silent posting
  // (neither field) stays undated.
  const exact = p.postedOnDate ?? p.startDate ?? null;
  const approx = exact ? null : parseWorkdayPostedOn(p.postedOn, now);

  return normalizeJob({
    source: 'workday',
    sourceJobId: workdayReqId(p),
    company: cfg.company ?? cfg.tenant,
    title: p.title ?? '',
    location,
    url,
    jdText,
    postedAt: exact ?? approx,
    employmentType: p.timeType ?? '',
    rawMetadata: {
      tenant: cfg.tenant,
      site: cfg.site,
      externalPath,
      summaryOnly: true,
      // The real places live on the detail endpoint; until it is fetched this
      // job has NO usable location rather than a fake one. Recording the
      // original label keeps the drop auditable.
      ...(isAggregate ? { locationAggregate: rawLocation } : {}),
      // Marks the location as the path's PRIMARY place only, so a stored
      // detail location (every place) is allowed to replace it on hydration.
      ...(fromPath && location === fromPath ? { locationFromUrl: true } : {}),
      // Be honest about where the date came from: derived from "Posted N Days
      // Ago" is day-accurate, not timestamp-accurate.
      ...(approx ? { postedAtApprox: true, postedOnLabel: String(p.postedOn) } : {}),
    },
  });
}

/**
 * The primary location a Workday requisition path names, or ''.
 *
 * Workday paths are `/job/<Location-Slug>/<Title-Slug>_<ReqId>`. A path with a
 * single segment (`/job/Sr-Product-Manager_REQ1`) carries no place and yields
 * ''. Hyphens become spaces except in a leading ISO country prefix
 * (`IN-KA-Bangalore`, `PH-00-Taguig`), which the US gate reads in that shape.
 *
 * @param {string} externalPath
 * @returns {string}
 */
export function locationFromExternalPath(externalPath) {
  const m = /^\/?job\/([^/]+)\/[^/]+$/i.exec(String(externalPath ?? '').trim());
  if (!m) return '';
  let slug;
  try { slug = decodeURIComponent(m[1]); } catch { slug = m[1]; }
  slug = slug.replace(/-+$/, '').trim();
  if (!slug || /^\d+$/.test(slug)) return '';
  // Keep a `CC-RR-City` country prefix intact; everything else reads as words.
  if (/^[A-Za-z]{2,3}-[A-Za-z0-9]{1,3}-\S/.test(slug)) return slug;
  return slug.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The stable requisition id for a posting.
 *
 * `bulletFields` is tenant-CONFIGURABLE — it usually holds the req id, but a
 * tenant can populate it with a location or a relative date, which would make
 * the job's identity churn between runs. The req id suffixed on `externalPath`
 * (…/Test-Engineer_JR2020205) is set by Workday itself, so prefer it.
 *
 * @param {object} p posting
 * @returns {string}
 */
export function workdayReqId(p = {}) {
  const path = String(p.externalPath ?? '');
  const fromPath = /_([A-Za-z0-9][\w.-]*)$/.exec(path);
  if (fromPath) return fromPath[1];
  const bullet = String(p.bulletFields?.[0] ?? '').trim();
  // Accept a bullet only when it LOOKS like an id (no spaces, has a digit).
  if (bullet && !/\s/.test(bullet) && /\d/.test(bullet)) return bullet;
  return path || String(p.title ?? '');
}

/** Build an absolute job URL from a Workday externalPath. */
/**
 * Build the public posting URL for a CXS row.
 *
 * REGRESSION GUARD. This used to be `new URL(externalPath, 'https://' + host)`,
 * which silently produced a 404 for every Workday job ever discovered — the
 * single largest source in the database. `externalPath` is always root-relative
 * (`/job/Remote-Kentucky/Lead-Cloud---Data-Platform-Engineer_R-422722`), and a
 * root-relative path RESOLVES AGAINST THE ORIGIN, discarding the `/{locale}/`
 * and `/{site}` segments that identify which career site the job lives on.
 * Verified live: without the site segment Workday answers 404; with it, 200.
 *
 * So this concatenates rather than resolves. It deliberately does NOT try to
 * detect a site already present in the path — Citi's site is literally "2",
 * which appears inside plenty of requisition numbers, so any such test
 * produces false positives on exactly the tenants it would corrupt.
 *
 * @param {string} base `https://host[/locale]/site`, no trailing slash
 * @param {string} externalPath root-relative path from the CXS row
 * @returns {string}
 */
function jobUrl(base, externalPath) {
  if (!externalPath) return base;
  const path = externalPath.startsWith('/') ? externalPath : `/${externalPath}`;
  const joined = `${base}${path}`;
  try {
    // Round-trip so a malformed path can never emit an unopenable link.
    return new URL(joined).href;
  } catch {
    return base;
  }
}
