/**
 * Oracle Fusion Recruiting Cloud (ORC) connector — the public "Candidate
 * Experience" REST API that an ORC career site calls to render itself.
 *
 *   list   GET {host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions
 *            ?onlyData=true&expand=requisitionList
 *            &finder=findReqs;siteNumber={site},limit={n},offset={n}
 *   detail GET {host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
 *            ?expand=all&onlyData=true&finder=ById;Id="{id}",siteNumber={site}
 *
 * Same posture as the Greenhouse/Lever/Ashby/Workday feeds already here: no key,
 * no login, no cookie, no scraping, no evasion, identifying User-Agent on every
 * request. Verified unauthenticated — the API answers 200 with no headers at all.
 *
 * WHY THIS ADAPTER EXISTS. ORC is a whole ATS family this codebase previously
 * could not read, and it hosts employers whose careers sites are otherwise
 * opaque JS shells with no sitemap and no JSON-LD. Oracle itself (~2.3k reqs)
 * and JPMorgan Chase (~7.4k reqs) were both recorded as "no public feed" until
 * this endpoint was found. It is per-TENANT, not per-company: one entry in
 * `tenants` covers an employer forever, and the shape is identical across
 * tenants, so adding the next ORC employer is a config line, never new code.
 *
 * FOUR NON-OBVIOUS THINGS ABOUT THIS API, each of which silently corrupts
 * results if you get it wrong:
 *
 *  1. `expand=requisitionList` is MANDATORY. Without it the response still
 *     returns 200 but carries only search metadata and facets — no jobs key at
 *     all. Dropping it looks like "this tenant has no openings".
 *  2. The jobs live at `items[0].requisitionList`, and the total at
 *     `items[0].TotalJobsCount`. The OUTER envelope's `count`/`hasMore`/`limit`
 *     describe the single search-result object (`count:1, hasMore:false`), not
 *     the jobs. Driving pagination off the outer `hasMore` stops after one page
 *     and quietly returns 25 of 7,397 postings.
 *  3. `limit` and `offset` go INSIDE the `finder=findReqs;...` string, comma
 *     separated — not as sibling query params. `limit` is capped at 200 server
 *     side; asking for 500 silently returns 200.
 *  4. `siteNumber` is NOT validated. A wrong or invented value falls back to the
 *     tenant's default external site and returns plausible data, so a 200 is
 *     never proof the site number was right. Verify a tenant's number against
 *     its own careers page (the HTML carries `sitenumber="CX_…"`) rather than
 *     trusting that results came back.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout, httpError, discoveryHeaders } from '../../utils/httpClient.js';
import { makeTitleGate, makeAgeGate } from './atsSearch.js';
import { searchTermsFor } from './workday.js';
import { buildProfileVocabulary, titleFitPriority } from '../../scoring/profileFit.js';

export const adapterId = 'oracleRecruiting';

/** Server-side ceiling on `limit`. Asking for more silently returns this many. */
const MAX_PAGE_SIZE = 200;

/** Hard runaway guard on pagination, independent of any configured preference. */
const MAX_PAGES = 50;

/** Tenants fetched in parallel when ctx omits a ceiling. */
const DEFAULT_TENANT_CONCURRENCY = 4;

/** List pages fetched in parallel per tenant when ctx omits a ceiling. */
const DEFAULT_PAGE_CONCURRENCY = 4;

/** Detail requests in flight per tenant when ctx omits a ceiling. */
const DEFAULT_DETAIL_CONCURRENCY = 4;

/**
 * Full-description budget per tenant.
 *
 * The list response carries only `ShortDescriptionStr`, a one-to-three sentence
 * teaser, so a full JD costs one extra request. The title gate runs first and
 * normally keeps this small; this is the backstop for a tenant whose titles
 * defeat the gate.
 */
const DEFAULT_MAX_DETAIL_FETCHES = 25;

