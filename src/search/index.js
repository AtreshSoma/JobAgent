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

  const sources = [...(jobboards?.sources ?? [])]
    .filter((s) => s.enabled)
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));

  const collected = [];
  const errors = [];
  const perSource = [];

  for (const source of sources) {
    const mod = ADAPTERS[source.adapter];
    if (!mod || typeof mod.run !== 'function') {
      errors.push({ source: source.id, error: `Unknown adapter: ${source.adapter}` });
      continue;
    }
    hooks.onSource?.({ phase: 'start', source: source.id, adapter: source.adapter });
    try {
      const result = await mod.run(source, { ...ctx, rateLimiter, maxRetries });
      const jobs = result.jobs ?? [];
      collected.push(...jobs);
      for (const e of result.errors ?? []) {
        errors.push({ source: source.id, ...e });
        hooks.onError?.({ source: source.id, ...e });
      }
      perSource.push({ source: source.id, adapter: source.adapter, found: jobs.length, errors: (result.errors ?? []).length });
      hooks.onSource?.({ phase: 'end', source: source.id, adapter: source.adapter, found: jobs.length });
    } catch (err) {
      // An adapter throwing should not stop other sources.
      errors.push({ source: source.id, error: err.message });
      perSource.push({ source: source.id, adapter: source.adapter, found: 0, errors: 1 });
      hooks.onError?.({ source: source.id, error: err.message });
    }
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
