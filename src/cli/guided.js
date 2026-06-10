/**
 * Guided runner — the "one command" experience.
 *
 * Collapses the whole flow into a single interactive session:
 *
 *   1. FIND & PREPARE  — discover + score + tailor packets (one pipeline pass)
 *   2. REVIEW & APPROVE — show prepared packets, approve right here (no UUID
 *                         copy/paste); the Excel tracker is refreshed too
 *   3. ASSIST          — optionally open a browser and fill approved forms,
 *                         always stopping before the final submit
 *
 * The human approval gate is preserved: nothing is approved or submitted
 * without an explicit choice. Non-interactive shells (no TTY) safely stop at
 * the approval boundary and print copy-paste guidance instead of prompting.
 *
 * Flags (parsed by the CLI and passed in `options`):
 *   --yes            approve every prepared packet automatically (then assist)
 *   --no-assist      stop after approval (don't open the browser)
 *   --prepare-only   stop after preparing (skip approve + assist)
 */

import { createInterface } from 'node:readline/promises';
import { relative } from 'node:path';

import { runPrepareApps } from './commands.js';
import { runApply } from './applyOneByOne.js';
import { listPending, approve } from '../apply/approvalQueue.js';
import { writeJobTracker } from '../reports/jobTracker.js';
import { ui } from './ui.js';

/** Project-relative path with forward slashes, for tidy output. */
function rel(root, p) {
  if (!p) return '';
  try { return relative(root, p).split('\\').join('/'); }
  catch { return String(p); }
}

/** Build a readline-backed prompt; falls back to a no-op when not interactive. */
function makePrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (await rl.question(q)).trim();
  ask.close = () => rl.close();
  return ask;
}

/**
 * Parse an approval selection string against a list length.
 *   "a"/"all"           -> every index
 *   ""/"n"/"none"/"0"   -> []
 *   "1,3 5" / "1-3"     -> those 1-based indices (deduped, in range)
 * @returns {number[]} zero-based indices
 */
export function parseSelection(input, count) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === 'a' || s === 'all' || s === '*') {
    return Array.from({ length: count }, (_, i) => i);
  }
  if (s === '' || s === 'n' || s === 'none' || s === '0' || s === 'q') return [];

  const picked = new Set();
  for (const token of s.split(/[\s,]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      for (let n = Math.min(lo, hi); n <= Math.max(lo, hi); n += 1) {
        if (n >= 1 && n <= count) picked.add(n - 1);
      }
    } else if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n >= 1 && n <= count) picked.add(n - 1);
    }
  }
  return [...picked].sort((a, b) => a - b);
}

/** Friendly "Company — Role" label from a packet's pending job row. */
function packetLabel(db, jobId) {
  const job = db.getJob?.(jobId);
  if (!job) return jobId;
  const score = typeof job.score === 'number' ? `${job.score}/100 ` : '';
  const tier = job.tier ? `${job.tier} · ` : '';
  return `${job.company ?? '—'} — ${job.title ?? '—'}  ${ui.c.dim(`(${tier}${score}${job.location ?? ''})`)}`;
}

/**
 * Run the full guided session.
 *
 * @param {object} args
 * @param {object} args.config loadConfig() bundle
 * @param {import('../logging/db.js').Database} args.db
 * @param {object} args.logger JobLogger
 * @param {object} [args.options] { yes, assist, prepareOnly }
 * @param {object} [args.deps] { prompt, interactive, ...pipeline deps }
 * @returns {Promise<{ prepared:object, approvedIds:string[], assisted:(object|null) }>}
 */
