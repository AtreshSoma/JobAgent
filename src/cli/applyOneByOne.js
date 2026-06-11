/**
 * Apply — one application at a time.
 *
 * The all-at-once `assist` opens every approved application in its own browser
 * window simultaneously, which is overwhelming and easy to lose track of. This
 * runner instead walks through approved packets ONE AT A TIME:
 *
 *   1. Show the job + exactly which tailored resume / cover letter will be used
 *      and where they live on disk.
 *   2. Open a single browser, fill the known fields, and STOP before submit.
 *   3. Tell you plainly what was filled and what still needs your attention.
 *   4. Wait for you to review and submit in that one window, then close it and
 *      move to the next — only when you say you're ready.
 *
 * Nothing is ever submitted automatically. The browser stays open for your
 * review and is closed only after you press Enter to continue.
 */

import { createInterface } from 'node:readline/promises';
import { relative } from 'node:path';

import { assistApply } from '../automation/applyRunner.js';
import { createBrowserSession } from '../automation/browser.js';
import { loadPacket, recordAssistResult } from './commands.js';
import { listPending, APPROVAL_STATUS } from '../apply/approvalQueue.js';
import { parseSelection } from './guided.js';
import { isAggregatorHost } from '../search/adapters/apify.js';
import { writeJobTracker } from '../reports/jobTracker.js';
import { EVENT_TYPES } from '../logging/jobLogger.js';
import { ui } from './ui.js';
import { formatPostedRelative } from '../utils/dates.js';

/** Project-relative path with forward slashes, for tidy output. */
function rel(root, p) {
  if (!p) return '';
  try { return relative(root, p).split('\\').join('/'); }
  catch { return String(p); }
}

/** Current timestamp as ISO; honours an injected clock for tests. */
function nowIso(now) {
  return (typeof now === 'function' ? now() : now ?? new Date()).toISOString();
}

/** Build a readline-backed prompt; `.close()` releases the handle. */
function makePrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim();
  ask.close = () => rl.close();
  return ask;
}

/** Friendly "Company — Role" label from a packet. */
function jobLabel(packet) {
  const job = packet?.job ?? {};
  return `${job.company ?? '—'} — ${job.title ?? '—'}`;
}

/**
 * Walk approved applications one at a time, filling each and pausing for the
 * human to review + submit before moving on.
 *
 * @param {object} args
 * @param {object} args.config loadConfig() bundle
 * @param {import('../logging/db.js').Database} args.db
 * @param {object} args.logger JobLogger
 * @param {object} [args.options] { all }
 * @param {object} [args.deps] { prompt, interactive, assistFn, createSession, now }
 * @returns {Promise<{ results: object[] }>}
 */