/**
 * @param {object} source jobboards entry
 * @param {object[]} source.tenants `{ host, siteNumber, company, keywords?, maxPagesPerTerm? }`
 * @param {object} [source.options]
 * @param {string[]} [source.options.titles] overrides candidate.targetTitles
 * @param {boolean} [source.options.strictTitleMatch=true]
 * @param {number} [source.options.maxDetailFetches]
 * @param {number} [source.options.maxAgeDays]
 * @param {string[]} [source.options.keywords] global keyword override
 * @param {object} ctx adapter context
 * @returns {Promise<{ jobs: object[], errors: object[], cancelled: boolean }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, hostGate, maxRetries = 3, requestTimeoutMs } = ctx;
  const options = source.options ?? {};
  const tenants = Array.isArray(source.tenants) ? source.tenants : [];
  const tenantConcurrency = source.boardConcurrency ?? ctx.boardConcurrency ?? DEFAULT_TENANT_CONCURRENCY;
  const pageConcurrency = ctx.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY;
  const detailConcurrency = ctx.detailConcurrency ?? DEFAULT_DETAIL_CONCURRENCY;
  const maxDetailFetches = Number.isFinite(options.maxDetailFetches)
    ? Math.max(0, options.maxDetailFetches)
    : DEFAULT_MAX_DETAIL_FETCHES;

  const titleGate = makeTitleGate({
    titles: options.titles ?? ctx.candidate?.targetTitles ?? [],
    strict: options.strictTitleMatch !== false,
    candidate: ctx.candidate ?? null,
  });
  const ageGate = makeAgeGate(options.maxAgeDays);

  // The `keyword` finder param narrows server side, which matters here: a tenant
  // like JPMorgan carries ~7,400 reqs and enumerating all of them is 37 requests
  // for a handful of relevant rows. Phrases are derived from the candidate's own
  // target titles by the same minimal-set-cover used for Workday, so the profile
  // stays the single source of truth. An empty list means "enumerate everything".
  const defaultKeywords = Array.isArray(options.keywords)
    ? options.keywords.map((k) => String(k ?? '').trim()).filter(Boolean)
    : searchTermsFor(ctx.candidate, options.maxSearchTerms);

  const jobs = [];
  const errors = [];
  let cancelled = false;

  const perTenant = await mapWithConcurrency(tenants, tenantConcurrency, async (tenant) => {
    if (ctx.shouldCancel?.()) return { jobs: [], errors: [], cancelled: true };
    const cfg = validateTenant(tenant, defaultKeywords);
    if (cfg.error) return { jobs: [], errors: [{ tenant: tenant?.host ?? null, error: cfg.error }] };
    try {
      return await fetchTenant(cfg, {
        fetchImpl, rateLimiter, hostGate, maxRetries, requestTimeoutMs,
        rateLimitMs: source.rateLimitMs, pageConcurrency, detailConcurrency,
        maxDetailFetches, titleGate, ageGate, shouldCancel: ctx.shouldCancel,
        vocab: ctx.candidate ? buildProfileVocabulary(ctx.candidate) : null,
      });
    } catch (err) {
      return {
        jobs: [],
        errors: [{
          tenant: cfg.host, site: cfg.siteNumber, error: err.message,
          status: err.status ?? null, attempts: err.attempts ?? 0,
        }],
      };
    }
  });

  for (const r of perTenant) {
    if (!r) continue;
    jobs.push(...(r.jobs ?? []));
    errors.push(...(r.errors ?? []));
    cancelled ||= r.cancelled === true;
  }

  if (tenants.length === 0) {
    errors.push({
      note: 'oracleRecruiting source enabled but no tenants configured. Add '
        + '{ host, siteNumber, company } entries to `tenants` — e.g. '
        + '{ host: "acme.fa.us2.oraclecloud.com", siteNumber: "CX_1001" }.',
    });
  }

  return { jobs, errors, cancelled };
}

/**
 * Validate and normalize one tenant entry.
 * @param {object} t raw config entry
 * @param {string[]} defaultKeywords phrases to search when the tenant names none
 */
