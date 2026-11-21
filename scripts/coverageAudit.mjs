#!/usr/bin/env node
/**
 * What did the search actually reach? (audit 2026-11-20, plan phase 0)
 *
 *   npm run coverage:audit                     table for the active profile
 *   npm run coverage:audit -- --json           machine-readable
 *   npm run coverage:audit -- --out file.json  also save the JSON
 *   npm run coverage:audit -- --db path.db     another database
 *
 * READ-ONLY: opens the database read-only and writes nothing but --out.
 *
 * Two views:
 *   1. per employer in config/coverage_targets.json: configured where, rows
 *      stored, rows still active, the most common discard reason, last seen;
 *   2. the funnel for postings whose title fits the profile (stated or
 *      adjacent title): stored -> stale / undated / excluded / low score /
 *      unread -> active. This is the number that showed 1,715 of 1,839
 *      data-engineering postings discarded as stale.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config/loadConfig.js';
import { workspacePaths } from '../src/profile/workspace.js';
import { profileVocabularyFor, titleFitPriority } from '../src/scoring/profileFit.js';
import { configuredIdentifiers, configuredIn, matchesCompany, NON_ROUTES } from '../src/search/coverageTargets.js';
import { BACKFILL_MIN_TITLE_FIT } from '../src/search/sourceCoverage.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const asJson = argv.includes('--json');

const config = loadConfig({ root: ROOT, loadEnv: true, env: process.env });
const dbPath = opt('--db') ?? workspacePaths(ROOT).db;
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
const targets = JSON.parse(readFileSync(join(ROOT, 'config', 'coverage_targets.json'), 'utf8')).targets;

const kindOf = (reason) => {
  const r = String(reason ?? '');
  if (!r) return '';
  if (r.startsWith('not judged')) return 'unread';
  return r.split(':')[0].trim();
};

// ── per employer ─────────────────────────────────────────────────────────────
const byCompany = db.prepare(`SELECT company, status, discard_reason AS reason, COUNT(*) AS n, MAX(updated_at) AS last
  FROM jobs GROUP BY company, status, discard_reason`).all();
const identifiers = configuredIdentifiers(config.jobboards);
const employers = targets.map((t) => {
  const rows = byCompany.filter((r) => matchesCompany(t, r.company));
  const total = rows.reduce((s, r) => s + r.n, 0);
  const active = rows.filter((r) => r.status !== 'discarded').reduce((s, r) => s + r.n, 0);
  const reasons = {};
  for (const r of rows) if (r.status === 'discarded') reasons[kindOf(r.reason)] = (reasons[kindOf(r.reason)] ?? 0) + r.n;
  const top = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0] ?? null;
  const last = rows.map((r) => r.last).filter(Boolean).sort().pop() ?? null;
  return {
    name: t.name, route: t.route, configuredIn: configuredIn(t, config.jobboards, identifiers),
    rows: total, active, topDiscard: top ? { reason: top[0], n: top[1] } : null, lastSeen: last,
    ...(NON_ROUTES.has(t.route) ? { reason: t.reason } : {}),
  };
});

// ── relevant-title funnel ────────────────────────────────────────────────────
const vocab = profileVocabularyFor(config.candidate);
const funnel = { relevant: 0, stale: 0, undated: 0, excluded: 0, lowScore: 0, unread: 0, active: 0, excludedBy: {} };
for (const row of db.prepare('SELECT title, status, discard_reason AS reason FROM jobs').iterate()) {
  if (titleFitPriority(row.title, vocab) < BACKFILL_MIN_TITLE_FIT) continue;
  funnel.relevant += 1;
  const kind = kindOf(row.reason);
  if (row.status !== 'discarded') { if (row.status === 'needs_description') funnel.unread += 1; else funnel.active += 1; continue; }
  if (kind === 'stale') funnel.stale += 1;
  else if (kind === 'unknown posting date') funnel.undated += 1;
  else if (kind === 'below near-miss threshold') funnel.lowScore += 1;
  else { funnel.excluded += 1; funnel.excludedBy[kind] = (funnel.excludedBy[kind] ?? 0) + 1; }
}
db.close();

const report = { generatedAt: new Date().toISOString(), db: dbPath, employers, funnel };
if (opt('--out')) writeFileSync(opt('--out'), `${JSON.stringify(report, null, 2)}\n`);
if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
console.log(`Coverage audit — ${dbPath}\n`);
console.log(`${pad('Employer', 26)} ${pad('Route', 17)} ${pad('Configured', 10)} ${pad('Rows', 7)} ${pad('Active', 7)} ${pad('Top discard', 28)} Last seen`);
for (const e of employers) {
  const configured = NON_ROUTES.has(e.route) ? '—' : (e.configuredIn.length ? 'yes' : 'NO');
  const top = e.topDiscard ? `${e.topDiscard.reason} (${e.topDiscard.n})` : '';
  console.log(`${pad(e.name, 26)} ${pad(e.route, 17)} ${pad(configured, 10)} ${pad(e.rows, 7)} ${pad(e.active, 7)} ${pad(top, 28)} ${String(e.lastSeen ?? '').slice(0, 10)}`);
}
const routed = employers.filter((e) => !NON_ROUTES.has(e.route));
console.log(`\n${routed.filter((e) => e.rows === 0).length} of ${routed.length} routed employers have no stored rows yet`
  + ` (a newly configured employer appears after the next discovery run).`);
console.log(`\nPostings whose title fits the profile: ${funnel.relevant}`);
console.log(`  discarded as stale:        ${funnel.stale}`);
console.log(`  discarded, undated:        ${funnel.undated}`);
console.log(`  discarded by an exclusion: ${funnel.excluded}  ${JSON.stringify(funnel.excludedBy)}`);
console.log(`  discarded, low score:      ${funnel.lowScore}`);
console.log(`  waiting for a description: ${funnel.unread}`);
console.log(`  active (scored or later):  ${funnel.active}`);
