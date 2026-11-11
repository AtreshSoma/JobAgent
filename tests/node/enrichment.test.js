/**
 * P1A — description enrichment as an application service (src/search/enrich.js).
 * No network: every fetch is a stub.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { openDatabase, SCHEMA_VERSION } from '../../src/logging/db.js';
import {
  selectEnrichmentCandidates, runEnrichment, enrichmentBacklog, enrichmentSettings, FETCHABLE_SOURCES,
} from '../../src/search/enrich.js';
import { buildProfileVocabulary, classifyTitleFit } from '../../src/scoring/profileFit.js';
import { createHostGate } from '../../src/utils/hostGate.js';
import { scoringFingerprint } from '../../src/scoring/fingerprint.js';
import { loadTestConfig } from './helpers/testConfig.js';

const config = loadTestConfig({ loadEnv: false, env: {} });
const NOW = new Date('2026-09-22T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 864e5).toISOString();
const JD = 'Build and own Azure Data Factory and Databricks pipelines in PySpark and SQL. '
  + 'Model a data warehouse, publish Power BI datasets, and mentor engineers on the data platform. '.repeat(6);

let db;
let n = 0;
const wdUrl = (id) => `https://acme.wd1.myworkdayjobs.com/External/job/Remote/${id}`;
function seed(over = {}) {
  n += 1;
  const id = over.id ?? `workday:acme::de::${n}`;
  db.upsertJob({
    id, source: 'workday', company: 'Acme', title: 'Senior Data Engineer', location: 'Remote, United States',
    url: wdUrl(`DE_${n}`), jd_text: 'Short teaser.', posted_at: daysAgo(3), status: 'needs_description',
    summary_only: 1, discovery_mode: 'profile', ...over,
  });
  return id;
}
const okResponse = (text = JD) => new Response(JSON.stringify({
  jobPostingInfo: { jobDescription: `<p>${text}</p>`, location: 'Remote, United States', country: { descriptor: 'United States of America' } },
}), { status: 200, headers: { 'content-type': 'application/json' } });
const gate = () => createHostGate({ minSpacingMs: 0, sleepFn: async () => {} });
const fast = { sleepFn: async () => {}, gate: gate() };

beforeEach(() => { db = openDatabase({ path: ':memory:' }); n = 0; });
afterEach(() => db.close());

describe('schema v4', () => {
  it('adds the enrichment bookkeeping columns', () => {
    const cols = db.db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['enrich_attempts', 'enrich_attempted_at', 'enrich_error']));
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(4);
  });
});

describe('selectEnrichmentCandidates', () => {
  it('reads only active, unread, unprotected rows inside retention on a readable source', () => {
    const keep = seed();
    seed({ user_decision: 'shortlisted' });
    seed({ application_packet_path: '/x.json' });
    seed({ applied: 1 });
    seed({ status: 'discarded' });
    seed({ jd_text: JD }); // already has a real description
    seed({ posted_at: daysAgo(90) }); // past retention: about to be retired
    seed({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/1' }); // no fetcher
    const ids = selectEnrichmentCandidates(db, config, { now: NOW }).map((r) => r.id);
    expect(ids).toEqual([keep]);
  });

  it('never reads a title the profile rejects, and reads accepted titles first', () => {
    const vocab = buildProfileVocabulary(config.candidate);
    const rejectedTitle = ['Registered Nurse', 'Truck Driver', 'Line Cook'].find((t) => classifyTitleFit(t, vocab).verdict === 'reject');
    expect(rejectedTitle).toBeTruthy();
    seed({ title: rejectedTitle });
    const accepted = seed();
    const ids = selectEnrichmentCandidates(db, config, { now: NOW }).map((r) => r.id);
    expect(ids[0]).toBe(accepted);
    expect(ids).toHaveLength(1);
  });

  it('applies the per-source budget and the pass cap', () => {
    for (let i = 0; i < 5; i += 1) seed();
    for (let i = 0; i < 5; i += 1) seed({ source: 'smartrecruiters', url: `https://jobs.smartrecruiters.com/Acme/74400${i}` });
    const settings = enrichmentSettings(config, { perSourceBudget: 2, maxPerPass: 3 });
    const rows = selectEnrichmentCandidates(db, config, { now: NOW, settings });
    expect(rows).toHaveLength(3);
    const per = rows.reduce((m, r) => ({ ...m, [r.source]: (m[r.source] ?? 0) + 1 }), {});
    expect(Math.max(...Object.values(per))).toBeLessThanOrEqual(2);
  });

  it('backs off from a recent failure and gives up after maxAttempts', () => {
    const cooling = seed({ enrich_attempts: 1, enrich_attempted_at: daysAgo(0.1) });
    const retry = seed({ enrich_attempts: 1, enrich_attempted_at: daysAgo(2) });
    seed({ enrich_attempts: 3, enrich_attempted_at: daysAgo(5) });
    const ids = selectEnrichmentCandidates(db, config, { now: NOW }).map((r) => r.id);
    expect(ids).toEqual([retry]);
    expect(ids).not.toContain(cooling);
  });
});

describe('runEnrichment', () => {
  it('writes the description, re-judges with the current fingerprint, and records the attempt', async () => {
    const id = seed();
    const stats = await runEnrichment({ db, config, now: NOW, fetchImpl: async () => okResponse(), ...fast });
    expect(stats).toMatchObject({ total: 1, fetched: 1, failed: 0 });
    const row = db.getJob(id);
    expect(row.jd_text.length).toBeGreaterThan(400);
    expect(Number(row.summary_only)).toBe(0);
    expect(row.status).toBe(stats.nowActionable ? 'scored' : 'discarded');
    expect(row.scoring_fingerprint).toBe(scoringFingerprint(config));
    expect(Number(row.enrich_attempts)).toBe(1);
    expect(row.enrich_error ?? null).toBeNull();
    // Read: it is not selected again.
    expect(selectEnrichmentCandidates(db, config, { now: NOW })).toHaveLength(0);
  });

  it('gives up at once on a posting that is gone (404)', async () => {
    const id = seed();
    const stats = await runEnrichment({ db, config, now: NOW, fetchImpl: async () => new Response('', { status: 404 }), ...fast });
    expect(stats).toMatchObject({ failed: 1, gone: 1 });
    const row = db.getJob(id);
    expect(Number(row.enrich_attempts)).toBe(enrichmentSettings(config).maxAttempts);
    expect(row.status).toBe('needs_description');
    expect(row.enrich_error).toMatch(/404/);
  });

  it('retries a 503 within the pass, then records one failed attempt', async () => {
    const id = seed();
    let calls = 0;
    const stats = await runEnrichment({
      db, config, now: NOW, overrides: { maxRetries: 2 }, ...fast,
      fetchImpl: async () => { calls += 1; return new Response('', { status: 503 }); },
    });
    expect(calls).toBe(3);
    expect(stats.failed).toBe(1);
    expect(Number(db.getJob(id).enrich_attempts)).toBe(1);
  });

  it('stops between rows when cancelled and resumes with what is left', async () => {
    const ids = [seed(), seed(), seed(), seed()];
    let reads = 0;
    const first = await runEnrichment({
      db, config, now: NOW, overrides: { hostConcurrency: 1 }, ...fast,
      fetchImpl: async () => { reads += 1; return okResponse(); },
      shouldCancel: () => reads >= 2,
    });
    expect(first.cancelled).toBe(true);
    expect(first.fetched).toBe(2);
    const second = await runEnrichment({ db, config, now: NOW, fetchImpl: async () => okResponse(), ...fast });
    expect(second.fetched).toBe(2);
    for (const id of ids) expect(Number(db.getJob(id).summary_only)).toBe(0);
  });

  it('a dry run fetches and judges but writes nothing', async () => {
    const id = seed();
    const before = db.getJob(id);
    const stats = await runEnrichment({ db, config, now: NOW, apply: false, fetchImpl: async () => okResponse(), ...fast });
    expect(stats.fetched).toBe(1);
    expect(db.getJob(id)).toEqual(before);
  });

  it('reports progress as it goes', async () => {
    seed(); seed();
    const seen = [];
    await runEnrichment({ db, config, now: NOW, fetchImpl: async () => okResponse(), ...fast, onProgress: (p) => seen.push(p.done) });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(2);
  });
});

describe('enrichmentBacklog', () => {
  it('splits the unread backlog into ready, cooling, given up and unreadable', () => {
    seed();
    seed({ enrich_attempts: 1, enrich_attempted_at: daysAgo(0.1) });
    seed({ enrich_attempts: 3, enrich_attempted_at: daysAgo(5) });
    seed({ source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/9' });
    const b = enrichmentBacklog(db, config, { now: NOW });
    expect(b).toMatchObject({ unread: 4, fetchable: 3, readyNow: 1, coolingDown: 1, gaveUp: 1, unsupported: 1 });
    expect(b.bySource).toEqual({ workday: 3, greenhouse: 1 });
    expect(FETCHABLE_SOURCES).toContain('workday');
  });
});