export function validateTenant(t = {}, defaultKeywords = []) {
  const host = String(t.host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const siteNumber = String(t.siteNumber ?? t.site ?? '').trim();
  if (!host || !siteNumber) return { error: 'oracleRecruiting tenant requires host and siteNumber' };

  // An explicit per-tenant list wins; a deliberate empty array means "enumerate
  // everything" and must survive, so only an ABSENT key falls back to the
  // derived phrases.
  let keywords;
  if (Array.isArray(t.keywords)) keywords = t.keywords.map((k) => String(k ?? '').trim());
  else keywords = defaultKeywords.length ? [...defaultKeywords] : [''];

  return {
    host,
    siteNumber,
    company: String(t.company ?? t.name ?? '').trim() || host.split('.')[0],
    keywords: [...new Set(keywords)],
    pageSize: Number.isFinite(t.pageSize) && t.pageSize > 0
      ? Math.min(t.pageSize, MAX_PAGE_SIZE)
      : MAX_PAGE_SIZE,
    maxPagesPerTerm: Number.isFinite(t.maxPagesPerTerm)
      ? Math.min(MAX_PAGES, Math.max(1, Math.trunc(t.maxPagesPerTerm)))
      : MAX_PAGES,
    fetchDetails: t.fetchDetails !== false,
  };
}

/** Build the list-endpoint URL for one keyword/offset. */
export function listUrl(cfg, offset, keyword = '') {
  const finder = [
    'findReqs',
    `siteNumber=${cfg.siteNumber}`,
    `limit=${cfg.pageSize}`,
    `offset=${offset}`,
    'sortBy=POSTING_DATES_DESC',
    // Only send `keyword` when there is one — an empty keyword returns nothing
    // on some tenants rather than everything.
    ...(keyword ? [`keyword=${encodeURIComponent(keyword)}`] : []),
  ].join(',').replace('findReqs,', 'findReqs;');
  return `https://${cfg.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
    + `?onlyData=true&expand=requisitionList&finder=${finder}`;
}

/** Build the public, human-facing apply URL for a requisition. */
export function applyUrl(cfg, id) {
  return `https://${cfg.host}/hcmUI/CandidateExperience/en/sites/${cfg.siteNumber}/job/${encodeURIComponent(id)}`;
}

/** Page through one tenant, across each keyword, then enrich within budget. */
async function fetchTenant(cfg, ctx) {
  const {
    fetchImpl, rateLimiter, hostGate, maxRetries, requestTimeoutMs, rateLimitMs,
    pageConcurrency, detailConcurrency, maxDetailFetches, titleGate, ageGate, shouldCancel,
    // `vocab` is passed by the caller and read below to spend the detail budget
    // best-first. It was missing from this list, so the read was a free
    // variable: under ESM strict mode that is a ReferenceError, not `undefined`,
    // and it threw once per tenant AFTER the listings had been fetched — so the
    // whole source reported "vocab is not defined" and returned nothing, while
    // looking like a network-level failure.
    vocab,
  } = ctx;
  const errors = [];
  let cancelled = false;

  const request = async (url) => {
    if (rateLimiter) await rateLimiter.wait(`oracleRecruiting:${cfg.host}`, rateLimitMs);
    const call = () => fetchJson(fetchImpl, url, requestTimeoutMs);
    return withRetry(() => (hostGate ? hostGate.run(url, call) : call()), { maxRetries });
  };

  /** Walk every page for ONE keyword. */
  const fetchKeyword = async (keyword) => {
    const first = await request(listUrl(cfg, 0, keyword));
    const envelope = first?.items?.[0] ?? {};
    const firstRows = Array.isArray(envelope.requisitionList) ? envelope.requisitionList : [];
    // Read the total from the ENVELOPE, not the outer object — see header note 2.
    const total = Number.isFinite(envelope.TotalJobsCount) ? envelope.TotalJobsCount : firstRows.length;
    const pageCount = Math.min(cfg.maxPagesPerTerm, Math.max(1, Math.ceil(total / cfg.pageSize)));

    const offsets = [];
    for (let page = 1; page < pageCount; page += 1) offsets.push(page * cfg.pageSize);
    const rest = await mapWithConcurrency(offsets, pageConcurrency, async (offset) => {
      if (shouldCancel?.()) { cancelled = true; return { rows: [], error: null }; }
      try {
        const data = await request(listUrl(cfg, offset, keyword));
        const rows = data?.items?.[0]?.requisitionList;
        return { rows: Array.isArray(rows) ? rows : [], error: null };
      } catch (err) {
        if (err?.cancelled) { cancelled = true; return { rows: [], error: null }; }
        return {
          rows: [],
          error: {
            offset, keyword, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0,
          },
        };
      }
    });

    const found = [...firstRows];
    for (const r of rest) {
      if (!r) continue;
      found.push(...r.rows);
      if (r.error) errors.push(r.error);
    }
    return found;
  };

  // Each keyword is a separate search, so the same requisition comes back under
  // more than one. Dedupe on `Id` before spending any detail budget.
  const rows = [];
  const seen = new Set();
  for (const keyword of cfg.keywords) {
    if (shouldCancel?.()) { cancelled = true; break; }
    let found;
    try {
      found = await fetchKeyword(keyword);
    } catch (err) {
      if (err?.cancelled) { cancelled = true; break; }
      errors.push({
        keyword, error: err.message, status: err.status ?? null, attempts: err.attempts ?? 0,
      });
      continue;
    }
    for (const row of found) {
      const id = String(row?.Id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
    }
  }
  if (!rows.length && errors.length && errors.length >= cfg.keywords.length && cfg.keywords.length > 0) {
    throw Object.assign(new Error(errors[0].error), { status: errors[0].status });
  }

  // Gate on the list's own title and posting date before paying for details.
  const kept = rows.filter((row) => titleGate(row?.Title) && ageGate(row?.PostedDate ?? null));
  const out = kept.map((row) => mapJob(row, cfg));

  if (cfg.fetchDetails && maxDetailFetches > 0) {
    // Best-first, so the budget lands on the most likely fits.
    const ordered = vocab
      ? [...out].sort((a, b) => titleFitPriority(b.title, vocab) - titleFitPriority(a.title, vocab))
      : out;
    const budgeted = ordered.slice(0, maxDetailFetches);
    const dropped = out.length - budgeted.length;
    const notes = await mapWithConcurrency(budgeted, detailConcurrency, async (job) => {
      if (shouldCancel?.()) { cancelled = true; return null; }
      try {
        const url = `https://${cfg.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
          + `?expand=all&onlyData=true&finder=ById;Id="${encodeURIComponent(job.sourceJobId)}",siteNumber=${cfg.siteNumber}`;
        const data = await request(url);
        const detail = data?.items?.[0];
        if (!detail) return null;
        applyDetail(job, detail);
        return null;
      } catch (err) {
        if (err?.cancelled) return null;
        // A full JD is an enrichment, not the job. Keep the teaser and report
        // once per tenant rather than once per posting.
        job.rawMetadata.summaryOnly = true;
        return { status: err.status ?? null, error: err.message };
      }
    });
    const failed = notes.filter(Boolean);
    if (failed.length) {
      errors.push({
        error: `${failed.length} of ${budgeted.length} jobs kept the short teaser description: `
          + `the detail endpoint was unavailable (${failed[0].error})`,
        status: failed[0].status,
        degraded: true,
        count: failed.length,
      });
    }
    if (dropped > 0) {
      errors.push({
        degraded: true,
        count: dropped,
        error: `${dropped} matching posting(s) on ${cfg.company} kept the short teaser only: the `
          + `per-tenant detail budget (maxDetailFetches=${maxDetailFetches}) was reached. `
          + 'Raise it, or narrow the target titles, to cover them.',
      });
    }
  }

  return { jobs: out, errors, cancelled };
}

async function fetchJson(fetchImpl, url, requestTimeoutMs) {
  const res = await fetchWithTimeout(
    fetchImpl,
    url,
    { headers: discoveryHeaders({ Accept: 'application/json' }) },
    requestTimeoutMs,
  );
  if (!res.ok) throw httpError(res, 'Oracle Recruiting', url);
  return res.json();
}

/**
 * Merge a detail payload into a summary job, in place.
 *
 * ORC splits the posting across several fields; the requisition's own text comes
 * first because the scorer reads the head of `jdText` and leading corporate
 * boilerplate would push the actual requirements out of the part that decides
 * the fit.
 *
 * @param {object} job normalized summary job (mutated)
 * @param {object} detail raw detail record
 */
export function applyDetail(job, detail = {}) {
  const parts = [
    detail.ExternalDescriptionStr,
    detail.ExternalResponsibilitiesStr,
    detail.ExternalQualificationsStr,
    detail.CorporateDescriptionStr,
  ]
    .map((p) => htmlToText(String(p ?? '')).trim())
    .filter(Boolean);
  const text = parts.join('\n\n');
  if (text) {
    job.jdText = text.slice(0, 20000);
    job.rawMetadata.summaryOnly = false;
  }
  // The detail carries a full ISO timestamp; the list only a date. Prefer it.
  if (detail.ExternalPostedStartDate) job.postedAt = String(detail.ExternalPostedStartDate);
  if (detail.Category) job.rawMetadata.category = String(detail.Category);
  if (Number.isFinite(detail.NumberOfOpenings)) job.rawMetadata.openings = detail.NumberOfOpenings;
}

/**
 * Map one ORC requisition row to the normalized shape.
 * @param {object} row raw `requisitionList` record
 * @param {object} cfg validated tenant config
 * @returns {object} normalized job
 */
export function mapJob(row = {}, cfg = {}) {
  const id = String(row.Id ?? '');
  const secondary = Array.isArray(row.secondaryLocations)
    ? row.secondaryLocations.map((l) => String(l?.Name ?? '')).filter(Boolean)
    : [];
  const location = [row.PrimaryLocation, ...secondary].filter(Boolean).join('; ');

  return normalizeJob({
    source: 'oracleRecruiting',
    sourceJobId: id,
    company: cfg.company,
    title: row.Title ?? '',
    location,
    // The employer's own ORC application page — a direct apply link.
    url: applyUrl(cfg, id),
    jdText: htmlToText(String(row.ShortDescriptionStr ?? '')),
    postedAt: row.PostedDate ?? null,
    employmentType: String(row.WorkplaceType ?? ''),
    rawMetadata: {
      host: cfg.host,
      siteNumber: cfg.siteNumber,
      jobFamily: row.JobFamily ?? null,
      jobFunction: row.JobFunction ?? null,
      postingEndDate: row.PostingEndDate ?? null,
      // Only the teaser so far; the detail pass clears this when it lands.
      summaryOnly: true,
    },
  });
}
