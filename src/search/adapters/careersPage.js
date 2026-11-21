/**
 * Company careers-page discovery (public, compliant).
 *
 * Discovers jobs for a configured list of companies using ONLY public surfaces:
 *
 *   1. ATS-typed entries delegate to the existing official-API adapters:
 *        { ats: 'greenhouse', slug }                       -> greenhouse adapter
 *        { ats: 'lever', slug }                            -> lever adapter
 *        { ats: 'workday', host, tenant, site, ... }       -> workday CXS adapter
 *   2. { careersUrl } : fetch the public careers/listing page, extract job-posting
 *        links, and parse each via the public JSON-LD reader.
 *   3. { sitemap } : fetch a public sitemap.xml (or sitemap index), keep job-like
 *        <loc> URLs, and parse each via the public JSON-LD reader.
 *
 * Hard safety rules:
 *   - Public pages only. No login, no CAPTCHA solving, no private endpoints.
 *   - If a fetch returns 401/403/429 or a challenge page, it is treated as
 *     BLOCKED: the entry is logged and SKIPPED. We never attempt to bypass it.
 *   - Per-company link/URL caps prevent runaway crawls.
 */

import { fetchUrl } from './genericPublicPage.js';
import * as greenhouse from './greenhouse.js';
import * as lever from './lever.js';
import * as workday from './workday.js';
import * as ashby from './ashby.js';
import * as smartrecruiters from './smartrecruiters.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout, discoveryHeaders } from '../../utils/httpClient.js';
import { safeFetch } from '../../utils/safeFetch.js';
import { normalizeJob, makeJobId, htmlToText } from '../normalize.js';
import { jobFromCachedDetail } from '../detailBudget.js';
import { profileVocabularyFor, titleFitPriority } from '../../scoring/profileFit.js';
import { passesUsOnlyGate } from '../../scoring/exclusionFilter.js';

export const adapterId = 'careers';

/** Default and hard ceiling on links fetched per company from a careers PAGE. */
const DEFAULT_MAX_LINKS = 50;
const MAX_LINKS_CEILING = 200;
/**
 * Sitemap strategy: pages fetched per company per run, counted AFTER the slug
 * filter and AFTER skipping pages already judged (audit D3). The old cap took
 * the first 50 URLs in file order, so Meta (thousands of postings) yielded 50
 * arbitrary, mostly foreign or unrelated pages. Filtered first, 150 covers a
 * large employer's relevant backlog in one or two runs.
 */
const DEFAULT_SITEMAP_MAX_FETCHES = 150;
const SITEMAP_MAX_FETCHES_CEILING = 500;
/**
 * Minimum `titleFitPriority` of a URL's slug to be worth a page fetch. 2 = the
 * slug names a profile technology or role. Measured on Microsoft's sitemap
 * (2,446 URLs): level >= 2 left 55 pages, including "senior data engineer
 * united states washington redmond"; 1,026 slugs were outright rejects.
 * A company entry can override it with `minTitleFit`.
 */
const DEFAULT_SLUG_MIN_FIT = 2;
/** How many nested sitemaps from a sitemap index we will follow (one level). */
const MAX_NESTED_SITEMAPS = 25;
/** Default number of companies processed in parallel. */
const DEFAULT_COMPANY_CONCURRENCY = 6;
/** Default number of posting URLs parsed in parallel within one company. */
const DEFAULT_LINK_CONCURRENCY = 4;

/**
 * @param {object} source jobboards entry: { companies: object[], maxLinksPerCompany?: number }
 * @param {object} ctx adapter context (fetchImpl, rateLimiter, maxRetries)
 * @returns {Promise<{ jobs: object[], errors: Array<object>, cancelled: boolean }>}
 */
