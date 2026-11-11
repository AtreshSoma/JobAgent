/**
 * Is a posting still OPEN at its source?
 *
 * Why this exists
 * ---------------
 * The board kept jobs the employer had already closed. Measured 2026-09-23 on
 * the live store: 24 of the 40 best-scored open Workday rows and 5 of 6
 * SmartRecruiters rows were closed, and clicking through showed Workday's
 * "The page you are looking for doesn't exist". The HTTP link check could not
 * tell: Workday serves that page with status 200 and renders the message in
 * the browser.
 *
 * Every ATS we discover from has a public, keyless API that DOES say whether
 * a posting exists. This module asks the same API the discovery adapter used,
 * with the same honest User-Agent — no scraping, no evasion:
 *
 *   Workday          GET /wday/cxs/{tenant}/{site}/job/{path}  200 open · 403 S22 / 404 closed
 *   SmartRecruiters  GET /v1/companies/{co}/postings/{id}       active:false / 404 → closed
 *   Greenhouse       GET boards-api …/boards/{board}/jobs/{id}   200 open · 404 closed
 *   Lever            GET api.lever.co/v0/postings/{co}/{id}      200 open · 404 closed
 *   Oracle Recruiting recruitingCEJobRequisitionDetails ById     items ≥1 open · 0 closed
 *   Ashby            GET posting-api/job-board/{org}             id listed → open, else closed
 *
 * Anything else answers `unknown` — never `closed` on a guess. A 401/429/5xx
 * or a network error is also `unknown`: absence of proof is not proof.
 */

const USER_AGENT = 'JobAgent/0.1 (local job-search assistant; posting status check)';

/** @typedef {{ state: 'open'|'closed'|'unknown', via: string, httpStatus?: number|null, detail?: string }} Liveness */

/**
 * Work out which ATS API can answer for this job, from its id and URL.
 * @param {{ id?: string, url?: string, source?: string }} job
 * @returns {{ ats: string, [k: string]: string }|null}
 */
export function livenessTarget(job = {}) {
  const url = String(job.url ?? '');
  const id = String(job.id ?? '');
  let u;
  try { u = new URL(url); } catch { u = null; }

  if (u && /\.myworkdayjobs\.com$/i.test(u.hostname)) {
    const [tenant, pod] = u.hostname.split('.');
    // /{locale?}/{site}/job/{...}; a URL missing the site segment is broken,
    // not closed (scripts/repairJobUrls.mjs fixes those rows).
    const m = u.pathname.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/(job\/.+)$/);
    if (!m || m[1] === 'job') return { ats: 'workday-malformed' };
    return { ats: 'workday', tenant, pod, site: m[1], path: m[2] };
  }
  if (u && /(^|\.)smartrecruiters\.com$/i.test(u.hostname)) {
    const m = u.pathname.match(/^\/([^/]+)\/(\d+)/);
    if (m) return { ats: 'smartrecruiters', company: m[1], postingId: m[2] };
  }
  if (u && /(^|\.)lever\.co$/i.test(u.hostname)) {
    const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    if (m) return { ats: 'lever', company: m[1], postingId: m[2] };
  }
  if (u && /(^|\.)ashbyhq\.com$/i.test(u.hostname)) {
    const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    if (m) return { ats: 'ashby', org: m[1], postingId: m[2] };
  }
  if (u && /\.oraclecloud\.com$/i.test(u.hostname)) {
    const m = u.pathname.match(/\/sites\/([^/]+)\/job\/(\d+)/);
    if (m) return { ats: 'oracle', host: u.hostname, siteNumber: m[1], requisitionId: m[2] };
  }
  // Greenhouse: the board token is in the job id ("greenhouse:<board>::…")
  // because employer-hosted pages (databricks.com/…?gh_jid=…) do not name it.
  // A Greenhouse-hosted URL names its board outright; prefer it.
  if (u && /greenhouse\.io$/i.test(u.hostname)) {
    const m = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (m) return { ats: 'greenhouse', board: m[1], jobId: m[2], boardFromUrl: true };
  }
  // Otherwise the id's prefix is the normalized COMPANY NAME, not the board
  // token ("doordash usa" for board `doordashusa`, "backblaze external
  // website" for `backblaze`). Board tokens are lower-case alphanumerics, so
  // the name is squashed to that shape — and checkPostingLiveness confirms the
  // board exists before a 404 on the job may mean "closed".
  const gh = id.match(/^greenhouse:([^:]+)::/);
  const ghJob = u?.searchParams.get('gh_jid') ?? url.match(/\/jobs\/(\d+)/)?.[1] ?? id.match(/::(\d+)$/)?.[1];
  if (gh && ghJob) return { ats: 'greenhouse', board: gh[1].toLowerCase().replace(/[^a-z0-9]/g, ''), jobId: ghJob };
  return null;
}

