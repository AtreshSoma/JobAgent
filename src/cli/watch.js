/**
 * WATCH — continuous, incremental discovery to catch brand-new postings fast.
 *
 * Goal: help you be among the FIRST to apply. Each cycle it re-runs discovery,
 * scores everything, and tailors a ready-to-submit packet for any NEW strong
 * match — then alerts you immediately (a console banner + terminal bell) so you
 * can open it and apply while the posting is still fresh.
 *
 * Honest scope (by design, non-negotiable):
 *   - It NEVER auto-submits. LinkedIn/Indeed forbid automated submission via a
 *     logged-in session (account-ban risk), and this assistant is human-approved
 *     only. Watch gets you a tailored packet + an instant alert; you click apply.
 *   - It cannot guarantee "applicant #1": there is real latency between a posting
 *     going live, the public board/scraper indexing it, and the next poll. Watch
 *     minimizes that gap; it does not eliminate it.
 *
 * Cost note: free public boards (Greenhouse/Lever/Ashby/Workday/SmartRecruiters)
 * cost nothing to poll continuously. Apify sources (LinkedIn/Indeed) charge per
 * result on every cycle. Use `--free-only` for zero-cost watching, or a longer
 * interval to limit Apify spend.
 */

import { runPrepareApps } from './commands.js';
import { ui } from './ui.js';
import { formatPostedRelative } from '../utils/dates.js';

/** Minimum poll interval (minutes) — protects public endpoints and your wallet. */
const MIN_INTERVAL_MINUTES = 5;

/** Default poll interval when none is provided. */
const DEFAULT_INTERVAL_MINUTES = 20;

/** Default "early applicant window": alert extra-loud under this age (minutes). */
const DEFAULT_FRESH_ALERT_MINUTES = 60;

/**
 * Run a SINGLE watch cycle: discover -> score -> prepare NEW jobs only, and
 * return the newly-queued matches (those not already in the DB before the cycle).
 *
 * @param {object} args
 * @param {object} args.config loadConfig bundle
 * @param {import('../logging/db.js').Database} args.db
 * @param {object} args.logger
 * @param {object} [args.options] { freeOnly, freshAlertMinutes }
 * @param {object} [args.deps] { runPrepareAppsFn, searchFn, tailorFn, now, stamp }
 * @returns {Promise<{ newMatches: object[], counters: object, knownBefore: number }>}
 */
export async function runWatchCycle({ config, db, logger, options = {}, deps = {} } = {}) {
  const runPrepareAppsFn = deps.runPrepareAppsFn ?? runPrepareApps;
  const freshAlertMinutes = Number.isFinite(options.freshAlertMinutes)
    ? options.freshAlertMinutes : DEFAULT_FRESH_ALERT_MINUTES;
  const nowDate = resolveNow(deps.now);

  // Snapshot what we already know BEFORE the cycle so we can detect new postings.
  const knownBefore = db.getKnownJobIds();

  const cycleConfig = withWatchOverrides(config, options);
  const result = await runPrepareAppsFn({
    config: cycleConfig,
    db,
    logger,
    deps: {
      searchFn: deps.searchFn,
      tailorFn: deps.tailorFn,
      now: nowDate,
      stamp: deps.stamp,
      // Only tailor packets for jobs we had never seen before this cycle.
      prepareFilter: (job) => !knownBefore.has(job.id),
    },
  });

  const queued = Array.isArray(result.queued) ? result.queued : [];
  const newMatches = queued
    .filter((row) => !knownBefore.has(row.id))
    .map((row) => decorateMatch(row, nowDate, freshAlertMinutes))
    .sort((a, b) => Number(b.urgent) - Number(a.urgent) || (b.score ?? 0) - (a.score ?? 0));

  return { newMatches, counters: result.counters, knownBefore: knownBefore.size };
}

/**
 * Run watch continuously until stopped (Ctrl+C) or `--once`.
 *
 * @param {object} args
 * @param {object} args.config
 * @param {import('../logging/db.js').Database} args.db
 * @param {object} args.logger
 * @param {object} [args.options] { intervalMinutes, freeOnly, once, freshAlertMinutes }
 * @param {object} [args.deps]
 *   { runPrepareAppsFn, searchFn, tailorFn, now, sleep, shouldStop, maxCycles, silent }
 * @returns {Promise<{ cycles: number, totalNew: number }>}
 */
export async function runWatch({ config, db, logger, options = {}, deps = {} } = {}) {
  const intervalMinutes = clampInterval(options.intervalMinutes);
  const intervalMs = intervalMinutes * 60_000;
  const freeOnly = options.freeOnly === true;
  const once = options.once === true;
  const sleep = deps.sleep ?? defaultSleep;
  const shouldStop = deps.shouldStop ?? (() => false);
  const silent = deps.silent === true;

  if (!silent) printWatchHeader({ config, intervalMinutes, freeOnly });

  let cycles = 0;
  let totalNew = 0;
  for (;;) {
    if (shouldStop()) break;
    cycles += 1;
    const startedAt = resolveNow(deps.now);
    const { newMatches, counters } = await runWatchCycle({
      config, db, logger,
      options: { freeOnly, freshAlertMinutes: options.freshAlertMinutes },
      deps,
    });
    totalNew += newMatches.length;
    if (!silent) printCycleResult({ cycle: cycles, startedAt, newMatches, counters, intervalMinutes, once });

    if (once) break;
    if (deps.maxCycles && cycles >= deps.maxCycles) break;
    if (shouldStop()) break;
    await interruptibleSleep(intervalMs, shouldStop, sleep);
  }

  if (!silent) {
    ui.blank();
    ui.success(`Watch stopped after ${cycles} cycle(s); ${totalNew} new match(es) surfaced.`);
  }
  return { cycles, totalNew };
}

