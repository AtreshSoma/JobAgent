#!/usr/bin/env node
/**
 * Fetch the descriptions of jobs that were stored but never actually read, then
 * re-score them for real.
 *
 * WHY THIS EXISTS
 * ---------------
 * Discovery reads a board's LIST endpoint cheaply and then pays one extra
 * request per posting for the full description. That per-board budget is small
 * (Workday allows 8 per tenant across 214 tenants), so most postings are stored
 * with a "teaser": a title, a location, and a few bullet fields.
 *
 * The scorer then judged them anyway — and the arithmetic makes the outcome
 * inevitable. With no description there are no stack, domain or keyword hits to
 * find, so the reachable maximum is ~44/100 against a 50 floor. EVERY
 * summary-only posting is a guaranteed Discard no matter how well it fits.
 * Measured on this database: 31,409 rows were scored on under 200 characters
 * and exactly 2 ever reached the board. Among the casualties were "Microsoft
 * Fabric Data Engineer", "Senior BI Engineer - PowerBI and Microsoft Fabric
 * with Finance exp" and "Senior Microsoft Fabric Data Modeler / Semantic Model
 * Architect" — the exact target profile, discarded unseen.
 *
 * Those rows were never judged unfit. They were never read. This recovers them.
 *
 * WHAT IT DOES
 * ------------
 * Selects stored rows that (a) have no real description, (b) carry a title the
 * profile accepts, and (c) sit on a source whose per-job page can be fetched.
 * It fetches each description from the SAME public endpoint the adapter would
 * have used, writes it back, re-scores from the real text, and updates status
 * and tier. Nothing is discovered here — this is strictly enrichment of rows
 * already in the database.
 *
 * Usage
 * -----
 *   node scripts/enrichDescriptions.mjs                 # dry run: report only
 *   node scripts/enrichDescriptions.mjs --apply         # write descriptions + rescore
 *   node scripts/enrichDescriptions.mjs --limit=500     # cap work (default 250)
 *   node scripts/enrichDescriptions.mjs --source=workday
 *   node scripts/enrichDescriptions.mjs --min-score=0   # widen the candidate set
 *
 * Politeness matches discovery: bounded concurrency, a per-host gate, the same
 * identifying User-Agent, and no retry storms. Nothing is written without
 * --apply.
 */

import { loadConfig } from '../src/config/loadConfig.js';
import { openDatabase } from '../src/logging/db.js';
import { buildProfileVocabulary, classifyTitleFit } from '../src/scoring/profileFit.js';
import { scoreJob } from '../src/scoring/scorer.js';
import { explainScore, TIERS } from '../src/scoring/explainScore.js';
import { classifySponsorship } from '../src/scoring/sponsorshipClassifier.js';
import { applyExclusions } from '../src/scoring/exclusionFilter.js';
import { mapWithConcurrency } from '../src/utils/concurrency.js';
import { fetchWithTimeout, discoveryHeaders } from '../src/utils/httpClient.js';
import { createHostGate } from '../src/utils/hostGate.js';
import { htmlToText, parseJsonLdJobs } from '../src/search/normalize.js';

const TIMEOUT_MS = 20_000;
const CONCURRENCY = 4;
/** Below this, a stored jd_text is a teaser rather than a real description. */
const TEASER_MAX_CHARS = 400;

function parseArgs(argv) {
  const args = { apply: false, limit: 250, source: null, minScore: null };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--limit=')) args.limit = Math.max(1, Number(a.split('=')[1]) || 250);
    else if (a.startsWith('--source=')) args.source = a.split('=')[1];
    else if (a.startsWith('--min-score=')) args.minScore = Number(a.split('=')[1]);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`
Fetch descriptions for stored jobs that were never read, then re-score them.

  --apply          Write descriptions and re-score (default: dry run)
  --limit=N        Maximum jobs to enrich this pass (default 250)
  --source=NAME    Only this source (workday, oracleRecruiting, icims, ...)
  --min-score=N    Only rows scoring at least N (default: no floor)
  -h, --help       Show this help
`);
}

/**
 * How to fetch one posting's description, per source.
 *
 * Each reuses the public endpoint its adapter already reads — no new surface,
 * no login, no evasion. A source with no strategy here is skipped rather than
 * guessed at.
 */
