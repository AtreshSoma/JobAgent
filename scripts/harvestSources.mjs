#!/usr/bin/env node
/**
 * Harvest new ATS board coordinates from jobs you have already discovered, and
 * (optionally) add the ones that verify live to config/jobboards.json.
 *
 * Why this exists
 * ---------------
 * The company-first adapters (Greenhouse, Lever, Ashby, SmartRecruiters,
 * Workday) can only enumerate boards someone has typed into the config by hand.
 * Meanwhile every job the query-first sources return carries a URL that NAMES a
 * board — and those were being discarded after each run. When this was written
 * the config listed 14 Workday tenants while the database already held URLs
 * naming 222 distinct Workday hosts.
 *
 * Board enumeration is free and unmetered, so each harvested coordinate turns a
 * one-time metered discovery into permanent free coverage. This is what makes
 * the discovery layer compound instead of resetting every month.
 *
 * Usage
 * -----
 *   node scripts/harvestSources.mjs                 # dry run: report only
 *   node scripts/harvestSources.mjs --apply         # write config/jobboards.json
 *   node scripts/harvestSources.mjs --limit=40      # cap additions per ATS
 *   node scripts/harvestSources.mjs --min-jobs=2    # require N sightings first
 *   node scripts/harvestSources.mjs --no-validate   # skip liveness checks
 *
 * Nothing is written without --apply, and a timestamped backup of the existing
 * config is made before any write.
 */

import { readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  harvestCoordinates, configuredCoordinateKeys, coordinateKey, mergeCoordinates, duplicateCoordinateKeys,
} from '../src/search/sourceHarvest.js';
import { mapWithConcurrency } from '../src/utils/concurrency.js';
import { workspacePaths } from '../src/profile/workspace.js';
import { fetchWithTimeout, discoveryHeaders } from '../src/utils/httpClient.js';
import { writeFileAtomic } from '../src/utils/fsSafe.js';
import { SCHEMA_FILES, validateConfig } from '../src/config/validateConfig.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config', 'jobboards.json');
// The active person's store and last run report (src/profile/workspace.js).
const DB_PATH = workspacePaths(ROOT).db;
const FOUND_PATH = join(workspacePaths(ROOT).dataDir, 'found_jobs.json');

/** Concurrent liveness probes. Each targets a different vendor host. */
const VALIDATE_CONCURRENCY = 8;
const VALIDATE_TIMEOUT_MS = 20_000;

/**
 * Human-readable identity for a harvested coordinate.
 *
 * Not every ATS is identified by a board slug. Workday needs host + site,
 * Oracle needs host + siteNumber, and an iCIMS portal host IS the employer —
 * those three carry no `slug` at all. Reading `coord.slug` unconditionally
 * therefore threw `Cannot read properties of undefined (reading 'slice')` and
 * killed the harvest at the print step, AFTER the network validation had
 * already run. The failure was specific to iCIMS, Oracle and Rippling, which is
 * exactly why those three platforms still had one board each in the config
 * while 132 live candidates sat undiscovered in the database.
 *
 * @param {object} coord harvested coordinate
 * @returns {string} always a string, so formatting can never throw
 */
function coordLabel(coord = {}) {
  if (coord.ats === 'workday') return `${coord.host} / ${coord.site}`;
  if (coord.ats === 'oracleRecruiting') return `${coord.host} / ${coord.siteNumber}`;
  if (coord.ats === 'icims') return String(coord.host ?? '');
  return String(coord.slug ?? coord.host ?? '(unnamed)');
}

function parseArgs(argv) {
  const args = { apply: false, validate: true, limit: 50, minJobs: 1 };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--no-validate') args.validate = false;
    else if (a.startsWith('--limit=')) args.limit = Math.max(0, Number(a.split('=')[1]) || 0);
    else if (a.startsWith('--min-jobs=')) args.minJobs = Math.max(1, Number(a.split('=')[1]) || 1);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`
Harvest ATS board coordinates from already-discovered jobs.

  --apply         Write the additions to config/jobboards.json (default: dry run)
  --limit=N       Maximum new entries per ATS (default 50)
  --min-jobs=N    Only harvest a board seen at least N times (default 1)
  --no-validate   Skip live liveness checks (much faster, less certain)
  -h, --help      Show this help
`);
}

