/**
 * Apify connector — real, multi-portal job DISCOVERY via the official Apify API.
 *
 * Apify hosts maintained "actors" (scrapers) for LinkedIn, Indeed, Glassdoor,
 * ZipRecruiter, Google Jobs, and more. Using your own Apify account + token,
 * this adapter runs one or more configured actors and reads the resulting
 * dataset items, mapping each into the normalized job shape the rest of the
 * pipeline expects.
 *
 * Compliance posture:
 *   - Uses ONLY the official Apify REST API with YOUR token. No login replay,
 *     no CAPTCHA solving, no protection evasion is performed by this codebase.
 *   - The token is sent as an Authorization: Bearer header (never in a URL/query
 *     string) so it can never leak into logged request URLs.
 *   - Actor failures are captured per-actor and never crash the run.
 *
 * Two modes per actor entry:
 *   1. Run an actor:   { actorId, input }  -> runs the actor and reads its
 *      dataset items (run-sync-get-dataset-items).
 *   2. Read a dataset: { datasetId }       -> reads items from an existing
 *      dataset produced by a previous run.
 */

import { normalizeJob, htmlToText } from '../normalize.js';
import { withRetry } from '../../utils/retryHandler.js';
import { getSecret } from '../../utils/credentialManager.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchWithTimeout } from '../../utils/httpClient.js';

export const adapterId = 'apify';

const API_BASE = 'https://api.apify.com/v2';

/**
 * How many actors to run concurrently. Conservative by default: Apify's free
 * tier limits concurrent actor runs, and run-sync calls are heavy. Override via
 * ctx.actorConcurrency.
 */
const DEFAULT_ACTOR_CONCURRENCY = 3;

/**
 * Apify `run-sync-get-dataset-items` EXECUTES an actor (e.g. scraping Indeed)
 * and can legitimately take a minute or two. It must NOT inherit the short
 * board-API request timeout, or runs would be aborted mid-scrape. Use a
 * generous dedicated ceiling instead (override via ctx.actorTimeoutMs).
 */
const DEFAULT_ACTOR_TIMEOUT_MS = 180_000;

/**
 * @param {object} source jobboards source entry
 * @param {object} source.options
 * @param {string} [source.options.tokenEnv='APIFY_TOKEN'] env var holding the token
 * @param {Array<object>} source.options.actors actor/dataset entries to run
 * @param {number} [source.options.maxItemsPerActor=100] cap items per actor
 * @param {object} ctx
 * @param {typeof fetch} [ctx.fetchImpl]
 * @param {{ wait: Function }} [ctx.rateLimiter]
 * @param {number} [ctx.maxRetries]
 * @param {number} [ctx.actorConcurrency]
 * @param {number} [ctx.actorTimeoutMs]
 * @param {NodeJS.ProcessEnv} [ctx.env]
 * @returns {Promise<{ jobs: object[], errors: Array<{actor?: string, error: string}> }>}
 */
export async function run(source = {}, ctx = {}) {
  const { fetchImpl = fetch, rateLimiter, maxRetries = 3, env } = ctx;
  const options = source.options ?? {};
  const actors = Array.isArray(options.actors) ? options.actors : [];
  const tokenEnv = options.tokenEnv || 'APIFY_TOKEN';
  const maxItems = Number.isFinite(options.maxItemsPerActor) ? options.maxItemsPerActor : 100;
  const concurrency = ctx.actorConcurrency ?? DEFAULT_ACTOR_CONCURRENCY;
  const actorTimeoutMs = ctx.actorTimeoutMs ?? DEFAULT_ACTOR_TIMEOUT_MS;

  const jobs = [];
  const errors = [];

  if (actors.length === 0) {
    errors.push({ error: 'Apify source is enabled but has no `options.actors` configured.' });
    return { jobs, errors };
  }

  const token = getSecret(tokenEnv, { env });
  if (!token) {
    errors.push({ error: `Missing Apify token. Set ${tokenEnv} in your .env file.` });
    return { jobs, errors };
  }

  // Actors are independent runs — execute them in parallel (bounded), since a
  // run-sync call can take many seconds each.
  const perActor = await mapWithConcurrency(actors, concurrency, async (actor) => {
    const label = actor.label || actor.actorId || actor.datasetId || 'apify';
    try {
      if (rateLimiter) await rateLimiter.wait(`apify:${label}`, source.rateLimitMs);
      const items = await withRetry(
        () => fetchItems(fetchImpl, actor, token, maxItems, actorTimeoutMs),
        { maxRetries },
      );
      const mapped = [];
      for (const item of items) {
        const job = mapItem(item, actor);
        if (job) mapped.push(job);
      }
      return { jobs: mapped, error: null };
    } catch (err) {
      return { jobs: [], error: { actor: label, error: err.message } };
    }
  });

  for (const r of perActor) {
    if (!r) continue;
    jobs.push(...r.jobs);
    if (r.error) errors.push(r.error);
  }

  return { jobs, errors };
}