export async function run(source = {}, ctx = {}) {
  const companies = Array.isArray(source.companies) ? source.companies : [];
  const maxLinks = clampInt(source.maxLinksPerCompany, DEFAULT_MAX_LINKS, MAX_LINKS_CEILING);
  const concurrency = ctx.boardConcurrency ?? DEFAULT_COMPANY_CONCURRENCY;
  const jobs = [];
  const errors = [];
  let cancelled = false;

  // Companies are independent public sites, so they run in parallel (bounded)
  // like every other adapter. This used to be a sequential `for...of`, which
  // made the source unusably slow at any real list size — and it is the source
  // the harvester grows to hundreds of entries. The shared host gate in ctx is
  // what keeps the fan-out polite.
  const perCompany = await mapWithConcurrency(companies, concurrency, async (company) => {
    if (ctx.shouldCancel?.()) { cancelled = true; return null; }
    try {
      return await runCompany(company, source, ctx, maxLinks);
    } catch (err) {
      // A single company must never crash discovery for the rest.
      return { jobs: [], errors: [{ company: companyLabel(company), error: err.message }] };
    }
  });

  for (const r of perCompany) {
    if (!r) continue;
    jobs.push(...r.jobs);
    errors.push(...r.errors);
  }

  if (companies.length === 0) {
    errors.push({
      note: 'careers source enabled but no companies configured. Add entries to ' +
        '`companies` like { ats: "greenhouse", slug: "acme" } or { careersUrl: "..." } ' +
        'or { sitemap: "https://company.com/sitemap.xml" }.',
    });
  }

  return { jobs, errors, cancelled };
}

/** Discover one company entry by its declared (or inferred) strategy. */
async function runCompany(company = {}, source, ctx, maxLinks) {
  const ats = String(company.ats ?? '').trim().toLowerCase();

  // 1. Delegate ATS-typed entries to the official-API adapters (reuse + reliable).
  if (ats === 'greenhouse') {
    return tagDelegated(await greenhouse.run(
      { boards: [company.slug ?? company.token].filter(Boolean), rateLimitMs: source.rateLimitMs },
      ctx,
    ), company);
  }
  if (ats === 'lever') {
    return tagDelegated(await lever.run(
      { boards: [company.slug].filter(Boolean), rateLimitMs: source.rateLimitMs },
      ctx,
    ), company);
  }
  if (ats === 'workday') {
    return tagDelegated(await workday.run(
      {
        tenants: [{
          host: company.host,
          tenant: company.tenant ?? company.slug,
          site: company.site,
          locale: company.locale,
          pageSize: company.pageSize,
          searchText: company.searchText,
        }],
        rateLimitMs: source.rateLimitMs,
      },
      ctx,
    ), company);
  }
  // Ashby and SmartRecruiters have official public board APIs and adapters too;
  // omitting them here forced those companies down the HTML-scraping path for
  // no reason.
  if (ats === 'ashby') {
    return tagDelegated(await ashby.run(
      { boards: [company.slug ?? company.token].filter(Boolean), rateLimitMs: source.rateLimitMs },
      ctx,
    ), company);
  }
  if (ats === 'smartrecruiters') {
    return tagDelegated(await smartrecruiters.run(
      { boards: [company.slug ?? company.token].filter(Boolean), rateLimitMs: source.rateLimitMs },
      ctx,
    ), company);
  }

  // 2. Public careers/listing page -> extract links -> parse each.
  if (company.careersUrl) {
    return fromCareersPage(company, source, ctx, maxLinks);
  }

  // 3. Public sitemap.xml -> job-like locs -> parse each.
  if (company.sitemap) {
    return fromSitemap(company, source, ctx, maxLinks);
  }

  return { jobs: [], errors: [{ company: companyLabel(company), error: 'no ats/careersUrl/sitemap specified' }] };
}

