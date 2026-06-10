/**
 * Run report generator.
 *
 * Takes the rows produced by a pipeline run (or the jobs table) and renders a
 * single-run summary in three formats inside `reports/`:
 *
 *   report-<stamp>.json  machine-readable summary (totals, breakdowns)
 *   report-<stamp>.csv   one row per job, opens in Excel/Sheets
 *   report-<stamp>.html  human-friendly dashboard (totals, by-source, top jobs)
 *
 * Pure functions (`summarize`, `renderCsv`, `renderHtml`) are exported
 * separately from the file-writing `generateReport` so everything is testable
 * without touching the filesystem.
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import { dateStamp } from '../utils/dates.js';

/** Columns for the per-job CSV (kept in sync with the report rows). */
const CSV_COLUMNS = [
  'id', 'source', 'company', 'title', 'location', 'url', 'posted_at',
  'discoveryMatch', 'score', 'tier', 'sponsorship', 'status',
  'discard_reason', 'missing_keywords', 'application_packet_path',
];

/** Parse a missing_keywords value that may be an array or a JSON string. */
function keywordList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** A job counts as discarded when its tier or status says so. */
function isDiscarded(job) {
  return job.tier === 'Discard' || job.status === 'discarded';
}

/**
 * Aggregate a list of job rows into report totals and breakdowns.
 *
 * @param {object[]} jobs report rows (pipeline reportRow shape or db rows)
 * @returns {object} summary
 */