/**
 * Fetch dataset items for one actor/dataset entry using the official API.
 * @param {typeof fetch} fetchImpl
 * @param {object} actor
 * @param {string} token
 * @param {number} maxItems
 * @param {number} [timeoutMs]
 * @returns {Promise<object[]>}
 */
async function fetchItems(fetchImpl, actor, token, maxItems, timeoutMs) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  // Mode 2: read items from an existing dataset.
  if (actor.datasetId) {
    const url = `${API_BASE}/datasets/${encodeURIComponent(actor.datasetId)}/items?clean=true&limit=${maxItems}`;
    return fetchJson(fetchImpl, url, { headers }, timeoutMs);
  }

  // Mode 1: run the actor and read its dataset items in one call.
  // Apify accepts the actor id as "username~actorName" in the path.
  if (actor.actorId) {
    const actorPath = actor.actorId.replace('/', '~');
    const url = `${API_BASE}/acts/${actorPath}/run-sync-get-dataset-items?clean=true&limit=${maxItems}`;
    return fetchJson(fetchImpl, url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(actor.input ?? {}),
    }, timeoutMs);
  }

  throw new Error('Apify actor entry needs either `actorId` (to run) or `datasetId` (to read).');
}

async function fetchJson(fetchImpl, url, init = {}, timeoutMs) {
  const res = await fetchWithTimeout(fetchImpl, url, init, timeoutMs);
  if (!res.ok) {
    const e = new Error(`Apify HTTP ${res.status} for ${stripQuery(url)}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (data.items ?? []);
}

/** Remove any query string before putting a URL in an error/log message. */
function stripQuery(url) {
  const i = String(url).indexOf('?');
  return i === -1 ? String(url) : String(url).slice(0, i);
}

/**
 * Map one Apify dataset item to the normalized job shape, applying any
 * per-actor `fieldMap` overrides on top of sensible defaults that cover the
 * common LinkedIn/Indeed/Glassdoor actor output fields.
 *
 * @param {object} item raw dataset item
 * @param {object} actor actor config entry
 * @returns {object|null} normalized job, or null when it has no title+url
 */
export function mapItem(item, actor = {}) {
  if (!item || typeof item !== 'object') return null;
  const fm = actor.fieldMap ?? {};
  const provider = actor.source || actor.label || 'apify';

  const title = coerce(pick(item, fm.title, ['title', 'positionName', 'jobTitle', 'position', 'name']));
  const url = resolveApplyUrl(item, fm);
  // A row with neither a title nor a URL is unusable downstream.
  if (!title && !url) return null;

  const company = coerce(pick(item, fm.company, ['companyName', 'company', 'organization', 'employer', 'employerName', 'companyTitle']));
  const location = formatLocation(pick(item, fm.location, ['location', 'jobLocation', 'place', 'formattedLocation', 'city']));
  const rawJd = coerce(pick(item, fm.jdText, ['descriptionText', 'description', 'jobDescription', 'descriptionHtml', 'snippet']));
  const postedAt = coerce(pick(item, fm.postedAt, ['postedAt', 'publishedAt', 'postingDateParsed', 'datePosted', 'postedDate', 'datePublished', 'dateOnIndeed', 'date', 'postedTime']));
  const employmentType = coerce(pick(item, fm.employmentType, ['employmentType', 'contractType', 'jobType', 'jobTypes', 'workType']));
  const applicantCount = coerce(pick(item, fm.applicantCount, ['applicantsCount', 'applicationsCount', 'applicants', 'numApplicants']));
  const sourceJobId = coerce(pick(item, fm.id, ['id', 'jobId', 'jobkey', 'key', 'refNum', 'externalId']));

  return normalizeJob({
    source: 'apify',
    sourceJobId,
    company,
    title,
    location,
    url,
    jdText: looksLikeHtml(rawJd) ? htmlToText(rawJd) : rawJd,
    postedAt: postedAt || null,
    applicantCount,
    employmentType,
    rawMetadata: { provider, actorId: actor.actorId ?? null, datasetId: actor.datasetId ?? null },
  });
}

/** First present value: explicit mapped key wins, then known fallbacks. */
function pick(item, mappedKey, fallbacks) {
  if (mappedKey && hasValue(item[mappedKey])) return item[mappedKey];
  for (const key of fallbacks) {
    if (hasValue(item[key])) return item[key];
  }
  return '';
}

/**
 * Resolve the best APPLY url for a job item.
 *
 * Aggregators (Indeed especially) return BOTH an aggregator "viewjob" page —
 * which forces a "create an account / sign in before applying on company site"
 * wall — AND the direct company/ATS apply link. We strongly prefer the direct
 * company link so the automation applies on the company's own site and never
 * has to touch the aggregator's account gate. The aggregator viewjob page is
 * only used as a last resort when no direct link exists.
 *
 * @param {object} item raw dataset item
 * @param {object} [fm] per-actor fieldMap overrides
 * @returns {string} best apply URL (or '')
 */
export function resolveApplyUrl(item, fm = {}) {
  // Direct/company apply links first; aggregator viewjob pages last.
  const directKeys = [
    fm.url, fm.applyUrl,
    'jobUrl', 'externalApplyLink', 'applyUrl', 'companyApplyUrl',
    'applyLink', 'externalUrl', 'thirdPartyApplyUrl', 'directApplyUrl',
  ];
  const aggregatorKeys = ['url', 'link', 'jobPostingUrl', 'detailsUrl'];

  const candidates = [];
  for (const key of [...directKeys, ...aggregatorKeys]) {
    if (!key) continue;
    const v = coerce(item[key]);
    if (v && /^https?:\/\//i.test(v) && !candidates.includes(v)) candidates.push(v);
  }

  // Prefer the first link that is NOT an aggregator host (i.e. the company site).
  const direct = candidates.find((u) => !isAggregatorHost(u));
  return direct || candidates[0] || '';
}

/** True when a URL's host belongs to a job aggregator (gated apply page). */
export function isAggregatorHost(u) {
  return /https?:\/\/[^/]*\b(indeed|linkedin|glassdoor|ziprecruiter|simplyhired|monster|dice)\.[a-z.]+/i.test(u);
}

/**
 * Coerce a raw field value to a clean string. Job actors frequently return
 * objects (e.g. `employer: { name }`) or arrays (e.g. `jobTypes: [...]`); this
 * extracts the human-readable text instead of "[object Object]".
 */
function coerce(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(coerce).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    for (const k of ['name', 'text', 'title', 'label', 'displayName', 'value']) {
      if (typeof v[k] === 'string' && v[k].trim()) return v[k];
    }
  }
  return '';
}

/**
 * Format a location that may be a plain string or a structured object
 * (e.g. Indeed's `{ city, admin1Code, countryName }`).
 */
function formatLocation(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const named = coerce(v);
    if (named) return named;
    const parts = [v.city, v.admin1Code || v.region || v.state, v.countryName || v.countryCode]
      .map((p) => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean);
    if (parts.length) return parts.join(', ');
  }
  return coerce(v);
}

function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return String(v).trim() !== '';
}

function looksLikeHtml(v) {
  return typeof v === 'string' && /<[a-z][\s\S]*>/i.test(v);
}
