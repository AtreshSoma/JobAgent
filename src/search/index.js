/**
 * Search orchestrator.
 *
 * Runs every enabled source (in priority order) through its adapter, collecting
 * normalized jobs and per-source errors, then deduplicates the combined set.
 *
 * Individual adapter failures NEVER crash the run — they are captured in the
 * returned `errors` array and logging is left to the caller.
 */

import { createRateLimiter } from '../utils/rateLimiter.js';
import { createHostGate } from '../utils/hostGate.js';
import { mapSettled } from '../utils/concurrency.js';
import { deduplicate } from './deduplicator.js';
import { classifyDiscovery } from './discoveryFilter.js';
import { sourceKind } from './sources.js';

import * as manualUrls from './adapters/manualUrls.js';
import * as dice from './adapters/dice.js';
import * as indeed from './adapters/indeed.js';
import * as linkedin from './adapters/linkedin.js';
import * as greenhouse from './adapters/greenhouse.js';
import * as lever from './adapters/lever.js';
import * as workday from './adapters/workday.js';
import * as careers from './adapters/careersPage.js';
import * as genericPublicPage from './adapters/genericPublicPage.js';
import * as apify from './adapters/apify.js';
import * as ashby from './adapters/ashby.js';
import * as smartrecruiters from './adapters/smartrecruiters.js';
import * as atsSearch from './adapters/atsSearch.js';
import * as adzuna from './adapters/adzuna.js';
import * as rippling from './adapters/rippling.js';
import * as oracleRecruiting from './adapters/oracleRecruiting.js';
import * as amazonJobs from './adapters/amazonJobs.js';
import * as icims from './adapters/icims.js';

/** adapter id -> module. */
export const ADAPTERS = {
  manualUrls,
  dice,
  indeed,
  linkedin,
  greenhouse,
  lever,
  workday,
  careers,
  genericPublicPage,
  apify,
  ashby,
  smartrecruiters,
  atsSearch,
  adzuna,
  rippling,
  oracleRecruiting,
  amazonJobs,
  icims,
};

/** How many independent sources to run concurrently by default. */
const DEFAULT_SOURCE_CONCURRENCY = 6;

/**
 * Requests allowed in flight against ONE host, across every source that talks
 * to it. Sources are independent; hosts are not. Dozens of Greenhouse boards
 * share `boards-api.greenhouse.io` and dozens of Workday tenants share a pod,
 * so this — not the per-source ceiling — is the limit the server counts.
 */
const DEFAULT_HOST_CONCURRENCY = 4;

/**
 * Run all enabled sources and return deduplicated jobs.
 *
 * @param {object} args
 * @param {object} args.jobboards parsed config/jobboards.json
 * @param {object} [args.ctx] adapter context overrides
 * @param {typeof fetch} [args.ctx.fetchImpl]
 * @param {Function} [args.ctx.readFileImpl]
 * @param {string} [args.ctx.root]
 * @param {object} [args.candidate] parsed config/candidate.json (discovery signals)
 * @param {object} [args.scoring] parsed config/scoring.json (discovery keyword boost)
 * @param {(job: object, key: string) => boolean} [args.existsInDb]
 * @param {{ onSource?: Function, onError?: Function }} [args.hooks]
 * @returns {Promise<{ jobs: object[], duplicates: object[], errors: object[], perSource: object[] }>}
 */
