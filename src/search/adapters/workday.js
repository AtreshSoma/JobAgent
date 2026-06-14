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
import { fetchWithTimeout } from '../../utils/httpClient.js';

export const adapterId = 'workday';

/** Hard cap on pagination to avoid runaway loops on misconfigured tenants. */
const MAX_PAGES = 50;

/** Hard cap on per-job detail GETs per tenant (runaway protection). */
const MAX_DETAIL_FETCHES = 200;

/** Default number of tenants fetched in parallel. */
const DEFAULT_TENANT_CONCURRENCY = 6;

/** Default number of list pages fetched in parallel per tenant. */
const DEFAULT_PAGE_CONCURRENCY = 4;

/**
 * Default number of per-job detail GETs in flight per tenant. Bounded
 * concurrency (NOT a fixed inter-request delay) is the politeness mechanism —
 * this is the single biggest discovery speedup, since the old code serialized
 * every detail fetch behind a shared rate-limit key.
 */
const DEFAULT_DETAIL_CONCURRENCY = 6;

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
  const tenantConcurrency = ctx.boardConcurrency ?? DEFAULT_TENANT_CONCURRENCY;
  const pageConcurrency = ctx.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
  const detailConcurrency = ctx.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
  const jobs = [];
  const errors = [];

  // Tenants are independent public career sites — fetch them in parallel.
  const perTenant = await mapWithConcurrency(tenants, tenantConcurrency, async (tenant) => {
    const cfg = validateTenant(tenant);
    if (cfg.error) {
      return { jobs: [], errors: [{ tenant: tenant?.tenant ?? null, error: cfg.error }] };
    }
    try {
      const { jobs: found, errors: detailErrors } = await fetchTenant(cfg, {
        fetchImpl, rateLimiter, maxRetries, rateLimitMs: source.rateLimitMs,
        requestTimeoutMs, pageConcurrency, detailConcurrency,
      });
      return { jobs: found, errors: detailErrors.map((e) => ({ tenant: cfg.tenant, site: cfg.site, ...e })) };
    } catch (err) {
      return { jobs: [], errors: [{ tenant: cfg.tenant, site: cfg.site, error: err.message }] };
    }
  });

  for (const r of perTenant) {
    if (!r) continue;
    jobs.push(...r.jobs);
    errors.push(...r.errors);
  }

  if (tenants.length === 0) {
    errors.push({ note: 'Workday source enabled but no tenants configured. Add { host, tenant, site } entries to `tenants`.' });
  }

  return { jobs, errors };
}

/** Validate and normalize a tenant config entry. */
function validateTenant(t = {}) {
  const host = String(t.host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const tenant = String(t.tenant ?? '').trim();
  const site = String(t.site ?? '').trim();
  if (!host || !tenant || !site) {
    return { error: 'workday tenant requires host, tenant, and site' };
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
    searchText: String(t.searchText ?? '').trim(),
    fetchDetails: t.fetchDetails !== false,
  };
}

/** Page through one tenant/site's public CXS jobs endpoint. */
async function fetchTenant(cfg, ctx) {
  const { fetchImpl, rateLimiter, maxRetries, rateLimitMs, requestTimeoutMs, pageConcurrency, detailConcurrency } = ctx;
  const endpoint = `https://${cfg.host}/wday/cxs/${encodeURIComponent(cfg.tenant)}/${encodeURIComponent(cfg.site)}/jobs`;
  const errors = [];

  // Page 0 — fetched first so we learn `total` and can fan out the rest.
  if (rateLimiter) await rateLimiter.wait(`workday:${cfg.tenant}`, rateLimitMs);
  const first = await withRetry(
    () => postJson(fetchImpl, endpoint, pageBody(cfg, 0), requestTimeoutMs),
    { maxRetries },
  );
  const firstPostings = Array.isArray(first.jobPostings) ? first.jobPostings : [];
  const total = Number.isFinite(first.total) ? first.total : firstPostings.length;
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / cfg.pageSize)));

  // Remaining pages have computable offsets, so fetch them concurrently
  // (bounded) instead of walking 4s apart one page at a time.
  const remainingOffsets = [];
  for (let page = 1; page < pageCount; page += 1) remainingOffsets.push(page * cfg.pageSize);
  const restPages = await mapWithConcurrency(remainingOffsets, pageConcurrency, async (offset) => {
    try {
      // Unique key per offset so the rate limiter never serializes parallel pages.
      if (rateLimiter) await rateLimiter.wait(`workday-page:${cfg.tenant}:${offset}`, rateLimitMs);
      const data = await withRetry(
        () => postJson(fetchImpl, endpoint, pageBody(cfg, offset), requestTimeoutMs),
        { maxRetries },
      );
      return { postings: Array.isArray(data.jobPostings) ? data.jobPostings : [], error: null };
    } catch (err) {
      return { postings: [], error: { offset, error: err.message } };
    }
  });

  const postings = [...firstPostings];
  for (const r of restPages) {
    if (!r) continue;
    postings.push(...r.postings);
    if (r.error) errors.push(r.error);
  }

  const out = postings.map((p) => mapJob(p, cfg));

  // Enrich up to MAX_DETAIL_FETCHES jobs with their full JD via the per-job
  // PUBLIC detail endpoint — concurrently (bounded). This replaces the old
  // strictly-serial path that dominated discovery runtime.
  if (cfg.fetchDetails) {
    const pairs = out
      .slice(0, MAX_DETAIL_FETCHES)
      .map((job, i) => ({ job, posting: postings[i] }));
    const notes = await mapWithConcurrency(pairs, detailConcurrency, ({ job, posting }) =>
      enrichWithDetail(job, posting, cfg, { fetchImpl, maxRetries, requestTimeoutMs }));
    for (const note of notes) {
      if (note) errors.push(note);
    }
  }

  return { jobs: out, errors };
}