async function getJson(fetchImpl, url, { signal, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    });
    let body = null;
    // The timeout stays armed until the body is read (a stalled body used to
    // hang forever once headers had arrived).
    try { body = await res.json(); } catch { body = null; }
    return { status: Number(res.status) || 0, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/** A per-sweep memo for list-style APIs (Ashby answers per board, not per job). */
export function createLivenessCache() {
  return new Map();
}

/**
 * Ask the posting's own ATS whether it is still open.
 *
 * @param {{ id?: string, url?: string, source?: string }} job
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal, cache?: Map }} [options]
 * @returns {Promise<Liveness>}
 */
export async function checkPostingLiveness(job, { fetchImpl = fetch, timeoutMs = 12000, signal, cache } = {}) {
  const target = livenessTarget(job);
  if (!target) return { state: 'unknown', via: 'no ATS API for this link' };
  if (target.ats === 'workday-malformed') {
    return { state: 'unknown', via: 'workday', detail: 'the saved link is missing its career-site segment' };
  }
  const opts = { signal, timeoutMs };
  try {
    switch (target.ats) {
      case 'workday': {
        const api = `https://${target.tenant}.${target.pod}.myworkdayjobs.com/wday/cxs/${target.tenant}/${target.site}/${target.path}`;
        const { status, body } = await getJson(fetchImpl, api, opts);
        if (status === 200 && body?.jobPostingInfo) return { state: 'open', via: 'workday', httpStatus: status };
        // Workday answers a removed requisition with 403 errorCode S22 (verified
        // against live and closed postings on the same tenant), or 404.
        if (status === 404 || (status === 403 && body?.errorCode === 'S22')) {
          return { state: 'closed', via: 'workday', httpStatus: status };
        }
        return { state: 'unknown', via: 'workday', httpStatus: status };
      }
      case 'smartrecruiters': {
        const api = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(target.company)}/postings/${target.postingId}`;
        const { status, body } = await getJson(fetchImpl, api, opts);
        if (status === 200) return { state: body?.active === false ? 'closed' : 'open', via: 'smartrecruiters', httpStatus: status };
        if (status === 404) return { state: 'closed', via: 'smartrecruiters', httpStatus: status };
        return { state: 'unknown', via: 'smartrecruiters', httpStatus: status };
      }
      case 'greenhouse': {
        const board = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.board)}`;
        const { status } = await getJson(fetchImpl, `${board}/jobs/${target.jobId}`, opts);
        if (status === 200) return { state: 'open', via: 'greenhouse', httpStatus: status };
        if (status !== 404) return { state: 'unknown', via: 'greenhouse', httpStatus: status };
        // Greenhouse answers a WRONG BOARD with the same 404 as a closed job.
        // Treating that as "closed" retired live postings whose company name
        // differs from its board token (found in pre-merge review, 2026-09-23).
        // So a 404 counts only once the board itself is known to exist.
        const key = `greenhouse-board:${target.board}`;
        let exists = cache?.get(key);
        if (exists === undefined) {
          const probe = await getJson(fetchImpl, board, opts);
          exists = probe.status === 200;
          cache?.set(key, exists);
        }
        return exists
          ? { state: 'closed', via: 'greenhouse', httpStatus: status }
          : { state: 'unknown', via: 'greenhouse', httpStatus: status, detail: `no Greenhouse board named "${target.board}"` };
      }
      case 'lever': {
        const api = `https://api.lever.co/v0/postings/${encodeURIComponent(target.company)}/${target.postingId}`;
        const { status } = await getJson(fetchImpl, api, opts);
        if (status === 200) return { state: 'open', via: 'lever', httpStatus: status };
        if (status === 404) return { state: 'closed', via: 'lever', httpStatus: status };
        return { state: 'unknown', via: 'lever', httpStatus: status };
      }
      case 'oracle': {
        const finder = `ById;Id=%22${target.requisitionId}%22,siteNumber=${encodeURIComponent(target.siteNumber)}`;
        const api = `https://${target.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&finder=${finder}`;
        const { status, body } = await getJson(fetchImpl, api, opts);
        if (status === 200 && Array.isArray(body?.items)) {
          return { state: body.items.length > 0 ? 'open' : 'closed', via: 'oracle', httpStatus: status };
        }
        return { state: 'unknown', via: 'oracle', httpStatus: status };
      }
      case 'ashby': {
        const key = `ashby:${target.org}`;
        let ids = cache?.get(key);
        if (!ids) {
          const { status, body } = await getJson(fetchImpl,
            `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(target.org)}`, opts);
          if (status !== 200 || !Array.isArray(body?.jobs)) return { state: 'unknown', via: 'ashby', httpStatus: status };
          ids = new Set(body.jobs.map((j) => String(j.id).toLowerCase()));
          cache?.set(key, ids);
        }
        return { state: ids.has(target.postingId.toLowerCase()) ? 'open' : 'closed', via: 'ashby', httpStatus: 200 };
      }
      default:
        return { state: 'unknown', via: target.ats };
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    return { state: 'unknown', via: target.ats, detail: err?.name === 'AbortError' ? 'timed out' : String(err?.message ?? err) };
  }
}

/** Host that rate limits apply to, for spreading a sweep politely. */
export function livenessHost(job) {
  const t = livenessTarget(job);
  if (!t) return 'other';
  if (t.ats === 'workday') return `${t.pod}.myworkdayjobs.com`;
  if (t.ats === 'oracle') return t.host;
  return t.ats;
}

/**
 * Check a batch of open postings and retire the closed ones.
 *
 * Polite by construction: at most `perHost` requests in flight per API host
 * (Workday pods are the shared throttle, see search/hostGate.js), a small
 * spacing between requests on the same host, and it stops as soon as the
 * signal aborts. Each result is written as it arrives, so a cancelled sweep
 * keeps what it learned.
 *
 * @param {object} args
 * @param {import('../logging/db.js').Database} args.db
 * @param {number} [args.limit=300]
 * @param {number} [args.maxAgeHours=24] re-check a posting at most this often
 * @param {boolean} [args.apply=true] false = report only, write nothing
 * @param {number} [args.perHost=2]
 * @param {number} [args.spacingMs=150]
 * @param {AbortSignal} [args.signal]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {Date} [args.now]
 * @param {(p: object) => void} [args.onProgress]
 * @returns {Promise<{ checked: number, open: number, closed: number, unknown: number, retired: number, bySource: object, closedExamples: object[] }>}
 */
export async function sweepPostings({
  db, limit = 300, maxAgeHours = 24, apply = true, perHost = 2, spacingMs = 150,
  signal, fetchImpl = fetch, now = new Date(), onProgress, rows,
} = {}) {
  const olderThan = new Date(now.getTime() - maxAgeHours * 3600_000).toISOString();
  const todo = rows ?? db.listPostingsToCheck({ olderThan, limit });
  const out = { checked: 0, open: 0, closed: 0, unknown: 0, retired: 0, bySource: {}, closedExamples: [] };
  const cache = createLivenessCache();
  const queues = new Map();
  for (const row of todo) {
    const host = livenessHost(row);
    if (!queues.has(host)) queues.set(host, []);
    queues.get(host).push(row);
  }
  const checkedAt = now.toISOString();
  const worker = async (queue) => {
    while (queue.length && !signal?.aborted) {
      const row = queue.shift();
      const result = await checkPostingLiveness(row, { fetchImpl, signal, cache });
      out.checked += 1;
      out[result.state] += 1;
      const src = (out.bySource[row.source ?? 'unknown'] ??= { open: 0, closed: 0, unknown: 0 });
      src[result.state] += 1;
      if (result.state === 'closed' && out.closedExamples.length < 10) {
        out.closedExamples.push({ company: row.company, title: row.title, via: result.via });
      }
      if (apply) {
        try {
          const written = db.recordPostingCheck(row.id, { state: result.state, via: result.via, checkedAt });
          if (written.retired) out.retired += 1;
        } catch { /* a concurrent status change wins; the next sweep re-checks */ }
      }
      onProgress?.({ ...out });
      if (spacingMs > 0 && queue.length) await new Promise((r) => setTimeout(r, spacingMs));
    }
  };
  const workers = [];
  for (const queue of queues.values()) {
    for (let i = 0; i < Math.max(1, perHost); i += 1) workers.push(worker(queue));
  }
  await Promise.all(workers);
  return out;
}
