#!/usr/bin/env node
/**
 * Repair stored job URLs that were written by a since-fixed adapter bug.
 *
 * Why this exists
 * ---------------
 * The Workday adapter built posting links with
 * `new URL(externalPath, 'https://' + host)`. `externalPath` is root-relative
 * (`/job/Remote-Kentucky/Lead-Cloud---Data-Platform-Engineer_R-422722`), and a
 * root-relative path resolves against the ORIGIN — silently discarding the
 * `/{locale}/{site}` segments that say which career site the job belongs to.
 * Every Workday link ever stored therefore 404s. Verified live: without the
 * site segment Workday answers 404, with it 200.
 *
 * `mapJob` now concatenates instead of resolving, so new rows are correct. This
 * script fixes the rows already in the database, which the dashboard is still
 * linking to. The site is recovered by matching the URL's host against the
 * tenant list in config/jobboards.json.
 *
 * Usage
 * -----
 *   node scripts/repairJobUrls.mjs                # dry run: report only
 *   node scripts/repairJobUrls.mjs --apply        # rewrite the rows
 *   node scripts/repairJobUrls.mjs --apply --verify=20
 *
 * Nothing is written without --apply, and a backup of the database file is
 * taken first. `--verify=N` spot-checks N repaired links against the live site
 * before reporting, so the fix is proven rather than assumed.
 */

import { readFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Load the built-in `node:sqlite` via createRequire, the same way src/logging/db.js
// does. A static `import { DatabaseSync } from 'node:sqlite'` is resolved eagerly by
// bundlers and test runners, which do not know the builtin and fail the whole module
// with "Failed to load url sqlite". That took tests/node/workdayJobUrl.test.js — the
// regression guard for the 15,733 broken Workday URLs this script repairs — out of the
// suite entirely, and the failure read as unrelated tooling noise.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'config', 'jobboards.json');
const DB_PATH = join(ROOT, 'data', 'applied_jobs.db');

const VERIFY_CONCURRENCY = 5;
const USER_AGENT = 'job-agent/0.1 (personal job-search assistant; contact via repository owner)';

function parseArgs(argv) {
  const args = { apply: false, verify: 0 };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--verify=')) args.verify = Math.max(0, Number(a.split('=')[1]) || 0);
    else if (a === '--help' || a === '-h') {
      console.log('  --apply       rewrite the rows (default: dry run)\n'
        + '  --verify=N    spot-check N repaired links against the live site\n');
      process.exit(0);
    } else { console.error(`Unknown argument: ${a}`); process.exit(1); }
  }
  return args;
}

/**
 * Rebuild one Workday URL, inserting the `/{locale}/{site}` segments the old
 * adapter dropped.
 *
 * Returns null when the URL needs no repair or the host is unknown — callers
 * must treat null as "leave this row exactly as it is".
 *
 * @param {string} url stored URL
 * @param {Map<string, {site: string, locale?: string}>} byHost tenants keyed by lowercased host
 * @returns {string|null} repaired URL, or null to leave it alone
 */
export function repairWorkdayUrl(url, byHost) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return null; }
  if (!/\.myworkdayjobs\.com$/i.test(parsed.host)) return null;
  // Only the broken shape: the path starts straight at /job/, with no site.
  if (!parsed.pathname.startsWith('/job/')) return null;

  const tenant = byHost.get(parsed.host.toLowerCase());
  if (!tenant?.site) return null;

  const locale = tenant.locale ? `/${tenant.locale}` : '';
  const repaired = `${parsed.origin}${locale}/${tenant.site}${parsed.pathname}${parsed.search}`;
  try { return new URL(repaired).href; } catch { return null; }
}

async function verifyLive(urls) {
  const results = [];
  const queue = [...urls];
  const workers = Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow' });
        results.push({ url, status: res.status });
      } catch (err) {
        results.push({ url, status: `ERR ${err.message}` });
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log('Repairing stored Workday job URLs\n');

  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const tenants = cfg.sources?.find((s) => s.adapter === 'workday')?.tenants ?? [];
  const byHost = new Map(tenants.map((t) => [String(t.host).toLowerCase(), t]));
  console.log(`  ${byHost.size} Workday tenants in config`);

  const db = new DatabaseSync(DB_PATH);
  const rows = db.prepare("SELECT id, url FROM jobs WHERE url LIKE '%myworkdayjobs.com/job/%'").all();
  console.log(`  ${rows.length.toLocaleString()} rows match the broken shape\n`);

  const fixes = [];
  let unknownHost = 0;
  for (const r of rows) {
    const repaired = repairWorkdayUrl(r.url, byHost);
    if (!repaired) { unknownHost += 1; continue; }
    fixes.push({ id: r.id, from: r.url, to: repaired });
  }

  console.log(`  repairable: ${fixes.length.toLocaleString()}`);
  if (unknownHost) console.log(`  left alone (host not in config): ${unknownHost.toLocaleString()}`);
  if (!fixes.length) { console.log('\n  Nothing to do.'); db.close(); return; }

  console.log('\n  Examples:');
  for (const f of fixes.slice(0, 3)) {
    console.log(`    - ${f.from.slice(0, 92)}`);
    console.log(`    + ${f.to.slice(0, 92)}`);
  }

  if (args.verify) {
    const sample = fixes.slice(0, args.verify).map((f) => f.to);
    console.log(`\n  Verifying ${sample.length} repaired links against the live site...`);
    const res = await verifyLive(sample);
    const ok = res.filter((r) => r.status === 200).length;
    console.log(`  ${ok}/${res.length} return HTTP 200`);
    for (const r of res.filter((x) => x.status !== 200).slice(0, 5)) {
      console.log(`    ${r.status}  ${r.url.slice(0, 88)}`);
    }
    if (ok === 0) {
      console.log('\n  Every probe failed — NOT writing. Investigate before re-running.');
      db.close();
      process.exitCode = 1;
      return;
    }
  }

  if (!args.apply) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --apply to fix ${fixes.length.toLocaleString()} rows.`);
    db.close();
    return;
  }

  const backup = `${DB_PATH}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  db.close();
  copyFileSync(DB_PATH, backup);

  const write = new DatabaseSync(DB_PATH);
  const stmt = write.prepare('UPDATE jobs SET url = ?, updated_at = ? WHERE id = ?');
  const now = new Date().toISOString();
  write.exec('BEGIN');
  try {
    for (const f of fixes) stmt.run(f.to, now, f.id);
    write.exec('COMMIT');
  } catch (err) {
    write.exec('ROLLBACK');
    throw err;
  }
  const left = write.prepare("SELECT COUNT(*) n FROM jobs WHERE url LIKE '%myworkdayjobs.com/job/%'").get().n;
  write.close();

  console.log(`\n  Repaired ${fixes.length.toLocaleString()} rows.`);
  console.log(`  Backup: ${backup}`);
  console.log(`  Remaining rows in the broken shape: ${left}`);
}

main().catch((err) => {
  console.error(`repairJobUrls failed: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