/**
 * Produce a config clone with watch-appropriate overrides:
 *   - freshness forced to the last 24 hours (the whole point of watching), and
 *   - (optional) Apify sources disabled for zero-cost continuous polling.
 * The original config object is never mutated.
 */
export function withWatchOverrides(config, options = {}) {
  // Note: the runtime's includeLast3DaysFallback is intentionally preserved —
  // when a 24h cycle finds too few dated jobs, widening to 3 days keeps watch
  // useful on quiet days (tests encode this contract).
  const runtime = { ...(config.runtime ?? {}), jobFreshnessMode: 'LAST_24_HOURS' };
  let jobboards = config.jobboards;
  if (options.freeOnly === true) {
    const sources = (config.jobboards?.sources ?? []).map((s) =>
      s.adapter === 'apify' ? { ...s, enabled: false } : s);
    jobboards = { ...config.jobboards, sources };
  }
  return { ...config, runtime, jobboards };
}

/** Decorate a queued board row with freshness/urgency for alerting. */
function decorateMatch(row, nowDate, freshAlertMinutes) {
  const minutesOld = minutesSince(row.postedAt, nowDate);
  const urgent = minutesOld !== null && minutesOld <= freshAlertMinutes;
  return {
    id: row.id,
    company: row.company,
    title: row.title,
    location: row.location,
    url: row.url,
    score: row.score ?? null,
    tier: row.tier ?? null,
    sponsorship: row.sponsorship ?? null,
    postedAt: row.postedAt ?? null,
    minutesOld,
    urgent,
    packetPath: row.packetPath ?? null,
  };
}

/** Whole minutes since an ISO timestamp, or null when undated/unparseable. */
function minutesSince(postedAt, nowDate) {
  if (!postedAt) return null;
  const t = Date.parse(postedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((nowDate.getTime() - t) / 60_000));
}

/** Resolve a now value (Date or () => Date or undefined) to a Date. */
function resolveNow(now) {
  if (typeof now === 'function') return now();
  if (now instanceof Date) return now;
  return new Date();
}

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, n);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep in 1s slices so Ctrl+C is honored promptly between cycles. */
async function interruptibleSleep(ms, shouldStop, sleep) {
  const slice = 1000;
  let waited = 0;
  while (waited < ms) {
    if (shouldStop()) return;
    await sleep(Math.min(slice, ms - waited));
    waited += slice;
  }
}

function printWatchHeader({ config, intervalMinutes, freeOnly }) {
  ui.heading('Watch — be first to apply');
  ui.note('Continuously finds brand-new postings, tailors a packet, and alerts you.');
  ui.note('It never submits for you — you review and click apply (LinkedIn/Indeed ToS).');
  ui.blank();
  const apifyOn = !freeOnly && (config.jobboards?.sources ?? [])
    .some((s) => s.adapter === 'apify' && s.enabled);
  ui.stats([
    ['Poll interval', `${intervalMinutes} min`],
    ['Freshness', 'last 24 hours'],
    ['Paid sources', freeOnly ? 'OFF (free boards only)' : (apifyOn ? 'ON (LinkedIn/Indeed via Apify — charges per cycle)' : 'none enabled')],
  ]);
  if (apifyOn) {
    ui.warn('Apify sources run every cycle and cost money. Use --free-only or a longer --interval to reduce spend.');
  }
  ui.blank();
  ui.note('Press Ctrl+C to stop.');
}

function printCycleResult({ cycle, startedAt, newMatches, counters, intervalMinutes, once }) {
  const stamp = startedAt.toLocaleTimeString();
  ui.blank();
  ui.heading(`Cycle ${cycle} · ${stamp}`);
  ui.stats([
    ['Found this cycle', counters?.jobs_found ?? 0],
    ['New matches', newMatches.length, newMatches.length ? 'good' : 'muted'],
  ]);

  if (newMatches.length) {
    // Audible bell once per cycle when there's anything new to act on.
    process.stdout.write('\u0007');
    ui.blank();
    for (const m of newMatches) {
      const posted = formatPostedRelative(m.postedAt);
      const head = `${m.company || 'Unknown'} — ${m.title || 'Untitled role'}`;
      const meta = `${m.tier ?? '—'} · ${m.score ?? '—'}/100 · Posted ${posted}`;
      if (m.urgent) {
        ui.success(`[BE EARLY] ${head}`);
        ui.note(`           ${meta}${m.minutesOld != null ? ` · ${m.minutesOld} min old` : ''}`);
      } else {
        ui.list('', [`${head}  (${meta})`]);
      }
      if (m.url) ui.note(`           ${m.url}`);
    }
    ui.blank();
    ui.next([
      'Apply one-by-one (opens browser, fills, stops before submit):  npm run apply',
      'Or review everything in the cockpit:  npm run dashboard',
    ]);
  } else {
    ui.note('No new postings this cycle.');
  }

  if (!once) ui.note(`Next check in ${intervalMinutes} min…`);
}