export async function runSearch({ jobboards, ctx = {}, candidate, scoring, existsInDb, hooks = {} } = {}) {
  const defaults = jobboards?.defaults ?? {};
  const rateLimiter = ctx.rateLimiter ?? createRateLimiter({
    minIntervalMs: defaults.rateLimitMs ?? 3000,
  });
  const maxRetries = ctx.maxRetries ?? defaults.maxRetries ?? 3;

  // ONE gate for the whole run, shared by every source. Politeness has to be
  // accounted per host — the per-source ceilings above cannot see that two
  // different sources are pointed at the same server.
  const hostGate = ctx.hostGate ?? createHostGate({
    maxConcurrent: ctx.hostConcurrency ?? defaults.hostConcurrency ?? DEFAULT_HOST_CONCURRENCY,
  });

  // Concurrency ceilings are politeness limits, never evasion. Source-level
  // fans out across independent connectors; per-adapter ceilings (boards /
  // pages / details / actors) are threaded through ctx so each adapter throttles
  // its own internal fan-out. A request timeout stops a single hung endpoint
  // from stalling the whole run.
  const sourceConcurrency = ctx.sourceConcurrency ?? defaults.sourceConcurrency ?? DEFAULT_SOURCE_CONCURRENCY;
  const adapterCtx = {
    ...ctx,
    rateLimiter,
    hostGate,
    maxRetries,
    // Query-first adapters (atsSearch, adzuna) search ACROSS employers, so they
    // need to know what to search FOR. Threading the candidate profile here lets
    // them default their queries to `targetTitles`, which keeps the title list
    // in config/candidate.json as the single source of truth instead of being
    // copied into jobboards.json where the two would silently drift apart.
    candidate: ctx.candidate ?? candidate,
    scoring: ctx.scoring ?? scoring,
    requestTimeoutMs: ctx.requestTimeoutMs ?? defaults.requestTimeoutMs,
    boardConcurrency: ctx.boardConcurrency ?? defaults.boardConcurrency,
    pageConcurrency: ctx.pageConcurrency ?? defaults.pageConcurrency,
    detailConcurrency: ctx.detailConcurrency ?? defaults.detailConcurrency,
    actorConcurrency: ctx.actorConcurrency ?? defaults.actorConcurrency,
  };

  const sources = [...(jobboards?.sources ?? [])]
    .filter((s) => s.enabled)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

  // Run all enabled sources concurrently (bounded). mapSettled preserves input
  // order, so results are gathered in priority order — collection and dedup
  // stay deterministic regardless of which source finishes first.
  //
  // What it does NOT preserve is the order work is claimed in. Priority says
  // which source we trust, not how long it takes, and the pool is smaller than
  // the source list: with the two slowest sources sitting 9th and 10th of 15
  // behind a pool of 6, they started only after eight shorter ones finished and
  // the run ended when the last of them drained on its own. Claiming
  // longest-first (measured, from the previous run) overlaps them with the
  // short work. With no timings on disk this is a no-op and order is unchanged.
  const timings = ctx.sourceTimings ?? null;
  const settled = await mapSettled(sources, sourceConcurrency, async (source) => {
    const startedAt = Date.now();
    if (ctx.shouldCancel?.()) {
      hooks.onSource?.({ phase: 'cancelled', source: source.id, adapter: source.adapter, durationMs: 0 });
      return { jobs: [], errors: [], cancelled: true, durationMs: 0 };
    }
    const mod = ADAPTERS[source.adapter];
    if (!mod || typeof mod.run !== 'function') {
      const durationMs = Date.now() - startedAt;
      hooks.onSource?.({ phase: 'end', source: source.id, adapter: source.adapter, found: 0, errors: 1, durationMs });
      return { jobs: [], errors: [{ error: `Unknown adapter: ${source.adapter}` }], durationMs };
    }
    hooks.onSource?.({ phase: 'start', source: source.id, adapter: source.adapter, at: new Date().toISOString() });
    try {
      const result = await mod.run(source, adapterCtx);
      const jobs = result.jobs ?? [];
      const sourceErrors = result.errors ?? [];
      const durationMs = Date.now() - startedAt;
      hooks.onSource?.({
        phase: result.cancelled === true ? 'cancelled' : 'end',
        source: source.id, adapter: source.adapter, found: jobs.length,
        errors: sourceErrors.length, durationMs, cached: result.cached === true,
      });
      return {
        jobs, errors: sourceErrors, cancelled: result.cancelled === true,
        durationMs, cached: result.cached === true,
        // Descriptions answered from an earlier run instead of re-bought. Worth
        // reporting: it is the difference between a source that reads a board
        // and one that re-reads the same board every time.
        reused: Number(result.reused) || 0,
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      hooks.onSource?.({ phase: 'end', source: source.id, adapter: source.adapter, found: 0, errors: 1, durationMs });
      throw error;
    }
  }, timings ? { costOf: (source) => timings.expectedMs(source.id) } : {});

  const collected = [];
  const errors = [];
  const perSource = [];

  for (let i = 0; i < settled.length; i += 1) {
    const source = sources[i];
    const r = settled[i];
    // The mapper above only throws if an adapter throws synchronously after the
    // start hook; treat that as a single source-level error so other sources
    // (already gathered) are never lost.
    const payload = r.ok ? r.value : { jobs: [], errors: [{ error: r.error?.message ?? 'source failed' }] };
    collected.push(...payload.jobs);
    for (const e of payload.errors) {
      const tagged = { source: source.id, ...e };
      errors.push(tagged);
      hooks.onError?.(tagged);
    }
    perSource.push({
      source: source.id,
      adapter: source.adapter,
      found: payload.jobs.length,
      errors: payload.errors.length,
      cancelled: payload.cancelled === true,
      durationMs: payload.durationMs ?? null,
      cached: payload.cached === true,
      reused: Number(payload.reused) || 0,
    });
  }

  // Remember what each source cost, so the next run can schedule on measurement
  // instead of on priority — and so a slow run can still be explained after it
  // has finished. Recording never throws.
  timings?.record?.(perSource);

  const { unique, duplicates } = deduplicate(collected, { existsInDb });

  // Tag provenance kind (discovery vs url-reader vs manual) on every job so the
  // report can never conflate real discovery with URL-readers.
  for (const job of unique) {
    job.rawMetadata = { ...(job.rawMetadata ?? {}), sourceKind: sourceKind(job.source) };
  }

  // Attach permissive discovery signals to every surviving job (non-destructive:
  // classification never drops a job — exclusions/scoring decide downstream).
  if (candidate) {
    for (const job of unique) {
      const discovery = classifyDiscovery(job, { candidate, scoring });
      job.rawMetadata = { ...(job.rawMetadata ?? {}), discovery };
    }
  }

  return {
    jobs: unique,
    duplicates,
    errors,
    perSource,
    cancelled: perSource.some((source) => source.cancelled),
  };
}