/** Read every `{ url, company }` pair we know about. */
function loadRows() {
  const rows = [];

  if (existsSync(DB_PATH)) {
    try {
      const db = new DatabaseSync(DB_PATH, { readOnly: true });
      for (const r of db.prepare('SELECT url, company FROM jobs WHERE url IS NOT NULL').all()) {
        rows.push({ url: r.url, company: r.company });
      }
      db.close();
    } catch (err) {
      console.warn(`  ! could not read ${DB_PATH}: ${err.message}`);
    }
  }

  if (existsSync(FOUND_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(FOUND_PATH, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : (parsed.jobs ?? parsed.rows ?? []);
      for (const r of list) rows.push({ url: r.url, company: r.company });
    } catch (err) {
      console.warn(`  ! could not read ${FOUND_PATH}: ${err.message}`);
    }
  }

  return rows;
}

/* ------------------------------------------------------------------ *
 * Liveness validation — one probe per ATS, using the same public API
 * the corresponding adapter reads.
 * ------------------------------------------------------------------ */

async function getJson(url, init = {}) {
  const res = await fetchWithTimeout(
    fetch,
    url,
    { ...init, headers: discoveryHeaders({ Accept: 'application/json', ...(init.headers ?? {}) }) },
    VALIDATE_TIMEOUT_MS,
  );
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.json();
}

const VALIDATORS = {
  async greenhouse({ slug }) {
    const d = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=false`);
    return (d.jobs ?? []).length;
  },
  async lever({ slug }) {
    const d = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`);
    return Array.isArray(d) ? d.length : 0;
  },
  async ashby({ slug }) {
    const d = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`);
    return (d.jobs ?? []).length;
  },
  async smartrecruiters({ slug }) {
    const d = await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings?limit=1`);
    return Number(d.totalFound ?? (d.content ?? []).length);
  },
  async workday({ host, tenant, site }) {
    const d = await getJson(
      `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 1, offset: 0, searchText: '', appliedFacets: {} }),
      },
    );
    return Number(d.total ?? (d.jobPostings ?? []).length);
  },
  async icims({ host }) {
    // `in_iframe=1` is what makes iCIMS serve the rendered listing; without it
    // the response is an empty iframe wrapper and every portal looks dead.
    const res = await fetchWithTimeout(
      fetch,
      `https://${host}/jobs/search?ss=1&in_iframe=1`,
      { headers: discoveryHeaders({ Accept: 'text/html' }) },
      VALIDATE_TIMEOUT_MS,
    );
    if (!res.ok) {
      const e = new Error(`HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    const html = await res.text();
    return (html.match(/\/jobs\/\d+\/[^"']*?\/job/g) ?? []).length;
  },
  async oracleRecruiting({ host, siteNumber }) {
    // `expand=requisitionList` is mandatory — without it this returns 200 with
    // no jobs key and every harvested tenant would look dead.
    const d = await getJson(
      `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
      + `?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${encodeURIComponent(siteNumber)},limit=1`,
    );
    const envelope = d?.items?.[0] ?? {};
    return Number(envelope.TotalJobsCount ?? (envelope.requisitionList ?? []).length);
  },
  /**
   * Rippling boards had NO validator at all, so every harvested one failed with
   * "no validator", was counted as dead, and was silently dropped before the
   * merge step — 33 candidates in one pass. Combined with the label crash above,
   * that is the whole reason this platform sat at a single configured board.
   *
   * Same public board endpoint the adapter itself reads.
   */
  async rippling({ slug }) {
    const d = await getJson(
      `https://api.rippling.com/platform/api/ats/v1/board/${encodeURIComponent(slug)}/jobs`,
    );
    return Array.isArray(d) ? d.length : 0;
  },
  // Workable boards are harvested for the record but have no company-first
  // adapter to receive them; the cross-company atsSearch provider already
  // covers every Workable account, so validating one would prove nothing.
  async workable() { return 0; },
};

async function validate(entries) {
  return mapWithConcurrency(entries, VALIDATE_CONCURRENCY, async (entry) => {
    const validator = VALIDATORS[entry.coord.ats];
    // `unvalidated`, not merely `live: false`. A platform with no validator was
    // reported inside the same "dead or empty" total as a board that was really
    // probed and really had nothing — so adding an adapter without also adding a
    // validator here made its boards vanish with no way to tell from the output.
    if (!validator) {
      return { ...entry, live: false, unvalidated: true, postings: 0, error: 'no validator' };
    }
    try {
      const postings = await validator(entry.coord);
      return { ...entry, live: postings > 0, postings, error: null };
    } catch (err) {
      return { ...entry, live: false, postings: 0, error: err.status ? `HTTP ${err.status}` : err.message };
    }
  });
}

/* ------------------------------------------------------------------ */

/**
 * Why the merged config must not be written, or [] when it may.
 *
 * Checks the schema the loader enforces (so a harvest can never produce a
 * config that stops every later run at startup) and refuses NEW duplicate
 * coordinates — a board listed twice is fetched twice every run. Duplicates
 * that were already present are reported by `npm run doctor`, not blocked here.
 *
 * @param {object} merged config about to be written
 * @param {object} before config as read
 * @returns {string[]}
 */
