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
};

/** How many independent sources to run concurrently by default. */
const DEFAULT_SOURCE_CONCURRENCY = 6;

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

  // Concurrency ceilings are politeness limits, never evasion. Source-level
  // fans out across independent connectors; per-adapter ceilings (boards /
  // pages / details / actors) are threaded through ctx so each adapter throttles
  // its own internal fan-out. A request timeout stops a single hung endpoint
  // from stalling the whole run.
  const sourceConcurrency = ctx.sourceConcurrency ?? defaults.sourceConcurrency ?? DEFAULT_SOURCE_CONCURRENCY;
  const adapterCtx = {
    ...ctx,
    rateLimiter,
    maxRetries,
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
  const settled = await mapSettled(sources, sourceConcurrency, async (source) => {
    const mod = ADAPTERS[source.adapter];
    if (!mod || typeof mod.run !== 'function') {
      return { jobs: [], errors: [{ error: `Unknown adapter: ${source.adapter}` }] };
    }
    hooks.onSource?.({ phase: 'start', source: source.id, adapter: source.adapter });
    const result = await mod.run(source, adapterCtx);
    const jobs = result.jobs ?? [];
    hooks.onSource?.({ phase: 'end', source: source.id, adapter: source.adapter, found: jobs.length });
    return { jobs, errors: result.errors ?? [] };
  });

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
    });
  }

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

  return { jobs: unique, duplicates, errors, perSource };
}