/** Strategy 2: scrape job links off a public careers page, then parse each. */
async function fromCareersPage(company, source, ctx, maxLinks) {
  const { fetchImpl = safeFetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const errors = [];

  if (rateLimiter) await rateLimiter.wait('careers', source.rateLimitMs);
  const page = await fetchPage(company.careersUrl, { fetchImpl, maxRetries, requestTimeoutMs, hostGate });
  if (page.blocked) {
    return { jobs: [], errors: [{ company: companyLabel(company), url: company.careersUrl, error: `blocked (${page.reason}); skipped` }] };
  }
  if (page.error) {
    return { jobs: [], errors: [{ company: companyLabel(company), url: company.careersUrl, error: page.error }] };
  }

  const links = extractJobLinks(page.html, company.careersUrl, maxLinks);
  if (links.length === 0) {
    errors.push({ company: companyLabel(company), url: company.careersUrl, note: 'no job-like links found on careers page' });
  }
  const jobs = await parseLinks(links, company, source, ctx, errors);
  return { jobs, errors };
}

/**
 * Strategy 3: read a public sitemap (or sitemap index), keep the job URLs worth
 * reading, then parse each (audit D3, D4).
 *
 *   1. every job-like `<loc>` with its `<lastmod>` (one nested level followed);
 *   2. slug filter: the words in each URL (most career sites put the title and
 *      often the city there) must fit the profile, and must not place the job
 *      outside the US when the US-only gate is on. Costs nothing: no page fetch;
 *   3. newest `<lastmod>` first;
 *   4. pages already stored are not re-bought: a row with a description is
 *      rebuilt from the store (it stays "listed" for the expiry pass), a
 *      discarded row is skipped;
 *   5. the per-company budget applies to what is left;
 *   6. an undated posting whose URL is new since the previous crawl is dated
 *      by this crawl (`postedAtSource: 'first_seen'`); see sitemapSeen.js.
 */
async function fromSitemap(company, source, ctx, _careersPageMaxLinks) {
  const { fetchImpl = safeFetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const errors = [];
  const label = companyLabel(company);

  if (rateLimiter) await rateLimiter.wait('careers', source.rateLimitMs);
  const root = await fetchPage(company.sitemap, { fetchImpl, maxRetries, requestTimeoutMs, hostGate });
  if (root.blocked) {
    return { jobs: [], errors: [{ company: label, url: company.sitemap, error: `blocked (${root.reason}); skipped` }] };
  }
  if (root.error) {
    return { jobs: [], errors: [{ company: label, url: company.sitemap, error: root.error }] };
  }

  let entries = [];
  let complete = true;
  if (isSitemapIndex(root.html)) {
    const nested = extractLocs(root.html).slice(0, MAX_NESTED_SITEMAPS);
    for (const sm of nested) {
      if (rateLimiter) await rateLimiter.wait('careers', source.rateLimitMs);
      const child = await fetchPage(sm, { fetchImpl, maxRetries, requestTimeoutMs, hostGate });
      if (child.blocked || child.error) {
        complete = false;
        errors.push({ company: label, url: sm, error: child.blocked ? `blocked (${child.reason}); skipped` : child.error });
        continue;
      }
      entries.push(...extractSitemapEntries(child.html));
    }
  } else {
    entries = extractSitemapEntries(root.html);
  }
  // A site whose posting URLs carry none of the generic hints (Apple's are
  // /details/{id}/{slug}) names its own pattern with `jobUrlPattern`.
  const isPosting = company.jobUrlPattern ? safePattern(company.jobUrlPattern) : isJobLikeUrl;
  entries = entries.filter((e) => isPosting(e.loc));
  if (entries.length === 0) {
    errors.push({ company: label, url: company.sitemap, note: 'no job-like URLs found in sitemap' });
    return { jobs: [], errors };
  }

  const vocab = ctx.candidate ? profileVocabularyFor(ctx.candidate) : null;
  const plan = planSitemapUrls(entries, {
    vocab,
    geography: ctx.geography ?? null,
    minTitleFit: Number.isFinite(company.minTitleFit) ? company.minTitleFit : DEFAULT_SLUG_MIN_FIT,
    maxFetches: clampInt(company.maxLinks ?? source.maxSitemapFetchesPerCompany, DEFAULT_SITEMAP_MAX_FETCHES, SITEMAP_MAX_FETCHES_CEILING),
    known: (url) => ctx.detailCache?.knownUrl?.(url, 'careers') ?? null,
    cached: (url) => ctx.detailCache?.byUrl?.(url, 'careers') ?? null,
  });

  // First-seen dating needs the previous crawl, read BEFORE recording this one.
  const seen = ctx.sitemapSeen ?? null;
  const previous = seen?.previous(company.sitemap) ?? null;
  if (seen && complete) seen.record(company.sitemap, plan.relevant, new Date(ctx.now?.() ?? Date.now()));

  const jobs = [];
  for (const { url, cached } of plan.reuse) {
    const job = jobFromCachedDetail(cached, {
      source: 'careers', url, rawMetadata: { company: company.name ?? cached.company, via: 'careers', sitemap: true },
    });
    if (job) jobs.push(job);
  }
  const fetched = company.detail === 'apple'
    ? await parseAppleDetails(plan.fetch, company, source, ctx, errors)
    : await parseLinks(plan.fetch, company, source, ctx, errors);
  const crawledAt = new Date(ctx.now?.() ?? Date.now()).toISOString();
  for (const job of fetched) {
    job.rawMetadata = { ...(job.rawMetadata ?? {}), sitemap: true };
    if (!job.postedAt && previous && !previous.has(job.url)) {
      job.postedAt = crawledAt;
      job.rawMetadata.postedAtSource = 'first_seen';
      job.rawMetadata.postedAtApprox = true;
    }
    jobs.push(job);
  }

  const c = plan.counts;
  errors.push({
    company: label,
    note: `sitemap: ${c.total} job URLs; ${c.offTarget} off-profile and ${c.abroad} outside the US skipped by slug; `
      + `${c.alreadyJudged} already judged, ${plan.reuse.length} reused from the store; fetched ${plan.fetch.length}`
      + (c.overBudget ? `; ${c.overBudget} relevant page(s) left for the next run (budget ${c.budget})` : ''),
    degraded: c.overBudget > 0,
  });
  return { jobs, errors };
}

/**
 * Decide which sitemap URLs to fetch, reuse or skip. Pure.
 *
 * @param {Array<{loc: string, lastmod?: string|null}>} entries job-like entries
 * @param {object} opts
 * @param {object|null} opts.vocab profile vocabulary; null disables the fit filter
 * @param {object|null} opts.geography exclusions.geography
 * @param {number} opts.minTitleFit
 * @param {number} opts.maxFetches
 * @param {(url: string) => ({status?: string}|null)} [opts.known]
 * @param {(url: string) => (object|null)} [opts.cached]
 * @returns {{fetch: string[], reuse: Array<{url: string, cached: object}>, relevant: string[],
 *   counts: {total: number, offTarget: number, abroad: number, alreadyJudged: number, overBudget: number, budget: number}}}
 */
export function planSitemapUrls(entries, {
  vocab = null, geography = null, minTitleFit = DEFAULT_SLUG_MIN_FIT, maxFetches = DEFAULT_SITEMAP_MAX_FETCHES,
  known = () => null, cached = () => null,
} = {}) {
  const counts = { total: 0, offTarget: 0, abroad: 0, alreadyJudged: 0, overBudget: 0, budget: maxFetches };
  const unique = [];
  const seen = new Set();
  for (const e of entries) {
    const url = String(e?.loc ?? '').split('#')[0];
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({ url, lastmod: Date.parse(e.lastmod ?? '') || 0, order: unique.length });
  }
  counts.total = unique.length;

  const relevant = [];
  for (const item of unique) {
    const words = slugText(item.url);
    // A URL with no words (an id-only path) cannot be judged by its slug; it
    // is kept and left to the page itself.
    const fit = words && vocab ? titleFitPriority(words, vocab) : minTitleFit;
    if (fit < minTitleFit) { counts.offTarget += 1; continue; }
    if (words && geography?.usOnly === true && !passesUsOnlyGate({ location: words }, geography)) { counts.abroad += 1; continue; }
    relevant.push({ ...item, fit });
  }
  // Best title fit first, then newest. Newest-only spent Microsoft's whole
  // budget on "Azure"-mention roles (fit 2) while "Senior Data Engineer"
  // (fit 4) waited for the next run (measured live, 2026-11-20).
  relevant.sort((a, b) => (b.fit - a.fit) || (b.lastmod - a.lastmod) || (a.order - b.order));

  const fetch = [];
  const reuse = [];
  for (const { url } of relevant) {
    const stored = known(url);
    if (stored?.status === 'discarded') { counts.alreadyJudged += 1; continue; }
    if (stored) {
      const hit = cached(url);
      if (hit) { reuse.push({ url, cached: hit }); continue; }
      // An ACTIVE row with no stored description (needs_description, or one
      // re-admitted by `npm run rejudge-stale`): read the page again, or it
      // would never be judged and the expiry pass would retire it unread.
    }
    if (fetch.length < maxFetches) fetch.push(url);
    else counts.overBudget += 1;
  }
  return { fetch, reuse, relevant: relevant.map((r) => r.url), counts };
}

/** Path segments that carry no title words. */
const GENERIC_SEGMENTS = new Set([
  'job', 'jobs', 'careers', 'career', 'details', 'detail', 'posting', 'postings', 'position', 'positions',
  'opening', 'openings', 'apply', 'en', 'search', 'view', 'requisition', 'vacancy', 'vacancies',
]);

/**
 * The words a posting URL carries, for the slug filter: title and often city.
 * "/careers/job/1970393557072567-senior-data-engineer-united-states-washington-redmond"
 *   -> "senior data engineer united states washington redmond".
 *
 * @param {string} url
 * @returns {string} lowercase words, '' when the path holds only ids
 */
export function slugText(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return ''; }
  const words = [];
  for (const raw of path.split('/')) {
    let seg;
    try { seg = decodeURIComponent(raw); } catch { seg = raw; }
    seg = seg.toLowerCase().replace(/\.(html?|aspx?|php)$/, '');
    if (!seg || GENERIC_SEGMENTS.has(seg) || /^[a-z]{2}([-_][a-z]{2})?$/.test(seg)) continue;
    const text = seg.replace(/^[\d-]+(?=[a-z])/, '').replace(/[-_+,.&()%]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || !/[a-z]{3}/.test(text)) continue;
    words.push(text);
  }
  return words.join(' ');
}

/** A URL predicate from a configured regex string; a bad pattern matches nothing. */
function safePattern(source) {
  try {
    const re = new RegExp(String(source), 'i');
    return (url) => re.test(String(url ?? ''));
  } catch {
    return () => false;
  }
}

/** `<url>` entries of a sitemap with their `<lastmod>`, falling back to bare `<loc>`s. */
export function extractSitemapEntries(xml) {
  const text = String(xml ?? '');
  const out = [];
  const re = /<url>([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const loc = /<loc>\s*([^<]+?)\s*<\/loc>/i.exec(m[1]);
    if (!loc) continue;
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(m[1]);
    out.push({ loc: decodeXmlEntities(loc[1].trim()), lastmod: lastmod ? lastmod[1].trim() : null });
  }
  if (out.length) return out;
  return extractLocs(text).map((loc) => ({ loc, lastmod: null }));
}

/**
 * Apple's job pages render client-side and carry no JSON-LD, but each posting
 * has a public JSON detail at /api/v1/jobDetails/{jobNumber} — the same data
 * the page itself loads (verified 2026-11-20; no key, cookie or token). The
 * job number is the path segment after /details/.
 */
async function parseAppleDetails(urls, company, source, ctx, errors) {
  const { fetchImpl = safeFetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const concurrency = ctx.detailConcurrency ?? DEFAULT_LINK_CONCURRENCY;
  const out = await mapWithConcurrency(urls, concurrency, async (url) => {
    if (ctx.shouldCancel?.()) return null;
    const m = /\/details\/([^/]+)/.exec(url);
    if (!m) return null;
    const api = `${new URL(url).origin}/api/v1/jobDetails/${encodeURIComponent(m[1])}`;
    try {
      if (rateLimiter) await rateLimiter.wait('careers', source.rateLimitMs);
      const page = await fetchPage(api, { fetchImpl, maxRetries, requestTimeoutMs, hostGate });
      if (page.blocked || page.error) {
        errors.push({ company: companyLabel(company), url, error: page.blocked ? `blocked (${page.reason}); skipped` : page.error });
        return null;
      }
      return appleJobFromDetail(JSON.parse(page.html)?.res, { url, company: company.name ?? 'Apple' });
    } catch (err) {
      errors.push({ company: companyLabel(company), url, error: err.message });
      return null;
    }
  });
  return out.filter(Boolean);
}

/**
 * Normalize one Apple `jobDetails` payload. Exported for tests.
 * @param {object} res the `res` object of the response
 * @param {{url: string, company: string}} meta
 * @returns {object|null}
 */
export function appleJobFromDetail(res, { url, company }) {
  if (!res?.postingTitle) return null;
  const places = (Array.isArray(res.locations) ? res.locations : []).map((l) => [
    l?.name, l?.stateProvince && !String(l?.name ?? '').includes(l.stateProvince) ? l.stateProvince : null, l?.countryName,
  ].filter(Boolean).join(', ')).filter(Boolean);
  const sections = [
    res.jobSummary, res.description, res.responsibilities,
    res.minimumQualifications && `Minimum qualifications:\n${res.minimumQualifications}`,
    res.preferredQualifications && `Preferred qualifications:\n${res.preferredQualifications}`,
  ].filter(Boolean).join('\n\n');
  return normalizeJob({
    source: 'careers',
    company,
    title: res.postingTitle,
    location: places.join('; ') + (String(res.homeOffice) === 'true' ? (places.length ? '; Remote' : 'Remote') : ''),
    url,
    sourceJobId: res.jobNumber ?? res.reqId ?? '',
    postedAt: res.postDateInGMT ?? null,
    jdText: htmlToText(sections).slice(0, 20000),
    employmentType: res.employmentType === 'Standard' ? 'Full-time' : String(res.employmentType ?? ''),
    rawMetadata: { company, via: 'careers', detail: 'apple' },
  });
}

/** Parse a list of public posting URLs via the JSON-LD reader, tagging company. */
async function parseLinks(urls, company, source, ctx, errors) {
  const { fetchImpl = safeFetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const concurrency = ctx.detailConcurrency ?? DEFAULT_LINK_CONCURRENCY;
  const jobs = [];

  const perUrl = await mapWithConcurrency(urls, concurrency, async (url) => {
    if (ctx.shouldCancel?.()) return null;
    try {
      if (rateLimiter) await rateLimiter.wait('careers', source.rateLimitMs);
      const found = await fetchUrl(url, {
        fetchImpl, source: 'careers', maxRetries, requestTimeoutMs, hostGate,
      });
      for (const job of found) ensureCareersIdentity(job, { url, companyName: company.name });
      return { jobs: found, error: null };
    } catch (err) {
      // One posting that is gone (a sitemap still listing a filled job, e.g.
      // Costco's /jobs/67627) is not a source failure: it was reported as
      // "missing config — run npm run doctor" on every run. Keep it as a note.
      const status = Number(err?.status ?? err?.statusCode);
      if (status === 404 || status === 410) {
        return { jobs: [], error: { company: companyLabel(company), url, note: `posting no longer exists (HTTP ${status}); skipped` } };
      }
      return { jobs: [], error: { company: companyLabel(company), url, error: err.message } };
    }
  });

  for (const r of perUrl) {
    if (!r) continue;
    jobs.push(...r.jobs);
    if (r.error) errors.push(r.error);
  }
  return jobs;
}

/**
 * Give a careers-page job a stable, unique identity (in place).
 *
 * REGRESSION GUARD. The id is computed inside normalizeJob from company + title
 * + sourceJobId, and pages without JSON-LD arrive with no company, no posting
 * id and the page <title> as their title. On the live store every Wipro job had
 * the id "careers:job details wipro limited", so each posting overwrote the
 * last; Costco postings with the same title at different warehouses did the
 * same. The posting URL is unique, so it supplies the id when the page did not.
 */
export function ensureCareersIdentity(job, { url, companyName }) {
  job.rawMetadata = { ...(job.rawMetadata ?? {}), company: companyName ?? job.company, via: 'careers' };
  let changed = false;
  if (!job.company && companyName) { job.company = companyName; changed = true; }
  const cleaned = cleanPageTitle(job.title, job.company || companyName);
  if (job.title && cleaned !== job.title) { job.title = cleaned; changed = true; }
  if (!job.title) {
    const words = slugText(url);
    if (words) { job.title = words.replace(/\b[a-z]/g, (c) => c.toUpperCase()); changed = true; }
  }
  if (!job.sourceJobId) { job.sourceJobId = postingIdFromUrl(url); changed = true; }
  // The page we fetched IS the posting. A JSON-LD `url` can name another page
  // (an apply link, a canonical on another host); keeping the fetched URL lets
  // the next run recognize the page as already judged (knownUrl) and lets the
  // sitemap memory match it.
  if (url) {
    if (job.url && job.url !== url) job.rawMetadata.jsonLdUrl = job.url;
    job.url = url;
  }
  if (changed) job.id = makeJobId(job);
  return job;
}

/** Strip " Job Details | Company" style suffixes a page <title> carries. */
export function cleanPageTitle(title, companyName = '') {
  let t = String(title ?? '').trim();
  if (!t) return '';
  const company = String(companyName ?? '').trim().toLowerCase();
  // "Title | Company", "Title – Careers at Company". A plain hyphen is NOT a
  // separator: it is part of titles ("ABL - Service Manager").
  const parts = t.split(/\s+[|–—]\s+/);
  if (parts.length > 1) {
    const tail = parts[parts.length - 1].toLowerCase();
    if ((company && tail.includes(company.split(/\s+/)[0])) || /careers?|jobs?/.test(tail)) t = parts.slice(0, -1).join(' | ');
  }
  t = t.replace(/\s*(job details|job detail|detalles del puesto|détails de l'offre|stellenangebot|careers?)\s*$/i, '').trim();
  return /^(job details?|careers?|jobs?)$/i.test(t) ? '' : t;
}

/** A stable per-posting id from its URL: the last long number, else the path. */
export function postingIdFromUrl(url) {
  try {
    const u = new URL(url);
    const nums = (u.pathname.match(/\d{5,}/g) ?? []);
    if (nums.length) return nums[nums.length - 1];
    return `${u.hostname}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    return String(url ?? '');
  }
}

/** Stamp delegated ATS results with the careers provenance (source unchanged). */
function tagDelegated(result, company) {
  const jobs = (result.jobs ?? []).map((job) => ({
    ...job,
    rawMetadata: { ...(job.rawMetadata ?? {}), via: 'careers', careersCompany: company.name ?? null },
  }));
  return { jobs, errors: result.errors ?? [] };
}

/**
 * Fetch a page's raw text, classifying common blocks instead of bypassing them.
 *
 * Carries the same request timeout and host gate as every other adapter: this
 * one visits arbitrary company domains, so it is the likeliest to meet a server
 * that accepts a connection and then never responds, and a hang here used to
 * stall the entire discovery run.
 *
 * @returns {Promise<{ html?: string, blocked?: boolean, reason?: string, error?: string }>}
 */
async function fetchPage(url, { fetchImpl, maxRetries, requestTimeoutMs, hostGate }) {
  const call = async () => {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { headers: discoveryHeaders({ Accept: 'text/html,application/xhtml+xml,application/xml' }) },
      requestTimeoutMs,
    );
    const status = res.status ?? 200;
    const body = await res.text();
    const reason = blockReason(status, body);
    if (reason) {
      // Do NOT retry or evade a block — surface it and stop for this URL.
      return { blocked: true, reason };
    }
    if (!res.ok) {
      const e = new Error(`HTTP ${status} for ${url}`);
      e.status = status;
      throw e;
    }
    return { html: body };
  };
  try {
    return await withRetry(
      () => (hostGate ? hostGate.run(url, call) : call()),
      { maxRetries },
    );
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Return a short reason string if a response looks like a login/CAPTCHA/bot
 * block, else null. Detection only — we never try to defeat these.
 * @param {number} status
 * @param {string} body
 * @returns {string|null}
 */
export function blockReason(status, body = '') {
  if (status === 401) return 'http-401-unauthorized';
  if (status === 403) return 'http-403-forbidden';
  if (status === 429) return 'http-429-rate-limited';
  const b = String(body).toLowerCase();
  const markers = [
    ['captcha', 'captcha'],
    ['recaptcha', 'recaptcha'],
    ['hcaptcha', 'hcaptcha'],
    ['cf-challenge', 'cloudflare-challenge'],
    ['attention required', 'cloudflare-challenge'],
    ['verify you are human', 'human-verification'],
    ['are you a robot', 'human-verification'],
    ['enable javascript and cookies to continue', 'js-challenge'],
    ['access denied', 'access-denied'],
    ['please log in', 'login-wall'],
    ['sign in to continue', 'login-wall'],
  ];
  for (const [needle, reason] of markers) {
    if (b.includes(needle)) return reason;
  }
  return null;
}

/** Path/host fragments that strongly suggest a single job posting URL. */
const JOB_URL_HOST_HINTS = [
  'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'icims.com',
  'smartrecruiters.com', 'jobvite.com', 'ashbyhq.com',
];
// Deliberately excludes bare '/career'/'/careers/' — too generic, it matches
// marketing/landing pages (e.g. ".../pages/careers/topics/careers.html") that
// carry no posting. Every real hint here names something specific to an
// individual job page.
const JOB_URL_PATH_HINTS = [
  '/job/', '/jobs/', '/position', '/opening',
  '/vacancy', '/vacancies', '/req', 'gh_jid', 'jobid', 'requisition', '/apply',
  '/postings/', '/posting/', 'job_details', 'job-details', 'jobdetail',
];

/**
 * Decide if a URL looks like an individual job posting (heuristic, conservative).
 * @param {string} url
 * @returns {boolean}
 */
export function isJobLikeUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  const host = parsed.host.toLowerCase();
  const lowerPath = (parsed.pathname + parsed.search).toLowerCase();
  if (JOB_URL_HOST_HINTS.some((h) => host.includes(h))) return true;
  return JOB_URL_PATH_HINTS.some((p) => lowerPath.includes(p));
}

/**
 * Extract distinct job-like links from careers-page HTML, resolved to absolute
 * URLs against the page's own URL.
 * @param {string} html
 * @param {string} baseUrl
 * @param {number} maxLinks
 * @returns {string[]}
 */
export function extractJobLinks(html, baseUrl, maxLinks = DEFAULT_MAX_LINKS) {
  if (!html) return [];
  const out = [];
  const seen = new Set();
  // A listing page commonly links back to ITSELF with different search/filter
  // query params (pagination, sort, facets). Same path + different query is
  // never a distinct job posting, so it is excluded regardless of query string
  // — without this, a search-results page's own filter links get scraped as
  // if each one were a separate job.
  let basePath = null;
  try {
    const b = new URL(baseUrl);
    basePath = `${b.origin}${b.pathname.replace(/\/+$/, '')}`;
  } catch { /* leave null; nothing to compare against */ }
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('javascript:')) continue;
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      continue;
    }
    if (!isJobLikeUrl(abs)) continue;
    const norm = abs.split('#')[0];
    if (seen.has(norm)) continue;
    if (basePath) {
      const candidatePath = `${new URL(norm).origin}${new URL(norm).pathname.replace(/\/+$/, '')}`;
      if (candidatePath === basePath) continue;
    }
    seen.add(norm);
    out.push(norm);
    if (out.length >= maxLinks) break;
  }
  return out;
}

/** Extract all <loc> URLs from sitemap XML. */
export function extractLocs(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const url = decodeXmlEntities(m[1].trim());
    if (url) out.push(url);
  }
  return out;
}

/** True if the XML is a sitemap index (points at other sitemaps). */
export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(String(xml ?? ''));
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function companyLabel(company) {
  return company?.name ?? company?.slug ?? company?.tenant ?? company?.careersUrl ?? company?.sitemap ?? null;
}

function clampInt(value, fallback, ceiling) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), ceiling);
}
