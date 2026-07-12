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
import { fetchWithTimeout, httpError } from '../../utils/httpClient.js';
import { createHostGate } from '../../utils/hostGate.js';

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
const DEFAULT_HOST_CONCURRENCY = 4;

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
  const hostSpacingMs = source.rateLimitMs === 0
    ? 0
    : Math.max(0, ctx.workdayHostSpacingMs ?? source.hostSpacingMs ?? 500);
  // One gate shared by every tenant in this source, so tenants that sit on the
  // same Workday pod share the pod's budget instead of each assuming it owns it.
  const hostGate = ctx.hostGate ?? createHostGate({
    maxConcurrent: ctx.hostConcurrency ?? source.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY,
  });
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
        fetchImpl, rateLimiter, hostGate, maxRetries, rateLimitMs: source.rateLimitMs,
        requestTimeoutMs, pageConcurrency, detailConcurrency, hostSpacingMs,
      });
      return { jobs: found, errors: detailErrors.map((e) => ({ tenant: cfg.tenant, site: cfg.site, ...e })) };
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
  const { fetchImpl, rateLimiter, hostGate, maxRetries, rateLimitMs, requestTimeoutMs, pageConcurrency, detailConcurrency, hostSpacingMs } = ctx;
  const endpoint = `https://${cfg.host}/wday/cxs/${encodeURIComponent(cfg.tenant)}/${encodeURIComponent(cfg.site)}/jobs`;
  const errors = [];

  // Spacing is keyed on the HOST, not the tenant: a key used once per run never
  // has a previous call to space against, so a tenant-keyed wait always
  // returned instantly and the limiter did nothing.
  const spacingKey = `workday:${cfg.host}`;

  // Page 0 — fetched first so we learn `total` and can fan out the rest.
  if (rateLimiter) await rateLimiter.wait(spacingKey, rateLimitMs);
  const first = await withRetry(
    () => hostGate.run(endpoint, () => postJson(fetchImpl, endpoint, pageBody(cfg, 0), requestTimeoutMs), { minSpacingMs: hostSpacingMs }),
    { maxRetries },
  );
  const firstPostings = Array.isArray(first.jobPostings) ? first.jobPostings : [];
  const total = Number.isFinite(first.total) ? first.total : firstPostings.length;
  const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / cfg.pageSize)));

  // Remaining pages have computable offsets, so fetch them concurrently. The
  // host gate — not a per-offset rate-limit key — is what keeps the fan-out
  // polite, and it counts against the whole pod.
  const remainingOffsets = [];
  for (let page = 1; page < pageCount; page += 1) remainingOffsets.push(page * cfg.pageSize);
  const restPages = await mapWithConcurrency(remainingOffsets, pageConcurrency, async (offset) => {
    try {
      const data = await withRetry(
        () => hostGate.run(endpoint, () => postJson(fetchImpl, endpoint, pageBody(cfg, offset), requestTimeoutMs), { minSpacingMs: hostSpacingMs }),
        { maxRetries },
      );
      return { postings: Array.isArray(data.jobPostings) ? data.jobPostings : [], error: null };
    } catch (err) {
      return {
        postings: [],
        error: {
          offset, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0,
        },
      };
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
  // PUBLIC detail endpoint — concurrently (bounded).
  //
  // Detail enrichment is OPTIONAL: a job that keeps its summary is still a
  // usable job. So a throttled host must not produce one screaming error per
  // posting — it produces ONE note saying how many jobs stayed summary-only.
  if (cfg.fetchDetails) {
    const pairs = out
      .slice(0, MAX_DETAIL_FETCHES)
      .map((job, i) => ({ job, posting: postings[i] }));
    const notes = await mapWithConcurrency(pairs, detailConcurrency, ({ job, posting }) =>
      enrichWithDetail(job, posting, cfg, { fetchImpl, hostGate, maxRetries, requestTimeoutMs, hostSpacingMs }));
    const failed = notes.filter(Boolean);
    if (failed.length > 0) errors.push(summarizeDetailFailures(failed, cfg, out.length));
  }

  return { jobs: out, errors };
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
  if (!res.ok) throw httpError(res, 'Workday', url);
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
  const { fetchImpl, hostGate, maxRetries, requestTimeoutMs, hostSpacingMs } = ctx;
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
      () => (hostGate ? hostGate.run(url, call, { minSpacingMs: hostSpacingMs }) : call()),
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
  const res = await fetchWithTimeout(fetchImpl, url, { headers: { Accept: 'application/json' } }, requestTimeoutMs);
  if (!res.ok) throw httpError(res, 'Workday detail', url);
  return res.json();
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
  const url = externalPath ? safeJoinUrl(`https://${cfg.host}`, externalPath, base) : base;
  const bullets = Array.isArray(p.bulletFields) ? p.bulletFields.filter(Boolean) : [];
  const location = p.locationsText ?? p.location ?? '';
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
      // Be honest about where the date came from: derived from "Posted N Days
      // Ago" is day-accurate, not timestamp-accurate.
      ...(approx ? { postedAtApprox: true, postedOnLabel: String(p.postedOn) } : {}),
    },
  });
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
function safeJoinUrl(origin, externalPath, base) {
  try {
    // externalPath usually starts with '/', resolving against origin is correct.
    return new URL(externalPath, origin).href;
  } catch {
    return base;
  }
}