export function checkHarvestedConfig(merged, before = {}) {
  const problems = [];
  const schema = JSON.parse(readFileSync(join(ROOT, 'config', 'schemas', SCHEMA_FILES.jobboards), 'utf8'));
  const result = validateConfig('jobboards', merged, schema);
  if (!result.valid) problems.push(result.message);
  const existing = new Set(duplicateCoordinateKeys(before));
  const introduced = duplicateCoordinateKeys(merged).filter((k) => !existing.has(k));
  if (introduced.length) {
    problems.push(`${introduced.length} board(s) would be listed twice: ${introduced.slice(0, 5).join(', ')}`);
  }
  return problems;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('Harvesting ATS coordinates from already-discovered jobs\n');

  const rows = loadRows();
  console.log(`  scanned ${rows.length.toLocaleString()} job URLs`);

  const jobboards = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const configured = configuredCoordinateKeys(jobboards);
  console.log(`  config already covers ${configured.size} boards\n`);

  const harvested = harvestCoordinates(rows);
  const candidates = [...harvested.values()]
    .filter((e) => !configured.has(coordinateKey(e.coord)))
    .filter((e) => e.count >= args.minJobs)
    // Most-seen first: a board we have met repeatedly is the safest bet, and
    // it is what the per-ATS limit should spend itself on.
    .sort((a, b) => b.count - a.count);

  const byAts = {};
  for (const e of candidates) byAts[e.coord.ats] = (byAts[e.coord.ats] ?? 0) + 1;
  console.log(`  ${candidates.length} NEW candidate boards found:`);
  for (const [ats, n] of Object.entries(byAts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${ats.padEnd(16)} ${n}`);
  }
  if (candidates.length === 0) {
    console.log('\n  Nothing new to add.');
    return;
  }

  // Apply the per-ATS cap BEFORE validating so a dry run stays cheap.
  const capped = [];
  const seenPerAts = {};
  for (const e of candidates) {
    const ats = e.coord.ats;
    seenPerAts[ats] = (seenPerAts[ats] ?? 0) + 1;
    if (seenPerAts[ats] > args.limit) continue;
    capped.push(e);
  }
  const droppedByCap = candidates.length - capped.length;
  if (droppedByCap > 0) {
    console.log(`\n  --limit=${args.limit} holds back ${droppedByCap} candidate(s) for a later run.`);
  }

  let verified = capped.map((e) => ({ ...e, live: true, postings: null, error: null }));
  if (args.validate) {
    console.log(`\n  Validating ${capped.length} boards against their public APIs...`);
    verified = await validate(capped);
    const live = verified.filter((e) => e.live).length;
    const unvalidated = verified.filter((e) => e.unvalidated);
    console.log(`  ${live} live / ${verified.length - live - unvalidated.length} dead or empty`);
    if (unvalidated.length) {
      const byAts = new Map();
      for (const e of unvalidated) byAts.set(e.coord.ats, (byAts.get(e.coord.ats) ?? 0) + 1);
      const detail = [...byAts].map(([ats, n]) => `${ats} (${n})`).join(', ');
      console.log(`  ${unvalidated.length} NOT CHECKED — no validator for: ${detail}.`);
      console.log('    These are dropped, not added. Add a validator in VALIDATORS to harvest them.');
    }
  } else {
    console.log('\n  --no-validate: skipping liveness checks');
  }

  const live = verified.filter((e) => e.live).sort((a, b) => (b.postings ?? 0) - (a.postings ?? 0));
  if (live.length === 0) {
    console.log('\n  No live boards to add.');
    return;
  }

  console.log('\n  Boards to add (most postings first):');
  for (const e of live.slice(0, 30)) {
    const label = coordLabel(e.coord);
    const company = [...e.companies][0] ?? '';
    console.log(
      `    ${String(e.postings ?? '?').padStart(5)} postings  ${e.coord.ats.padEnd(15)} `
      + `${label.slice(0, 48).padEnd(48)} ${company.slice(0, 24)}`,
    );
  }
  if (live.length > 30) console.log(`    ... and ${live.length - 30} more`);

  const coords = live.map((e) => ({
    ...e.coord,
    company: [...e.companies][0] ?? undefined,
  }));

  if (!args.apply) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --apply to add ${coords.length} board(s).`);
    return;
  }

  const { config, added, skipped } = mergeCoordinates(jobboards, coords);
  // Validate BEFORE touching the file: a merge that breaks the schema, or that
  // introduces a board listed twice, must never replace a working config.
  const problems = checkHarvestedConfig(config, jobboards);
  if (problems.length) {
    console.error('\n  Refusing to write config/jobboards.json:');
    for (const p of problems) console.error(`    - ${p}`);
    process.exitCode = 1;
    return;
  }
  const backup = `${CONFIG_PATH}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  copyFileSync(CONFIG_PATH, backup);
  // Atomic: a run starting mid-write must read the old config or the new one,
  // never a truncated file.
  writeFileAtomic(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  console.log(`\n  Wrote ${CONFIG_PATH}`);
  console.log(`  Backup: ${backup}`);
  for (const [ats, n] of Object.entries(added)) console.log(`    +${n} ${ats}`);
  if (skipped) console.log(`    (${skipped} skipped — already present or no matching source)`);
  console.log('\n  Run `npm run doctor` to confirm the config still validates.');
}

// Run only when executed directly, so tests can import checkHarvestedConfig.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`harvestSources failed: ${err.stack ?? err.message}`);
    process.exitCode = 1;
  });
}