const FETCHERS = {
  /** Workday CXS per-job detail, derived from the stored public URL. */
  async workday(row, ctx) {
    const u = new URL(row.url);
    const segs = u.pathname.split('/').filter(Boolean);
    const jobIdx = segs.indexOf('job');
    if (jobIdx === -1) return null;
    // <host>/[locale]/<site>/job/... -> tenant is the host label, site precedes /job.
    const site = segs[jobIdx - 1];
    const tenant = u.hostname.split('.')[0];
    const path = `/${segs.slice(jobIdx).join('/')}`;
    const api = `https://${u.hostname}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}${path}`;
    const data = await getJson(api, ctx);
    const info = data?.jobPostingInfo ?? {};
    const text = htmlToText(info.jobDescription ?? info.jobDescriptionText ?? '');
    // The LIST endpoint collapses a multi-location req to "2 Locations", so the
    // real places and the authoritative country only exist here.
    const places = [info.location, ...(Array.isArray(info.additionalLocations) ? info.additionalLocations : [])]
      .map((x) => String(x ?? '').replace(/,\s*$/, '').trim()).filter(Boolean);
    const country = typeof (info.country?.descriptor ?? info.country) === 'string'
      ? String(info.country.descriptor ?? info.country).trim() : null;
    return text
      ? { text, postedAt: info.startDate ?? null, location: places.join('; ') || null, country }
      : null;
  },

  /** Oracle Recruiting detail endpoint. */
  async oracleRecruiting(row, ctx) {
    const u = new URL(row.url);
    const segs = u.pathname.split('/').filter(Boolean);
    const site = segs[segs.indexOf('sites') + 1];
    const id = segs[segs.indexOf('job') + 1];
    if (!site || !id) return null;
    const api = `https://${u.hostname}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
      + `?expand=all&onlyData=true&finder=ById;Id="${encodeURIComponent(id)}",siteNumber=${site}`;
    const detail = (await getJson(api, ctx))?.items?.[0];
    if (!detail) return null;
    const text = [
      detail.ExternalDescriptionStr, detail.ExternalResponsibilitiesStr,
      detail.ExternalQualificationsStr, detail.CorporateDescriptionStr,
    ].map((p) => htmlToText(String(p ?? '')).trim()).filter(Boolean).join('\n\n');
    return text ? { text, postedAt: detail.ExternalPostedStartDate ?? null } : null;
  },

  /** iCIMS renders the real document behind in_iframe=1. */
  async icims(row, ctx) {
    const u = new URL(row.url);
    u.searchParams.set('in_iframe', '1');
    const html = await getText(u.href, ctx);
    const [job] = parseJsonLdJobs(html, { url: row.url, source: 'icims' });
    if (job?.jdText) return { text: job.jdText, postedAt: job.postedAt ?? null };
    const text = htmlToText(html).slice(0, 12000);
    return text ? { text, postedAt: null } : null;
  },

  /** SmartRecruiters publishes a per-posting JSON document. */
  async smartrecruiters(row, ctx) {
    const m = /jobs\.smartrecruiters\.com\/([^/]+)\/(\d+)/.exec(row.url);
    if (!m) return null;
    const data = await getJson(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`, ctx);
    const s = data?.jobAd?.sections ?? {};
    const text = [
      s.companyDescription?.text, s.jobDescription?.text,
      s.qualifications?.text, s.additionalInformation?.text,
    ].map((p) => htmlToText(String(p ?? '')).trim()).filter(Boolean).join('\n\n');
    return text ? { text, postedAt: data?.releasedDate ?? null } : null;
  },
};

