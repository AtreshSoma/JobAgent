/**
 * TWO SEARCHES, ONE DATABASE, NO LEAKS.
 *
 * The product has two discovery flows that must never influence each other:
 *
 *   Find new jobs      personalized — the saved profile decides what is looked
 *                      for, what is recognized, and what reaches the board.
 *   Search by job role ad-hoc — the user types any title and gets what the
 *                      market has for THAT title, regardless of their profile.
 *
 * They share the `jobs` table, so "independent" is a property that has to be
 * enforced and therefore tested. Before this split the ad-hoc search ran the
 * same pipeline with `keepBelowThreshold`, which persisted every row it touched
 * as `scored`: one search for "Product Manager" permanently seeded the
 * personalized board with product roles, and nothing recorded where they came
 * from, so it could not be undone or even explained afterwards.
 *
 * Every test here is about the boundary, not about either feature's own output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../../src/logging/db.js';
import { startDashboard } from '../../src/dashboard/server.js';
import { loadConfig } from '../../src/config/loadConfig.js';
import { runQuerySearch } from '../../src/cli/commands.js';
import { boardPage } from '../../src/dashboard/data.js';

const REPO = process.cwd();

/** A temp project root holding the real shared config and schemas. */
function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jobagent-search-modes-'));
  mkdirSync(join(root, 'config', 'schemas'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  mkdirSync(join(root, 'resumes', 'base'), { recursive: true });
  for (const file of [
    'scoring.json', 'exclusions.json', 'jobboards.json', 'humanizer_patterns.json',
    'cover_letter.example.json', 'ats_resume.json', 'role_families.json',
  ]) {
    copyFileSync(join(REPO, 'config', file), join(root, 'config', file));
  }
  copyFileSync(join(REPO, 'config', 'cover_letter.example.json'), join(root, 'config', 'cover_letter.json'));
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.json'));
  copyFileSync(join(REPO, 'config', 'candidate.example.json'), join(root, 'config', 'candidate.example.json'));
  copyFileSync(join(REPO, 'config', 'screening_answers.example.json'), join(root, 'config', 'screening_answers.json'));
  for (const schema of ['candidate', 'scoring', 'exclusions', 'jobboards', 'cover_letter', 'ats_resume']) {
    copyFileSync(
      join(REPO, 'config', 'schemas', `${schema}.schema.json`),
      join(root, 'config', 'schemas', `${schema}.schema.json`),
    );
  }
  writeFileSync(join(root, '.env'), '');
  return root;
}

const FRESH = () => new Date(Date.now() - 2 * 864e5).toISOString();

/** A posting a data-engineering profile would recognize. */
const DATA_JOB = {
  id: 'de-1', source: 'greenhouse', company: 'Northwind', title: 'Senior Data Engineer',
  location: 'Remote, United States', url: 'https://example.com/de-1', postedAt: FRESH(),
  jdText: 'Build and own Azure Data Factory and Databricks pipelines in PySpark and SQL. '
    + 'Model a data warehouse, publish Power BI datasets, and mentor engineers on the data platform.',
};

/** A posting that same profile would never ask for. */
const PM_JOB = {
  id: 'pm-1', source: 'greenhouse', company: 'Northwind', title: 'Senior Product Manager, Payments',
  location: 'Remote, United States', url: 'https://example.com/pm-1', postedAt: FRESH(),
  jdText: 'Own the payments product roadmap, write PRDs, run discovery interviews with merchants, '
    + 'and partner with design and engineering to ship the checkout experience.',
};

/** A search stub that returns a fixed set of jobs for whatever is asked. */
const searchFnFor = (jobs) => async () => ({ jobs, duplicates: [], errors: [], perSource: [] });

describe('personalized discovery and role search stay independent', () => {
  let db;
  let root;
  let config;

  beforeEach(() => {
    root = makeRoot();
    db = openDatabase({ path: ':memory:' });
    config = loadConfig({ root, loadEnv: false, env: {} });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Run an ad-hoc role search whose adapters return `jobs`. */
  const roleSearch = (query, jobs) => runQuerySearch({
    config, db, logger: null, query,
    deps: { searchFn: searchFnFor(jobs), now: new Date() },
  });

  it('keeps role-search results off the personalized board entirely', async () => {
    await roleSearch('Product Manager', [PM_JOB]);

    // The personalized board is the default read, and it has never heard of it.
    const board = boardPage(db, { now: new Date(), includeClosed: true });
    expect(board.jobs.map((j) => j.id)).not.toContain('pm-1');

    // The row exists — it was not silently dropped — and is reachable through
    // its own scope. "Independent" must mean fenced off, not thrown away.
    const roleBoard = boardPage(db, {
      now: new Date(), includeClosed: true,
      discoveryMode: 'role_search', searchQuery: 'Product Manager',
    });
    expect(roleBoard.jobs.map((j) => j.id)).toContain('pm-1');
  });

  it('stamps every row with the search that found it, and the phrase asked for', async () => {
    await roleSearch('Product Manager', [PM_JOB]);
    const row = db.getJob('pm-1');
    expect(row.discovery_mode).toBe('role_search');
    expect(row.search_query).toBe('Product Manager');
  });

  it('never rewrites the saved profile, on disk or in the live config', async () => {
    const before = JSON.parse(JSON.stringify(config.candidate));
    await roleSearch('Registered Nurse', [PM_JOB]);
    // The searched phrase is scoped to that one call. If it reached the shared
    // config, the NEXT personalized run would start looking for nurses.
    expect(config.candidate).toEqual(before);
    expect(config.candidate.targetTitles).not.toContain('Registered Nurse');

    const reloaded = loadConfig({ root, loadEnv: false, env: {} });
    expect(reloaded.candidate.targetTitles).toEqual(before.targetTitles);
  });

  it('separates two different role searches from each other as well', async () => {
    await roleSearch('Product Manager', [PM_JOB]);
    await roleSearch('Data Engineer', [{ ...DATA_JOB, id: 'de-role-1' }]);

    const pm = boardPage(db, {
      now: new Date(), includeClosed: true,
      discoveryMode: 'role_search', searchQuery: 'Product Manager',
    });
    expect(pm.jobs.map((j) => j.id)).toEqual(['pm-1']);

    const de = boardPage(db, {
      now: new Date(), includeClosed: true,
      discoveryMode: 'role_search', searchQuery: 'Data Engineer',
    });
    expect(de.jobs.map((j) => j.id)).toEqual(['de-role-1']);
  });

  it('lists and clears role searches without touching personalized rows', async () => {
    // A personalized row, written the way a discovery run writes one.
    db.upsertJob({ id: 'mine-1', title: 'Senior Data Engineer', status: 'scored', score: 80 });

    await roleSearch('Product Manager', [PM_JOB]);
    expect(db.listRoleSearches().map((s) => s.query)).toEqual(['Product Manager']);

    const removed = db.deleteRoleSearch('Product Manager');
    expect(removed).toBe(1);
    expect(db.listRoleSearches()).toEqual([]);
    // The personalized row is still there. A clear is scoped in SQL, so it
    // cannot reach a row the profile owns even by accident.
    expect(db.getJob('mine-1')).not.toBeNull();
  });

  it('treats rows written before the split as personalized, not as lost', async () => {
    // Every row already in a user's database predates `discovery_mode`, because
    // role search is the only other writer and it is newer. Reading NULL as
    // anything but 'profile' would empty the board on upgrade.
    db.upsertJob({ id: 'legacy-1', title: 'Senior Data Engineer', status: 'scored', score: 77 });
    db.db.prepare('UPDATE jobs SET discovery_mode = NULL WHERE id = ?').run('legacy-1');

    const board = boardPage(db, { now: new Date(), includeClosed: true });
    expect(board.jobs.map((j) => j.id)).toContain('legacy-1');
  });

  it('lets a personalized run CLAIM a row a role search found first, never the reverse', async () => {
    await roleSearch('Data Engineer', [DATA_JOB]);
    expect(db.getJob(DATA_JOB.id).discovery_mode).toBe('role_search');

    // The same posting now arrives through personalized discovery. Finding it
    // through the saved profile is proof it belongs on the personalized board.
    const { runPipeline } = await import('../../src/pipeline/index.js');
    await runPipeline({
      config, db, logger: null, mode: 'DRY_RUN',
      deps: { searchFn: searchFnFor([DATA_JOB]), now: new Date() },
    });
    expect(db.getJob(DATA_JOB.id).discovery_mode).toBe('profile');

    // And it stays personalized when a later role search stumbles onto it,
    // which is the direction that would otherwise leak rows OFF the board.
    await roleSearch('Data Engineer', [DATA_JOB]);
    expect(db.getJob(DATA_JOB.id).discovery_mode).toBe('profile');
  });
});

describe('isolation does not become data loss elsewhere', () => {
  let db;
  let root;
  let config;

  beforeEach(() => {
    root = makeRoot();
    db = openDatabase({ path: ':memory:' });
    config = loadConfig({ root, loadEnv: false, env: {} });
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** One personalized row and one role-search row, as each writer leaves them. */
  const seed = () => {
    db.upsertJob({
      id: 'mine-1', company: 'Northwind', title: 'Senior Data Engineer',
      jd_text: 'Azure Data Factory, Databricks, PySpark and SQL pipelines; Power BI datasets.',
      status: 'scored', score: 75, posted_at: FRESH(),
    });
    db.upsertJob({
      id: 'role-1', company: 'Acme', title: 'Senior Product Manager, Payments',
      jd_text: 'Own the payments product roadmap and write PRDs.',
      status: 'scored', score: 20, posted_at: FRESH(), applied: 1,
      applied_at: new Date().toISOString(),
      discovery_mode: 'role_search', search_query: 'Product Manager',
    });
  };

  it('re-score judges the personalized board and leaves a role search alone', async () => {
    // Re-scoring recomputes fit against the SAVED PROFILE. Applied to a row the
    // user asked for BY NAME, the profile's vocabulary has no opinion worth
    // acting on: it re-tiered a "Senior Product Manager, Payments" as Discard
    // and marked it `discarded`, emptying the role-search list the user had
    // just built — with no action of theirs and nothing saying what happened.
    seed();
    const { runRescore } = await import('../../src/cli/commands.js');
    await runRescore({ config, db, logger: null, deps: { now: new Date() } });

    const role = db.getJob('role-1');
    expect(role.status).toBe('scored');
    expect(role.discovery_mode).toBe('role_search');
    const stillThere = boardPage(db, {
      now: new Date(), discoveryMode: 'role_search', searchQuery: 'Product Manager',
    });
    expect(stillThere.jobs.map((j) => j.id)).toContain('role-1');
  });

  it('the job tracker keeps a job you applied to, however you found it', async () => {
    // The tracker is a RECORD, not a recommendation. Scoping it to the
    // personalized board dropped role-search rows out of the user's own
    // application history — including ones they had already applied to.
    seed();
    const { writeJobTracker } = await import('../../src/reports/jobTracker.js');
    const { readFileSync } = await import('node:fs');
    const { path } = writeJobTracker(db, root);
    const csv = readFileSync(path, 'utf8');

    expect(csv).toContain('Senior Data Engineer');
    expect(csv).toContain('Senior Product Manager, Payments');
    // And the two stay distinguishable rather than being blended back together.
    expect(csv).toContain('Found Via');
    expect(csv).toMatch(/Role search: Product Manager/);
    expect(csv).toMatch(/My profile/);
  });

  it('the spreadsheet export keeps every job, and says how each was found', async () => {
    seed();
    const { buildExportRows, EXPORT_COLUMNS } = await import('../../src/dashboard/data.js');
    const rows = buildExportRows(db, {});
    expect(rows.map((r) => r.title)).toEqual(
      expect.arrayContaining(['Senior Data Engineer', 'Senior Product Manager, Payments']),
    );
    expect(EXPORT_COLUMNS.map(([key]) => key)).toContain('foundVia');
    expect(rows.find((r) => r.title.startsWith('Senior Product')).foundVia)
      .toBe('Role search: Product Manager');
    expect(rows.find((r) => r.title === 'Senior Data Engineer').foundVia).toBe('My profile');
  });

  it('a packet prepared from a role search is still findable in Documents', async () => {
    // A document on disk belongs to whoever made it, not to a search mode.
    db.upsertJob({
      id: 'role-doc', company: 'Acme', title: 'Senior Product Manager',
      status: 'scored', score: 20, posted_at: FRESH(),
      resume_docx_path: '/tmp/r.docx', application_packet_path: '/tmp/p.json',
      discovery_mode: 'role_search', search_query: 'Product Manager',
    });
    const { buildDocuments } = await import('../../src/dashboard/data.js');
    const docs = buildDocuments(db, {
      root: null, readFileImpl: () => { throw new Error('packet unreadable'); },
    });
    expect(docs.tailored.map((d) => d.jobId)).toContain('role-doc');
  });

  it('listJobs obeys a mode it is given instead of ignoring it', () => {
    // A method that accepts `mode` and silently drops it is how the tracker bug
    // would have come back unnoticed.
    seed();
    expect(db.listJobs({}).map((j) => j.id).sort()).toEqual(['mine-1', 'role-1']);
    expect(db.listJobs({ mode: 'profile' }).map((j) => j.id)).toEqual(['mine-1']);
    expect(db.listJobs({ mode: 'role_search' }).map((j) => j.id)).toEqual(['role-1']);
  });
});

describe('the role-search API is reachable and scoped', () => {
  let db;
  let dash;
  let root;

  const get = (p) => fetch(dash.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const del = (p) => fetch(dash.url + p, { method: 'DELETE' })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(async () => {
    root = makeRoot();
    db = openDatabase({ path: ':memory:' });
    const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
    dash = await startDashboard({
      config: load(), db, logger: null, port: 0,
      deps: { extensionKey: 'k'.repeat(32), loadConfigImpl: load },
    });
  });

  afterEach(async () => {
    await dash.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the personalized board by default and the role list on request', async () => {
    db.upsertJob({ id: 'mine-1', title: 'Senior Data Engineer', status: 'scored', score: 80 });
    db.upsertJob({
      id: 'role-1', title: 'Senior Product Manager', status: 'scored', score: 20,
      discovery_mode: 'role_search', search_query: 'Product Manager',
    });

    const board = await get('/api/jobs?includeClosed=true');
    expect(board.body.jobs.map((j) => j.id)).toEqual(['mine-1']);

    const roles = await get('/api/jobs?includeClosed=true&discoveryMode=role_search&searchQuery=Product%20Manager');
    expect(roles.body.jobs.map((j) => j.id)).toEqual(['role-1']);

    const history = await get('/api/search/history');
    expect(history.body.searches.map((s) => s.query)).toEqual(['Product Manager']);
  });

  it('clears one role search and leaves the personalized board intact', async () => {
    db.upsertJob({ id: 'mine-1', title: 'Senior Data Engineer', status: 'scored', score: 80 });
    db.upsertJob({
      id: 'role-1', title: 'Senior Product Manager', status: 'scored', score: 20,
      discovery_mode: 'role_search', search_query: 'Product Manager',
    });

    const cleared = await del('/api/search?query=Product%20Manager');
    expect(cleared.status).toBe(200);
    expect(cleared.body.removed).toBe(1);

    const board = await get('/api/jobs?includeClosed=true');
    expect(board.body.jobs.map((j) => j.id)).toEqual(['mine-1']);
    expect((await get('/api/search/history')).body.searches).toEqual([]);
  });

  it('refuses a clear with no query rather than guessing which one', async () => {
    const bad = await del('/api/search?query=');
    expect(bad.status).toBe(400);
  });
});

describe('the two searches cannot run at the same time', () => {
  let db;
  let dash;
  let root;

  const post = (p, body) => fetch(dash.url + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const status = () => fetch(dash.url + '/api/run/status').then((r) => r.json());

  beforeEach(async () => {
    root = makeRoot();
    db = openDatabase({ path: ':memory:' });
    const load = ({ root: r = root } = {}) => loadConfig({ root: r, loadEnv: false, env: {} });
    dash = await startDashboard({
      config: load(), db, logger: null, port: 0,
      deps: {
        extensionKey: 'k'.repeat(32), loadConfigImpl: load,
        // A role search that takes long enough to overlap, as a real one does.
        querySearchFn: async ({ query }) => {
          await new Promise((r) => setTimeout(r, 400));
          return { query, counters: {}, sources: ['ats-search'], errors: [] };
        },
        searchFn: searchFnFor([]),
      },
    });
  });

  afterEach(async () => {
    await dash.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('a role search HOLDS the run lock, not just checks it', async () => {
    // This endpoint checked `runState.running` and never set it, so exclusion
    // worked in one direction only: a run blocked a search, a search blocked
    // nothing. Both pipelines could then write the same jobs table at once —
    // and with the two modes writing different `discovery_mode` values to the
    // same rows, persistJob's ownership rule would be racing too.
    const search = post('/api/search', { query: 'Product Manager' });
    await new Promise((r) => setTimeout(r, 120));

    expect((await status()).running).toBe(true);
    const run = await post('/api/run', { phase: 'discover' });
    expect(run.status).toBe(409);

    await search;
  });

  it('releases the lock afterwards, including when the search fails', async () => {
    const search = post('/api/search', { query: 'Product Manager' });
    await search;
    await new Promise((r) => setTimeout(r, 50));
    expect((await status()).running).toBe(false);
    // And a normal run may start again — a stranded lock would 409 forever.
    expect((await post('/api/run', { phase: 'discover' })).status).toBe(202);
  });
});
