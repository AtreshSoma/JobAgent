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

export const adapterId = 'workday';

/** Hard cap on pagination to avoid runaway loops on misconfigured tenants. */
const MAX_PAGES = 50;

/** Hard cap on per-job detail GETs per tenant (runaway protection). */
const MAX_DETAIL_FETCHES = 200;

/**
 * @param {object} source jobboards entry: { tenants: object[] }
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {{ wait: Function }} [ctx.rateLimiter]
 * @param {number} [ctx.maxRetries]
 * @returns {Promise<{ jobs: object[], errors: Array<object> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, maxRetries = 3 } = ctx;
  const tenants = Array.isArray(source.tenants) ? source.tenants : [];
  const jobs = [];
  const errors = [];

  for (const tenant of tenants) {
    const cfg = validateTenant(tenant);
    if (cfg.error) {
      errors.push({ tenant: tenant?.tenant ?? null, error: cfg.error });
      continue;
    }
    try {
      const { jobs: found, errors: detailErrors } = await fetchTenant(cfg, { fetchImpl, rateLimiter, maxRetries, rateLimitMs: source.rateLimitMs });
      jobs.push(...found);
      for (const e of detailErrors) errors.push({ tenant: cfg.tenant, site: cfg.site, ...e });
    } catch (err) {
      errors.push({ tenant: cfg.tenant, site: cfg.site, error: err.message });
    }
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
    locale: String(t.locale ?? '').trim(),
    pageSize: Number.isFinite(t.pageSize) && t.pageSize > 0 ? Math.min(t.pageSize, 100) : 20,
    searchText: String(t.searchText ?? '').trim(),
    fetchDetails: t.fetchDetails !== false,
  };
}

/** Page through one tenant/site's public CXS jobs endpoint. */
async function fetchTenant(cfg, ctx) {
  const { fetchImpl, rateLimiter, maxRetries, rateLimitMs } = ctx;
  const endpoint = `https://${cfg.host}/wday/cxs/${encodeURIComponent(cfg.tenant)}/${encodeURIComponent(cfg.site)}/jobs`;
  const out = [];
  const errors = [];
  let offset = 0;
  let total = Infinity;
  let detailCount = 0;

  for (let page = 0; page < MAX_PAGES && offset < total; page += 1) {
    if (rateLimiter) await rateLimiter.wait(`workday:${cfg.tenant}`, rateLimitMs);
    const body = { limit: cfg.pageSize, offset, searchText: cfg.searchText, appliedFacets: {} };
    const data = await withRetry(() => postJson(fetchImpl, endpoint, body), { maxRetries });

    total = Number.isFinite(data.total) ? data.total : (data.jobPostings?.length ?? 0);
    const postings = Array.isArray(data.jobPostings) ? data.jobPostings : [];
    if (postings.length === 0) break;

    for (const p of postings) {
      const job = mapJob(p, cfg);
      if (cfg.fetchDetails && detailCount < MAX_DETAIL_FETCHES) {
        detailCount += 1;
        const note = await enrichWithDetail(job, p, cfg, ctx);
        if (note) errors.push(note);
      }
      out.push(job);
    }
    offset += postings.length;
  }
  return { jobs: out, errors };
}

async function postJson(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
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
 * @param {object} ctx { fetchImpl, rateLimiter, maxRetries, rateLimitMs }
 * @returns {Promise<object|null>}
 */
export async function enrichWithDetail(job, posting, cfg, ctx) {
  const { fetchImpl, rateLimiter, maxRetries, rateLimitMs } = ctx;
  const externalPath = String(posting.externalPath ?? '').trim();
  if (!externalPath) {
    job.rawMetadata.summaryOnly = true;
    return null;
  }
  const path = externalPath.startsWith('/') ? externalPath : `/${externalPath}`;
  const url = `https://${cfg.host}/wday/cxs/${encodeURIComponent(cfg.tenant)}/${encodeURIComponent(cfg.site)}${path}`;
  try {
    if (rateLimiter) await rateLimiter.wait(`workday-detail:${cfg.tenant}`, rateLimitMs);
    const data = await withRetry(() => getJson(fetchImpl, url), { maxRetries });
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

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
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
    company: cfg.tenant,
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