export async function runGuided({ config, db, logger, options = {}, deps = {} } = {}) {
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY);
  const prompt = deps.prompt ?? (interactive ? makePrompt() : null);

  ui.heading('Job Agent · Guided Run');
  ui.note('One flow: find → review & approve → assist. Nothing is submitted automatically.');

  try {
    /* ── Step 1: find, score, prepare (single pipeline pass) ────────────── */
    ui.blank();
    ui.step('Step 1 of 3 · Finding, scoring, and preparing applications…');
    logger.startRun('PREPARE');
    const prepared = await runPrepareApps({ config, db, logger, deps });
    const c = prepared.counters;
    ui.blank();
    ui.stats([
      ['Found', c.jobs_found],
      ['Scored', c.jobs_scored],
      ['Strong matches', c.jobs_queued, c.jobs_queued ? 'good' : 'muted'],
      ['Packets prepared', c.jobs_prepared, c.jobs_prepared ? 'good' : 'muted'],
      ['Discarded', c.jobs_discarded, 'muted'],
    ]);

    // Refresh the Excel tracker so the spreadsheet always reflects this run.
    const tracker = writeJobTracker(db, config.root);
    ui.blank();
    ui.files([
      rel(config.root, tracker.path),
      rel(config.root, prepared.report?.files?.csv),
    ]);

    if (options.prepareOnly) {
      ui.blank();
      ui.next([{ text: 'Review & approve when ready:', cmd: 'npm start' }]);
      return { prepared, approvedIds: [], assisted: null };
    }

    /* ── Step 2: review & approve ───────────────────────────────────────── */
    const pending = listPending(db);
    ui.blank();
    ui.step('Step 2 of 3 · Review & approve');
    if (!pending.length) {
      ui.blank();
      ui.note('No packets are awaiting approval right now.');
      ui.blank();
      ui.next([
        { text: 'Widen your search in', cmd: 'config/jobboards.json' },
        { text: 'Then run again:', cmd: 'npm start' },
      ]);
      return { prepared, approvedIds: [], assisted: null };
    }

    ui.blank();
    ui.list('Prepared and awaiting your approval',
      pending.map((p, i) => `${ui.c.bold(`[${i + 1}]`)} ${packetLabel(db, p.job_id)}`),
      { symbol: ' ' });

    let chosen = [];
    if (options.yes) {
      chosen = pending.map((_, i) => i);
      ui.blank();
      ui.note(`--yes: approving all ${pending.length} packet(s).`);
    } else if (!interactive || !prompt) {
      // No TTY: stop at the gate with explicit, copy-paste guidance.
      ui.blank();
      ui.note('Not an interactive terminal — stopping at the approval gate.');
      ui.blank();
      ui.next([
        { text: 'Approve all & assist:', cmd: 'npm start -- --yes' },
        { text: 'Or approve one by id:', cmd: 'npm run approvals' },
      ]);
      return { prepared, approvedIds: [], assisted: null };
    } else {
      ui.blank();
      const answer = await prompt(
        `${ui.c.bold('Approve which?')} ${ui.c.dim('[a]ll · [n]one · numbers e.g. 1,3 or 1-2')}  › `);
      chosen = parseSelection(answer, pending.length);
    }

    const approvedIds = [];
    for (const idx of chosen) {
      const row = pending[idx];
      if (!row) continue;
      approve(db, row.id);
      approvedIds.push(row.id);
    }

    // Tracker reflects the new approvals.
    writeJobTracker(db, config.root);

    if (!approvedIds.length) {
      ui.blank();
      ui.note('Nothing approved. You can re-run any time with: npm start');
      return { prepared, approvedIds, assisted: null };
    }
    ui.blank();
    ui.success(`Approved ${ui.c.bold(approvedIds.length)} packet(s).`);

    /* ── Step 3: apply (fill forms one at a time, stop before submit) ───── */
    let doAssist = options.assist !== false;
    if (doAssist && interactive && prompt && !options.yes) {
      const ans = (await prompt(
        `${ui.c.bold('Open a browser to fill them now, one at a time?')} ${ui.c.dim('[Y/n]')}  › `)).toLowerCase();
      doAssist = ans === '' || ans === 'y' || ans === 'yes';
    }

    if (!doAssist) {
      ui.blank();
      ui.next([{ text: 'Fill them later, one at a time:', cmd: 'npm run apply' }]);
      return { prepared, approvedIds, assisted: null };
    }

    ui.blank();
    ui.step('Step 3 of 3 · Filling approved applications — one at a time, stops before submit…');
    // Reuse this session's prompt so we walk applications one-by-one (never open
    // every browser at once). runApply pauses for review between each job.
    const assisted = await runApply({
      config, db, logger,
      options: { all: options.yes === true },
      deps: { ...deps, prompt, interactive },
    });
    return { prepared, approvedIds, assisted };
  } finally {
    if (prompt?.close) prompt.close();
  }
}