/** Build the CXS list-request body for a given offset. */
function pageBody(cfg, offset) {
  return { limit: cfg.pageSize, offset, searchText: cfg.searchText, appliedFacets: {} };
}

async function postJson(fetchImpl, url, body, requestTimeoutMs) {
  const res = await fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }, requestTimeoutMs);
  if (!res.ok) {
    const e = new Error(`Workday HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
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
  const { fetchImpl, maxRetries, requestTimeoutMs } = ctx;
  const externalPath = String(posting.externalPath ?? '').trim();
  if (!externalPath) {
    job.rawMetadata.summaryOnly = true;
    return null;
  }
  const path = externalPath.startsWith('/') ? externalPath : `/${externalPath}`;
  const url = `https://${cfg.host}/wday/cxs/${encodeURIComponent(cfg.tenant)}/${encodeURIComponent(cfg.site)}${path}`;
  try {
    const data = await withRetry(() => getJson(fetchImpl, url, requestTimeoutMs), { maxRetries });
    const info = data?.jobPostingInfo ?? {};
    const desc = info.jobDescription ?? info.jobDescriptionText ?? '';
    const text = htmlToText(desc);
    if (text && text.length > 0) {
      job.jdText = text.slice(0, 20000);
      job.rawMetadata.summaryOnly = false;
      job.rawMetadata.detailFetched = true;
      if (info.startDate && !job.postedAt) job.postedAt = String(info.startDate);
      if (info.jobReqId) job.rawMetadata.jobReqId = String(info.jobReqId);
      return null;
    }
    // Reached the endpoint but found no description field — stay summary-level.
    job.rawMetadata.summaryOnly = true;
    job.rawMetadata.detailFetched = false;
    return null;
  } catch (err) {
    // Public detail not available (404/403/429/etc.) — keep summary, log clearly.
    job.rawMetadata.summaryOnly = true;
    job.rawMetadata.detailError = err.message;
    return { url, error: `detail fetch failed (${err.message}); kept summaryOnly`, summaryOnly: true };
  }
}

async function getJson(fetchImpl, url, requestTimeoutMs) {
  const res = await fetchWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json' } }, requestTimeoutMs);
  if (!res.ok) {
    const e = new Error(`Workday detail HTTP ${res.status} for ${url}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

/**
 * Map one Workday CXS posting to the normalized shape.
 *
 * The list endpoint returns summary fields only (no full description). We compose
 * a useful jdText from the title, location, and bulletFields so discovery + scoring
 * have signal; full JD requires the per-job detail endpoint (future enhancement).
 *
 * @param {object} p posting
 * @param {object} cfg validated tenant config
 * @returns {object} normalized job
 */
export function mapJob(p, cfg) {
  const externalPath = String(p.externalPath ?? '');
  const base = `https://${cfg.host}${cfg.locale ? `/${cfg.locale}` : ''}/${cfg.site}`;
  const url = externalPath ? safeJoinUrl(`https://${cfg.host}`, externalPath, base) : base;
  const bullets = Array.isArray(p.bulletFields) ? p.bulletFields.filter(Boolean) : [];
  const location = p.locationsText ?? p.location ?? '';
  const jdText = htmlToText([p.title, location, ...bullets].filter(Boolean).join('. '));

  return normalizeJob({
    source: 'workday',
    sourceJobId: String(p.bulletFields?.[0] ?? p.externalPath ?? p.title ?? ''),
    company: cfg.company ?? cfg.tenant,
    title: p.title ?? '',
    location,
    url,
    jdText,
    postedAt: p.postedOnDate ?? p.startDate ?? null,
    employmentType: p.timeType ?? '',
    rawMetadata: { tenant: cfg.tenant, site: cfg.site, externalPath, summaryOnly: true },
  });
}

/** Build an absolute job URL from a Workday externalPath. */
function safeJoinUrl(origin, externalPath, base) {
  try {
    // externalPath usually starts with '/', resolving against origin is correct.
    return new URL(externalPath, origin).href;
  } catch {
    return base;
  }
}