export function summarize(jobs = []) {
  const totals = {
    found: jobs.length,
    scored: 0,
    priority: 0,
    apply: 0,
    queued: 0,
    discarded: 0,
    prepared: 0,
    weakMatch: 0,
  };
  const discardReasons = {};
  const sponsorship = {};
  const missingCounts = new Map();
  const bySource = {};
  const byDiscovery = {};

  for (const job of jobs) {
    const source = job.source || 'unknown';
    if (!bySource[source]) bySource[source] = { found: 0, kept: 0, discarded: 0, prepared: 0 };
    bySource[source].found += 1;

    const match = job.discoveryMatch || 'unknown';
    byDiscovery[match] = (byDiscovery[match] ?? 0) + 1;
    if (match === 'weak') totals.weakMatch += 1;

    if (typeof job.score === 'number') totals.scored += 1;
    if (job.tier === 'Priority') totals.priority += 1;
    if (job.tier === 'Apply') totals.apply += 1;
    if (job.tier === 'Queue') totals.queued += 1;

    if (isDiscarded(job)) {
      totals.discarded += 1;
      bySource[source].discarded += 1;
      const reason = job.discard_reason || 'unspecified';
      discardReasons[reason] = (discardReasons[reason] ?? 0) + 1;
    } else {
      bySource[source].kept += 1;
    }

    if (job.application_packet_path) {
      totals.prepared += 1;
      bySource[source].prepared += 1;
    }

    if (job.sponsorship) {
      sponsorship[job.sponsorship] = (sponsorship[job.sponsorship] ?? 0) + 1;
    }

    for (const kw of keywordList(job.missing_keywords)) {
      const key = String(kw).toLowerCase();
      missingCounts.set(key, (missingCounts.get(key) ?? 0) + 1);
    }
  }

  const missingKeywords = [...missingCounts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  const topJobs = jobs
    .filter((j) => typeof j.score === 'number' && !isDiscarded(j))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map((j) => ({
      id: j.id, company: j.company, title: j.title, score: j.score,
      tier: j.tier ?? null, sponsorship: j.sponsorship ?? null, url: j.url ?? null,
    }));

  return { totals, discardReasons, sponsorship, missingKeywords, topJobs, bySource, byDiscovery };
}

/**
 * Escape a single CSV field (RFC 4180: quote when it contains , " or newline).
 * @param {unknown} value
 * @returns {string}
 */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = Array.isArray(value) ? value.join('; ') : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

/**
 * Render one CSV row per job with a header line. No trailing newline.
 * @param {object[]} jobs
 * @returns {string}
 */
export function renderCsv(jobs = []) {
  const header = CSV_COLUMNS.join(',');
  const rows = jobs.map((job) => CSV_COLUMNS.map((col) => {
    if (col === 'missing_keywords') return csvField(keywordList(job[col]));
    return csvField(job[col]);
  }).join(','));
  return [header, ...rows].join('\n');
}

/**
 * Escape text for safe interpolation into HTML.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function htmlTable(headers, rows) {
  const head = `<tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const body = rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('\n');
  return `<table>\n${head}\n${body}\n</table>`;
}

/**
 * Render the HTML dashboard from a `summarize()` result.
 * All job-derived content is HTML-escaped.
 * @param {object} summary
 * @returns {string}
 */
export function renderHtml(summary) {
  const { totals, bySource, byDiscovery, sponsorship, discardReasons, missingKeywords, topJobs } = summary;

  const totalsTable = htmlTable(
    ['Found', 'Scored', 'Priority', 'Apply', 'Queued', 'Prepared', 'Discarded', 'Weak match'],
    [[totals.found, totals.scored, totals.priority, totals.apply, totals.queued,
      totals.prepared, totals.discarded, totals.weakMatch]],
  );

  const sourceRows = Object.entries(bySource)
    .map(([source, s]) => [source, s.found, s.kept, s.discarded, s.prepared]);
  const sourceTable = htmlTable(['Source', 'Found', 'Kept', 'Discarded', 'Prepared'], sourceRows);

  const discoveryRows = Object.entries(byDiscovery).map(([k, v]) => [k, v]);
  const sponsorshipRows = Object.entries(sponsorship).map(([k, v]) => [k, v]);
  const discardRows = Object.entries(discardReasons).map(([k, v]) => [k, v]);
  const keywordRows = missingKeywords.slice(0, 15).map((m) => [m.key, m.count]);
  const topRows = topJobs.map((j) => [j.score, j.tier ?? '', j.company ?? '', j.title ?? '', j.sponsorship ?? '', j.url ?? '']);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>job-agent report</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  table { border-collapse: collapse; margin-top: 0.5rem; }
  th, td { border: 1px solid #ccc; padding: 4px 10px; text-align: left; font-size: 0.9rem; }
  th { background: #f3f3f3; }
</style>
</head>
<body>
<h1>job-agent report</h1>
<h2>Totals</h2>
${totalsTable}
<h2>By source</h2>
${sourceTable}
<h2>By discovery match</h2>
${htmlTable(['Match', 'Count'], discoveryRows)}
<h2>Sponsorship</h2>
${htmlTable(['Status', 'Count'], sponsorshipRows)}
<h2>Discard reasons</h2>
${htmlTable(['Reason', 'Count'], discardRows)}
<h2>Top missing keywords</h2>
${htmlTable(['Keyword', 'Count'], keywordRows)}
<h2>Top jobs</h2>
${htmlTable(['Score', 'Tier', 'Company', 'Title', 'Sponsorship', 'URL'], topRows)}
</body>
</html>`;
}

/**
 * Write the JSON/CSV/HTML report files for a run.
 *
 * @param {object} args
 * @param {object[]} args.jobs report rows
 * @param {string} args.outDir directory for the report files (created if needed)
 * @param {string} [args.stamp] filename stamp; defaults to today's YYYYMMDD
 * @returns {{ files: { json: string, csv: string, html: string }, summary: object }}
 */
export function generateReport({ jobs = [], outDir, stamp } = {}) {
  if (!outDir) throw new Error('generateReport requires an outDir');
  const tag = stamp ?? dateStamp();
  mkdirSync(outDir, { recursive: true });

  const summary = summarize(jobs);
  const files = {
    json: join(outDir, `report-${tag}.json`),
    csv: join(outDir, `report-${tag}.csv`),
    html: join(outDir, `report-${tag}.html`),
  };
  writeFileSync(files.json, JSON.stringify(summary, null, 2), 'utf8');
  writeFileSync(files.csv, renderCsv(jobs), 'utf8');
  writeFileSync(files.html, renderHtml(summary), 'utf8');
  return { files, summary };
}