async function getJson(url, ctx) {
  const res = await ctx.gate.run(url, () => fetchWithTimeout(
    fetch, url, { headers: discoveryHeaders({ Accept: 'application/json' }) }, TIMEOUT_MS,
  ));
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

async function getText(url, ctx) {
  const res = await ctx.gate.run(url, () => fetchWithTimeout(
    fetch, url, { headers: discoveryHeaders({ Accept: 'text/html' }) }, TIMEOUT_MS,
  ));
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.text();
}

async function main() {
  const args = parseArgs(process.argv);
  const config = loadConfig({ loadEnv: true, env: process.env });
  const db = openDatabase({});
  const vocab = buildProfileVocabulary(config.candidate);
  const now = new Date();

  console.log('Enriching jobs that were stored but never read\n');

  // Candidates: no real description, a title the profile accepts, and a source
  // we know how to fetch. Rows the human already acted on are left alone.
  const rows = db.listJobs({}).filter((r) => {
    if (!r.url) return false;
    if ((r.jd_text ?? '').length >= TEASER_MAX_CHARS) return false;
    if (!FETCHERS[r.source]) return false;
    if (args.source && r.source !== args.source) return false;
    if (args.minScore !== null && Number(r.score ?? 0) < args.minScore) return false;
    if (['applied', 'submitted', 'prepared', 'assist_blocked'].includes(r.status)) return false;
    return classifyTitleFit(r.title, vocab).verdict === 'accept';
  });

  console.log(`  ${rows.length.toLocaleString()} stored job(s) have a matching title but no description`);
  const bySource = new Map();
  for (const r of rows) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
  for (const [s, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(20)} ${n}`);
  }

  const batch = rows.slice(0, args.limit);
  console.log(`\n  enriching ${batch.length} this pass (--limit=${args.limit})`);
  if (!args.apply) console.log('  DRY RUN — nothing will be written. Re-run with --apply.\n');

  const gate = createHostGate({ maxConcurrent: 4 });
  const stats = { fetched: 0, failed: 0, improved: 0, nowActionable: 0, stillWeak: 0, geoDropped: 0 };
  const promoted = [];

  await mapWithConcurrency(batch, CONCURRENCY, async (row) => {
    let got;
    try {
      got = await FETCHERS[row.source](row, { gate });
    } catch (err) {
      stats.failed += 1;
      return;
    }
    if (!got?.text) { stats.failed += 1; return; }
    stats.fetched += 1;

    const job = {
      id: row.id, source: row.source, company: row.company, title: row.title,
      location: got.location ?? row.location, url: row.url, jdText: got.text,
      postedAt: got.postedAt ?? row.posted_at, employmentType: row.employment_type,
      // An explicit country from the provider is decisive for the US-only gate.
      rawMetadata: got.country ? { country: got.country } : {},
    };

    // Same chain discovery uses, so an enriched row is judged identically.
    const exclusion = applyExclusions(job, config.exclusions, { now, candidate: config.candidate });
    const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
    const score = scoreJob(job, { scoring: config.scoring, sponsorship, candidate: config.candidate, now });
    const titleVerdict = classifyTitleFit(job.title, vocab).verdict;
    const { tier, explanation } = explainScore(score, config.scoring, { titleVerdict, candidate: config.candidate });

    const before = Number(row.score ?? 0);
    if (score.total > before) stats.improved += 1;
    if (exclusion.excluded && exclusion.category === 'geography_mismatch') stats.geoDropped += 1;
    const actionable = !exclusion.excluded && tier !== TIERS.DISCARD;
    if (actionable) {
      stats.nowActionable += 1;
      promoted.push({ ...row, newScore: score.total, tier, before });
    } else {
      stats.stillWeak += 1;
    }

    if (args.apply) {
      db.upsertJob({
        id: row.id,
        jd_text: got.text,
        posted_at: job.postedAt,
        location: job.location,
        summary_only: 0,
        score: score.total,
        tier: exclusion.excluded ? null : tier,
        sponsorship: sponsorship.status,
        sponsorship_signals: sponsorship.signals ?? [],
        explanation,
        matched_keywords: score.matchedKeywords,
        missing_keywords: score.missingKeywords,
        status: exclusion.excluded
          ? 'discarded'
          : (tier === TIERS.DISCARD ? 'discarded' : 'scored'),
        discard_reason: exclusion.excluded
          ? exclusion.reason
          : (tier === TIERS.DISCARD ? 'below score threshold (description now read)' : null),
      });
    }
  });

  console.log('\n================ RESULT ================');
  console.log(`  descriptions fetched : ${stats.fetched}`);
  console.log(`  fetch failed/skipped : ${stats.failed}`);
  console.log(`  score improved       : ${stats.improved}`);
  console.log(`  NOW ACTIONABLE       : ${stats.nowActionable}   <- recovered`);
  console.log(`  genuinely weak       : ${stats.stillWeak}`);
  console.log(`  revealed as NON-US   : ${stats.geoDropped}   <- location/country resolved`);

  if (promoted.length) {
    console.log('\n---- recovered jobs (were unread, now scored on real text) ----');
    for (const p of promoted.sort((a, b) => b.newScore - a.newScore).slice(0, 25)) {
      console.log(`  ${String(p.before).padStart(2)} -> ${String(p.newScore).padStart(3)} ${String(p.tier).padEnd(10)} ${(p.company ?? '').slice(0, 24).padEnd(25)} ${(p.title ?? '').slice(0, 46)}`);
    }
  }

  if (!args.apply) {
    console.log(`\n  DRY RUN — nothing written. Re-run with --apply to keep these ${stats.nowActionable} recoveries.`);
  } else {
    console.log(`\n  Wrote ${stats.fetched} description(s) and re-scored them.`);
    if (rows.length > batch.length) {
      console.log(`  ${rows.length - batch.length} still unread — run again to continue.`);
    }
  }
}

main().catch((err) => {
  console.error(`enrichDescriptions failed: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