export async function runApply({ config, db, logger, options = {}, deps = {} } = {}) {
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
  const prompt = deps.prompt ?? (interactive ? makePrompt() : null);
  const assistFn = deps.assistFn ?? assistApply;
  const makeSession = deps.createSession ?? createBrowserSession;

  ui.heading('Apply · one at a time');

  try {
    const approvals = db.listApprovals({ status: APPROVAL_STATUS.APPROVED });
    const items = approvals
      .map((approval) => ({ approval, packet: loadPacket(approval, deps) }))
      .filter((x) => x.packet && x.packet.job?.url);

    // Idempotency: never re-list a job that was already submitted. This keeps
    // finished applications out of the menu AND prevents a re-fill from
    // clobbering their "submitted" status in the tracker.
    const alreadyApplied = [];
    const pendingItems = items.filter(({ packet }) => {
      const row = db.getJob?.(packet.job?.id) ?? null;
      const done = row && (Number(row.applied) === 1 || row.status === 'submitted');
      if (done) alreadyApplied.push(packet);
      return !done;
    });
    if (alreadyApplied.length) {
      ui.blank();
      ui.note(`Skipping ${alreadyApplied.length} already-submitted job(s): ${alreadyApplied.map((p) => jobLabel(p)).join(', ')}.`);
    }

    if (!pendingItems.length) {
      const pending = listPending(db);
      ui.blank();
      if (pending.length) {
        ui.warn(`No approved applications left to apply — ${pending.length} are waiting for your approval.`);
        ui.blank();
        ui.next([{ text: 'Approve them first:', cmd: 'npm start' }]);
      } else {
        ui.warn('No prepared applications found.');
        ui.blank();
        ui.next([{ text: 'Find & prepare jobs first:', cmd: 'npm start' }]);
      }
      return { results: [] };
    }

    /* ── Show the menu ──────────────────────────────────────────────────── */
    ui.step('I will open these ONE AT A TIME, fill each, and wait for you to submit.');
    ui.blank();
    ui.list('Approved & ready to apply',
      pendingItems.map(({ packet }, i) => {
        const job = packet.job ?? {};
        const posted = `Posted: ${formatPostedRelative(job.postedAt ?? job.posted_at ?? null)}`;
        const meta = `${packet.tier ? `${packet.tier} · ` : ''}${typeof packet.score === 'number' ? `${packet.score}/100 ` : ''}${posted}${job.location ? ` · ${job.location}` : ''}`.trim();
        return `${ui.c.bold(`[${i + 1}]`)} ${jobLabel(packet)}  ${ui.c.dim(`(${meta})`)}`;
      }),
      { symbol: ' ' });

    /* ── Choose which to apply to ────────────────────────────── */
    let chosen;
    if (options.all) {
      chosen = pendingItems.map((_, i) => i);
      ui.blank();
      ui.note(`--all: going through all ${pendingItems.length}.`);
    } else if (!interactive || !prompt) {
      ui.blank();
      ui.note('Not an interactive terminal — cannot open browsers here.');
      ui.blank();
      ui.next([{ text: 'Run this in your terminal:', cmd: 'npm run apply' }]);
      return { results: [] };
    } else {
      ui.blank();
      const answer = await prompt(
        `${ui.c.bold('Apply to which?')} ${ui.c.dim('[a]ll · numbers e.g. 1,3 or 1-5 · [q]uit')}  › `);
      chosen = parseSelection(answer, pendingItems.length);
    }

    if (!chosen.length) {
      ui.blank();
      ui.note('Nothing selected — no browsers opened.');
      return { results: [] };
    }

    /* ── Walk them one at a time ────────────────────────────────────────── */
    const results = [];
    let submittedCount = 0;
    let skippedCount = 0;
    for (let k = 0; k < chosen.length; k++) {
      const item = pendingItems[chosen[k]];
      if (!item) continue;
      const { approval, packet } = item;
      const job = packet.job ?? {};

      ui.blank();
      ui.heading(`Job ${k + 1} of ${chosen.length} · ${jobLabel(packet)}`);
      ui.stats([
        ['Posted', formatPostedRelative(job.postedAt ?? job.posted_at ?? null), 'muted'],
        ['Location', job.location || '—', 'muted'],
        ['Score', typeof packet.score === 'number' ? `${packet.score}/100 (${packet.tier ?? '—'})` : '—', 'muted'],
        ['Apply URL', job.url || '—', 'muted'],
      ]);
      ui.blank();
      ui.files([
        rel(config.root, packet.resumePath),
        rel(config.root, packet.coverLetterPath),
      ]);

      // Stale aggregator links (e.g. indeed.com/viewjob) hit a Cloudflare
      // "Additional Verification Required" wall that we never bypass. Warn the
      // human up front and let them skip rather than walk into a dead page.
      if (isAggregatorHost(job.url || '')) {
        ui.blank();
        ui.warn('This is an Indeed/aggregator link — it will hit a "verification required" wall.');
        ui.note('Refresh it to a direct company link first:  npm run discover  →  npm run prepare-apps');
        if (interactive && prompt) {
          const go = (await prompt(
            `${ui.c.bold('Open it anyway?')} ${ui.c.dim('[y]es · [Enter] skip this one')}  › `)).trim().toLowerCase();
          if (go !== 'y' && go !== 'yes') {
            try { db.upsertJob({ id: job.id, status: 'skipped' }); } catch { /* ignore */ }
            skippedCount += 1;
            ui.note('Skipped — recorded in your tracker.');
            continue;
          }
        }
      }

      // Open ONE browser; capture the live session so we can close it on demand.
      let session = null;
      const captureDeps = {
        ...deps,
        createSession: async (a) => { session = await makeSession(a); return session; },
      };

      ui.blank();
      ui.step('Opening the application page and filling what I can…');
      const result = await assistFn({
        packet, config, mode: 'LIVE_ASSIST', approval, options, deps: captureDeps,
      });
      results.push(result);
      recordAssistResult(db, job.id, result);
      logger?.event?.(EVENT_TYPES.PREFILL_STARTED, {
        jobId: job.id,
        message: `apply ${result.status}`,
        meta: { status: result.status, blockers: result.blockers?.length ?? 0 },
      });

      reportFillOutcome(result);

      // Pause for the human to review + submit in this single window, then
      // record what they actually did so the Excel tracker is accurate.
      let outcome = 'later';
      if (interactive && prompt) {
        ui.blank();
        const ans = (await prompt(
          `${ui.c.green('→')} Review in the browser. Did you submit it? ` +
          `${ui.c.dim('[s]ubmitted · s[k]ip · [Enter] decide later · [q]uit')}  › `)).trim().toLowerCase();
        if (ans === 'q' || ans === 'quit') outcome = 'quit';
        else if (ans === 's' || ans === 'submitted' || ans === 'y' || ans === 'yes') outcome = 'submitted';
        else if (ans === 'k' || ans === 'skip' || ans === 'n' || ans === 'no') outcome = 'skipped';
        else outcome = 'later';
      }

      if (outcome === 'submitted') {
        try {
          db.upsertJob({ id: job.id, applied: 1, applied_at: nowIso(deps.now), status: 'submitted' });
        } catch { /* ignore */ }
        logger?.event?.(EVENT_TYPES.APPLICATION_SUBMITTED, {
          jobId: job.id, message: `marked submitted by user`, meta: { company: job.company, title: job.title },
        });
        submittedCount += 1;
        ui.success('Recorded as Submitted in your tracker.');
      } else if (outcome === 'skipped') {
        try { db.upsertJob({ id: job.id, status: 'skipped' }); } catch { /* ignore */ }
        logger?.event?.(EVENT_TYPES.PREFILL_STARTED, {
          jobId: job.id, message: `skipped by user`, meta: { status: 'skipped' },
        });
        skippedCount += 1;
        ui.note('Recorded as Skipped in your tracker.');
      } else {
        ui.note('Left as "Filled — ready to submit" so you can decide later.');
      }

      try { await session?.close?.(); } catch { /* ignore */ }
      if (outcome === 'quit') { ui.blank(); ui.note('Stopping here — the rest stay ready for next time.'); break; }
    }

    // Keep the Excel tracker in step with the latest statuses.
    const tracker = writeJobTracker(db, config.root);

    ui.blank();
    ui.heading('Done for now');
    ui.success(`Walked through ${results.length} application(s). Nothing was auto-submitted.`);
    ui.stats([
      ['Marked submitted', submittedCount, submittedCount ? 'good' : 'muted'],
      ['Marked skipped', skippedCount, skippedCount ? 'warn' : 'muted'],
      ['Left for later', Math.max(0, results.length - submittedCount - skippedCount), 'muted'],
    ]);
    ui.blank();
    ui.files([rel(config.root, tracker.path)]);
    ui.blank();
    ui.next([
      { text: 'Open the tracker to see Submitted / Skipped per job, or re-run:', cmd: 'npm run apply' },
    ]);
    return { results };
  } finally {
    if (prompt?.close) prompt.close();
  }
}

/** Print a short, plain-language outcome for one filled application. */
function reportFillOutcome(result) {
  ui.blank();
  if (result.guard?.blocked) {
    ui.warn(`This page is protected (${result.guard.kind}) — I stopped and did not fill it.`);
    ui.note('Open the apply URL yourself and complete it manually if you want this one.');
    return;
  }

  const filled = result.filled?.length ?? 0;
  const uploads = result.uploads?.uploaded?.length ?? 0;
  ui.stats([
    ['Fields filled', filled, filled ? 'good' : 'muted'],
    ['Files uploaded', uploads, uploads ? 'good' : 'muted'],
    ['Submitted', 'No — waiting for you', 'warn'],
  ]);

  const needs = [];
  for (const nu of result.unresolved ?? []) needs.push(`Fill in: ${nu.label ?? nu.field ?? nu}`);
  for (const b of result.blockers ?? []) needs.push(b);
  if (needs.length) {
    ui.blank();
    ui.list('Needs your attention before submitting', needs.slice(0, 8), { symbol: '•' });
  } else {
    ui.blank();
    ui.note('Looks complete — just review and click submit.');
  }
}
