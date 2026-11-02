/**
 * Local dashboard server.
 *
 * A zero-dependency node:http server that drives the whole workflow from the
 * browser: stats tiles, a filterable job board, per-job detail with the fit
 * explanation and packet contents, user triage (shortlist/reject/archive),
 * packet approval, pipeline runs, assisted form filling, and the
 * "I submitted it myself" confirmation.
 *
 * Safety properties (identical to the CLI):
 *   - Binds to 127.0.0.1 ONLY. This is a local cockpit, never a public site.
 *   - Every request must carry a loopback Host header, and browser requests
 *     with an Origin must come from localhost — so a malicious website (or a
 *     DNS-rebinding page) cannot drive the API from the user's own browser.
 *   - By default nothing is auto-submitted: the assist endpoints fill an
 *     APPROVED packet in a real browser and stop before submit. Auto-submit is
 *     an explicit per-run opt-in, and even then a job is only recorded as
 *     submitted when the runner VERIFIED the submission (confirmation page);
 *     an unverified click surfaces as `submit_unverified` for the human.
 *   - "Submitted" is set by the explicit mark-submitted action, or by that
 *     verified opt-in auto-submit — never by anything else.
 *   - One pipeline run / one assist at a time (busy guard); state is pollable;
 *     batch runs can be cancelled between jobs.
 *
 * API:
 *   GET  /api/stats                       tiles + source/status breakdowns
 *   GET  /api/jobs?…filters               board rows { jobs, total, limit }
 *   GET  /api/jobs/:id                    full detail incl. packet summary
 *   GET  /api/jobs/:id/resume?format=…    secure PDF preview / DOCX download
 *   POST /api/jobs/:id/resume-preview     create/recover a PDF preview on demand
 *   GET  /api/master-resume               master resume metadata + readable text
 *   GET  /api/master-resume/file          download the master resume DOCX
 *   POST /api/master-resume               replace it (validated, previous kept)
 *   GET  /api/master-resume/suggestions   role/skill evidence + diff vs the search profile
 *   POST /api/profile/adopt               adopt selected titles/skills into the profile
 *   POST /api/search {query}              ad-hoc query-first discovery (preview a role)
 *   POST /api/master-resume/restore       roll back to a kept previous version
 *   GET  /api/profile                     application profile + screening answers + question queue
 *   POST /api/profile                     save the profile fields the filler uses
 *   POST /api/profile/answers             replace the whole screening-answer set
 *   POST /api/profile/questions/answer    answer one queued question, once, forever
 *   POST /api/profile/questions/status    dismiss / reopen a queued question
 *   POST /api/jobs/:id/check-link         classify current URL availability
 *   POST /api/jobs/:id/link {url}         replace stale URL with a direct job URL
 *   POST /api/jobs/:id/decision {decision} shortlist | rejected | archived | clear
 *   POST /api/jobs/:id/approve            approve prepared packet (human gate)
 *   POST /api/jobs/:id/reject-packet      reject prepared packet
 *   POST /api/jobs/:id/mark-submitted     record YOUR manual submission
 *   POST /api/jobs/:id/assist             fill the approved packet, stop before submit
 *   POST /api/run {phase}                 discover | score | prepare (async)
 *   POST /api/search {query}              ad-hoc query-first discovery (synchronous)
 *   POST /api/run/cancel                  stop a running batch between jobs
 *   GET  /api/run/status                  current/last run state
 *   GET  /api/runs                        recent run history (run_log)
 *   GET  /api/sections                    curated command-center sections
 *   POST /api/jobs/:id/note {note}        save a free-text note on a job
 *   POST /api/decide-batch {jobIds,decision}  bulk shortlist/reject/archive
 *   POST /api/add-url {url}               ingest one public job URL (score + track)
 *   POST /api/auto-submit-batch            explicit advanced final-submit path
 *   GET  /api/export/jobs.csv             rich CSV of every job + score/status
 */

import { createServer } from 'node:http';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import {
  join, dirname, normalize, extname, isAbsolute, resolve, basename,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { ensureResumePdf } from '../resume/pdfPreview.js';
import { checkJobLink } from './linkHealth.js';
import { acquireRunLock, RunLockError } from '../utils/runLock.js';
import { gzipSync } from 'node:zlib';

import { buildRca, sanitizeErrorMessage, inferScope } from '../utils/failureRca.js';
import { isPublicHttpUrl } from '../utils/publicUrl.js';
import { assertInsideDirectory, isInsideDirectory } from '../utils/pathSafe.js';

import {
  dashboardStats, boardPage, jobDetail, applyDecision,
  approveJobPacket, rejectJobPacket, markSubmittedByHuman,
  dashboardSections, setJobNote, buildExportRows, exportRowsToCsv, buildReports,
  buildDocuments, buildMasterResume,
  setDuringBulkRun, todayQueue, undoDecision, noteUserMutation, setBrowserAvailability,
  applicationsWorkspace, recordOutcome, undoOutcome, updateFollowUp,
} from './data.js';
import { extractDocxText, isDocxBuffer } from '../resume/docxText.js';
import {
  runScore, runRescore, runPrepareApps, runQuerySearch, loadPacket, recordAssistResult,
  preparePacketsForJobs, ingestUrl,
} from '../cli/commands.js';
import { assistApply } from '../automation/applyRunner.js';
import { rescoreStale } from '../pipeline/index.js';
import { sweepPostings } from '../search/postingLiveness.js';
import { reconcileStalePackets } from '../apply/packetHygiene.js';
import { packetOwnershipCheck } from '../apply/applicationPacket.js';
import { loadConfig } from '../config/loadConfig.js';
import { writeUserSettings } from '../config/userSettings.js';
import { isPlaceholderValue } from '../config/placeholders.js';
import { runEnrichment } from '../search/enrich.js';
import { dataQualitySummary, freshnessSummary } from './dataQuality.js';
import {
  PROFILE_FIELDS, readProfile, writeProfile, readScreeningAnswers,
  writeScreeningAnswers, upsertScreeningAnswer, adoptResumeEvidence,
} from '../config/profileStore.js';
import {
  dismissQuestion, markQuestionAnswered, recordUnansweredQuestions, reopenQuestion,
  suggestAnswerId, suggestPatterns, summarizeQuestionQueue,
} from '../apply/questionQueue.js';
import { evaluateAutoApplyBatch } from '../apply/autoApplyEligibility.js';
import { markApplicationUserSubmitted, markApplicationVerified } from '../apply/applicationState.js';
import { APPROVAL_STATUS } from '../apply/approvalQueue.js';
import { LIFECYCLE } from '../lifecycle.js';
import { writeJobTracker } from '../reports/jobTracker.js';
import {
  buildExtensionPayload, isChromiumExtensionOrigin, readApprovedArtifact,
  validExtensionKey,
} from '../extension/companion.js';
import { extractResumeEvidence, diffAgainstProfile } from '../resume/resumeProfile.js';
import {
  listProfiles as listSearchProfiles, readProfile as readSearchProfile,
  readActiveProfile, activateProfile, saveProfile as saveSearchProfile, acknowledgeResumeMismatch,
  deleteProfile as deleteSearchProfile, migrateLegacyCandidate,
  proposeProfileFromResume, mergeIntoActiveProfile, refreshBackgroundFromResume, resumeProfileToReuse,
  createPersonProfile, updatePersonProfile,
} from '../profile/store.js';
import { profileFromResume, buildBackground } from '../profile/fromResume.js';
import { workspacePaths, masterResumeFile } from '../profile/workspace.js';
import { openDatabase } from '../logging/db.js';
import { seedJobsInto } from '../profile/seed.js';
import { deriveFromProfile } from '../profile/derive.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

/** Phases the dashboard may trigger. Submission is intentionally absent. */
const RUN_PHASES = new Set(['discover', 'score', 'prepare']);

/** Most RCA rows to keep after collapsing — a panel, not a log file. */
const MAX_RCA_ENTRIES = 25;

/** Bound user-triggered batches so one local request cannot monopolize the UI. */
const MAX_BATCH_JOBS = 200;

/** Largest board page a request may ask for (the UI offers up to 500). */
const MAX_JOBS_PAGE = 1000;

/** Keep local resume previews bounded even when a DB path is corrupt. */
const MAX_RESUME_PREVIEW_BYTES = 12 * 1024 * 1024;

/** A Word resume is tens of KB; anything near this is not a resume. */
const MAX_MASTER_RESUME_BYTES = 8 * 1024 * 1024;

/**
 * Smallest word count accepted as a master resume. Every tailored resume is
 * built from this file, so an empty template or an image-only scan must be
 * refused at upload time rather than quietly breaking every future packet.
 */
const MIN_MASTER_RESUME_WORDS = 40;

/** Previous master resumes kept for one-click rollback. */
const MAX_MASTER_BACKUPS = 10;

/** Upload body cap: base64 inflates the payload by ~4/3, plus JSON overhead. */
const MAX_UPLOAD_BODY_BYTES = 12 * 1024 * 1024;

/** /api/runs page size: default and ceiling. */
const RUNS_DEFAULT_LIMIT = 20;
const RUNS_MAX_LIMIT = 100;

/**
 * One run_log row as /api/runs reports it: the raw columns (kept for existing
 * readers) plus a camelCase summary — counters grouped, the per-source table
 * parsed, and an error COUNT so a list can flag a bad run without parsing.
 *
 * @param {object} row listRunLogs() row
 * @returns {object}
 */
export function runSummary(row = {}) {
  const counters = {};
  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('jobs_') && value !== null && value !== undefined) counters[key] = Number(value);
  }
  let perSource = [];
  try { perSource = row.per_source ? JSON.parse(row.per_source) : []; } catch { perSource = []; }
  let errorCount = 0;
  if (row.errors) {
    try {
      const parsed = JSON.parse(row.errors);
      errorCount = Array.isArray(parsed) ? parsed.reduce((n, e) => n + (Number(e?.count) || 1), 0) : 1;
    } catch { errorCount = 1; }
  }
  const { per_source: _perSource, ...raw } = row;
  return {
    ...raw,
    runId: row.run_id ?? null,
    mode: row.mode ?? null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    durationMs: row.durationMs ?? null,
    counters,
    perSource: Array.isArray(perSource) ? perSource : [],
    errorCount,
  };
}

/**
 * Fold RCA entries that say the same thing into one row carrying a count.
 *
 * One throttled host used to emit a near-identical entry per job, so a run that
 * merely lost some job *descriptions* rendered as forty screaming failures and
 * buried the one or two errors that actually needed the user's attention.
 * Same source + category + status = one row.
 *
 * @param {object[]} entries
 * @returns {object[]}
 */
export function collapseRca(entries = []) {
  /** @type {Map<string, object>} */
  const merged = new Map();
  for (const e of entries) {
    // Scope is part of the identity: "1 page failed" and "1 employer failed"
    // are different findings and folding them together would misstate the cost.
    const key = `${e.source ?? ''}|${e.operation ?? ''}|${e.category}|${e.status ?? ''}|${e.degraded ? 'd' : 'f'}|${e.scope ?? ''}`;
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, { ...e });
      continue;
    }
    seen.count += e.count ?? 1;
    seen.retryCount = Math.max(seen.retryCount, e.retryCount ?? 0);
    // Keep the first message as the representative sample; the count carries
    // the rest. Recompute the impact so it reflects the folded total.
    //
    // `kept` and `scope` MUST be threaded through here. Dropping them made the
    // recomputed impact fall back to "results are missing" the moment two
    // identical failures folded — silently undoing the honest wording for
    // exactly the noisiest cases, which are the ones a user actually reads.
    seen.impact = buildRca({
      operation: seen.operation,
      source: seen.source,
      error: seen.message,
      status: seen.status ?? undefined,
      degraded: seen.degraded,
      count: seen.count,
      kept: seen.kept,
      scope: seen.scope,
    }).impact;
  }
  return [...merged.values()]
    .sort((a, b) => Number(a.degraded) - Number(b.degraded) || b.count - a.count)
    .slice(0, MAX_RCA_ENTRIES);
}

/**
 * Create (but do not start) the dashboard server.
 *
 * @param {object} args
 * @param {object} args.config loadConfig() bundle
 * @param {import('../logging/db.js').Database} args.db
 * @param {object} args.logger JobLogger
 * @param {object} [args.deps] injectable: runners/assistFn/now (testing)
 * @returns {{ server: import('node:http').Server, runState: object }}
 */
export function createDashboardServer({ config: bootConfig, db, logger, deps = {} } = {}) {
  // The Application Profile editor rewrites config/candidate.json and
  // config/screening_answers.json while this process is running, and loadConfig
  // returns a FROZEN snapshot. The bundle is therefore rebound after every
  // save — otherwise the next auto-apply run would keep filling the old values
  // and the page would look like it had saved nothing.
  let config = bootConfig;

  /*
   * ONE DATABASE PER PERSON. Each search profile has a workspace (see
   * src/profile/workspace.js); switching profile switches which database every
   * route below reads. `db` is this function's own binding, and every route
   * reads it at call time, so rebinding it here is the whole switch. Handles
   * are kept open per workspace for the life of the process: a background
   * sweep that started on the previous person's database must be able to
   * finish on it, and switching back is then instant. The boot handle belongs
   * to the caller, which closes it; the ones opened here are closed on
   * shutdown (`closeWorkspaceDbs`).
   */
  const bootDb = db;
  let dbPath = bootConfig?.root ? workspacePaths(bootConfig.root).db : null;
  const workspaceDbs = new Map(dbPath ? [[dbPath, bootDb]] : []);
  function useActiveWorkspace() {
    const root = config?.root;
    if (!root || !dbPath) return false; // unit-test servers boot without a root
    const next = workspacePaths(root).db;
    if (next === dbPath) return false;
    let handle = workspaceDbs.get(next);
    if (!handle) {
      handle = (deps.openDatabaseImpl ?? openDatabase)({ path: next });
      workspaceDbs.set(next, handle);
    }
    db = handle;
    dbPath = next;
    // The session logger records against the database it was given.
    if (logger && typeof logger === 'object' && 'db' in logger) logger.db = handle;
    return true;
  }
  /** The handle for one workspace's database, opening it on first use. */
  function dbForWorkspace(workspaceId) {
    const root = config?.root;
    if (!root) return null;
    const path = workspacePaths(root, workspaceId).db;
    if (path === dbPath) return db;
    let handle = workspaceDbs.get(path);
    if (!handle) {
      handle = (deps.openDatabaseImpl ?? openDatabase)({ path });
      workspaceDbs.set(path, handle);
    }
    return handle;
  }

  /**
   * Copy the postings in `fromDb` that clearly fit a new person into their
   * workspace (src/profile/seed.js). Posting facts only; they arrive unscored
   * and are scored under the new person's profile by the next rescore.
   */
  function seedNewPerson(root, profileId, fromDb) {
    const profile = readSearchProfile(root, profileId);
    if (!profile?.workspace || !fromDb) return { seeded: 0 };
    const to = dbForWorkspace(profile.workspace);
    if (!to || to === fromDb) return { seeded: 0 };
    const { candidate } = deriveFromProfile(profile, { root });
    const days = Number(config?.exclusions?.staleness?.skipOlderThanDays);
    const result = seedJobsInto({ from: fromDb, to, candidate, ...(Number.isFinite(days) && days > 0 ? { maxAgeDays: days } : {}) });
    if (result.seeded && to === db) noteUserMutation?.();
    return result;
  }

  function closeWorkspaceDbs() {
    for (const handle of workspaceDbs.values()) {
      if (handle !== bootDb) { try { handle.close(); } catch { /* best effort on shutdown */ } }
    }
  }
  const extensionKey = deps.extensionKey ?? process.env.JOB_AGENT_EXTENSION_KEY ?? '';
  // Each run gets its OWN JobLogger (`runDeps.logger`, see startRun). Passing
  // the dashboard SESSION's logger made the pipeline's endRun() write every
  // run's counters to the session's run id — which upserted a mode='unknown'
  // run_log row and merged every run of the session into it.
  const runners = {
    // "Find New Jobs" must leave jobs ON THE BOARD. The bare discover phase
    // only writes data/found_jobs.json — never the SQLite DB the board reads —
    // so the button appeared to do nothing (header stuck at "0 found in last
    // 24h" no matter how many jobs the run found). Route it through the
    // scoring pipeline, which discovers, scores, AND persists in one pass.
    discover: deps.discoverFn ?? (({ logger: runLogger, ...runDeps } = {}) => runScore({
      config, db, logger: runLogger ?? logger, deps: { ...deps, ...runDeps },
    })),
    // "Re-score" recomputes fit for jobs ALREADY on the board from their stored
    // JDs — no network, no re-discovery. (It used to silently re-run the full
    // discovery pipeline, which is what the Find button is for.)
    score: deps.scoreFn ?? (({ logger: runLogger, ...runDeps } = {}) => runRescore({
      config, db, logger: runLogger ?? logger, deps: { ...deps, ...runDeps },
    })),
    prepare: deps.prepareFn ?? (({ logger: runLogger, ...runDeps } = {}) => runPrepareApps({
      config, db, logger: runLogger ?? logger, deps: { ...deps, ...runDeps },
    })),
  };

  /**
   * Take the cross-process run lock (src/utils/runLock.js) for a run this
   * server starts, or throw a 409 that names who holds it. Without a project
   * root (unit-test servers) there is no data/ directory to lock.
   * @returns {{ release: () => void }}
   */
  function takeRunLock(phase) {
    const root = config?.root;
    const enabled = deps.runLock ?? process.env.JOB_AGENT_RUN_LOCK !== 'off';
    if (!root || !enabled) return { release() {} };
    try {
      return (deps.acquireRunLockImpl ?? acquireRunLock)({ root, owner: 'dashboard', phase });
    } catch (err) {
      if (err instanceof RunLockError || err?.holder) {
        throw Object.assign(new Error(err.message), { statusCode: 409, holder: err.holder });
      }
      throw err;
    }
  }
  const assistFn = deps.assistFn ?? assistApply;

  /** Single mutable run/assist state, surfaced at /api/run/status. */
  const runState = {
    running: false, phase: null, startedAt: null,
    finishedAt: null, lastResult: null, lastError: null,
    cancelRequested: false,
    // Root-cause analysis of the last run: correlation id, structured
    // per-source failures, and whether valid partial results were kept.
    runId: null, rca: [], partial: false, progress: null,
  };
  const inFlight = new Set();
  const track = (promise) => {
    inFlight.add(promise);
    // `.finally()` returns a NEW promise that re-rejects when `promise` does.
    // Nothing awaited it, so a rejected background task surfaced a second time
    // as an unhandled rejection. The catch absorbs only that derived copy; the
    // original is still returned (and still rejects) for whoever awaits it.
    promise.catch(() => {}).finally(() => inFlight.delete(promise));
    return promise;
  };

  /**
   * Aborts the IN-FLIGHT network work of the current run.
   *
   * `runState.cancelRequested` alone is cooperative polling: adapters check it
   * between operations, so a request already on the wire still ran to
   * completion or to its 30s timeout, and everything already queued behind a
   * politeness gate still got sent. Cancelling a discovery run therefore took
   * ~30 seconds with the UI stuck on "Stopping…" — matching `requestTimeoutMs`
   * almost exactly. This signal makes cancel immediate: in-flight fetches abort
   * and gate-queued work is dropped rather than dialled.
   *
   * Deliberately NOT a field on `runState`, which is serialized wholesale to
   * /api/run/status — this is a live object, not reportable state.
   * @type {AbortController|null}
   */
  let runAbort = null;

  // Doctor is intentionally expensive (Python/browser/filesystem probes).
  // Coalesce concurrent requests and keep a short cache so revisiting Settings
  // does not spawn the same checks repeatedly.
  let healthCache = null;
  let healthCacheAt = 0;
  let healthPromise = null;
  async function healthReport() {
    if (healthCache && Date.now() - healthCacheAt < 30_000) return healthCache;
    if (healthPromise) return healthPromise;
    healthPromise = (async () => {
      const doctor = deps.doctorFn ?? (await import('../cli/doctor.js')).runDoctor;
      const report = await doctor({ env: process.env, root: config?.root ?? undefined });
      healthCache = report;
      healthCacheAt = Date.now();
      return report;
    })();
    try { return await healthPromise; }
    finally { healthPromise = null; }
  }

  /**
   * Re-read every config file after the profile editor writes one, so the next
   * run fills the new values without restarting the dashboard.
   *
   * A reload failure is reported, never swallowed: the file on disk has already
   * been validated by the writer, so a failure here means something ELSE in
   * config/ is broken and the process is now running on the previous bundle.
   *
   * @returns {string|null} an error to show the user, or null on success
   */
  function reloadConfig() {
    const root = config?.root;
    if (!root) return null; // unit-test servers boot with a bare config object
    try {
      const loader = deps.loadConfigImpl ?? loadConfig;
      config = loader({ root, loadEnv: false });
      // A new profile / scoring / gate changes what the board SHOWS without
      // writing a row, so the data-keyed caches must be told.
      noteUserMutation();
      // A profile switch turns the previous profile's packets into someone
      // else's; withdraw them now rather than when Auto-fill refuses them.
      reconcilePackets();
      return null;
    } catch (err) {
      const message = sanitizeErrorMessage(err.message);
      logger?.warn?.(`config reload failed: ${message}`);
      return `Saved, but the config could not be reloaded (${message}). `
        + 'Restart the dashboard before the next auto-apply run.';
    }
  }

  /**
   * Re-judge the rows the previous profile scored, off the request path.
   *
   * Activation changes titles, skills and scoring categories, so every open
   * verdict on the board is now another profile's. rescoreStale fixes that from
   * stored descriptions (no network) — but it is synchronous and walks every
   * active row (~6k on a real store, seconds of CPU), so running it inside the
   * activation request would freeze every other request, the run poll included.
   * It is deferred, coalesced, and yields to a run (the run's own end-of-run
   * rescore covers it).
   */
  /**
   * Is the Playwright browser installed RIGHT NOW? Cached for a minute: it is a
   * stat() behind a dynamic import, cheap but not free on a polled endpoint,
   * and it only changes when the user runs the install command.
   */
  let browserCheck = { at: 0, value: null };
  async function browserAvailableCached() {
    if (deps.browserAvailable !== undefined) return deps.browserAvailable;
    // Tests set this so a label never depends on whether the machine running
    // the suite happens to have Chromium installed.
    if (process.env.JOB_AGENT_BROWSER_CHECK === 'off') return null;
    if (Date.now() - browserCheck.at < 60_000) return browserCheck.value;
    let value = null;
    try {
      const { checkBrowserAvailable } = await import('../automation/browser.js');
      value = (await checkBrowserAvailable({ channel: config?.runtime?.browserChannel ?? null })).ok === true;
    } catch { value = null; }
    browserCheck = { at: Date.now(), value };
    setBrowserAvailability(value);
    return value;
  }

  /**
   * Keep the board free of postings the employer has closed.
   *
   * Measured 2026-09-23: 24 of the 40 best-scored open Workday rows were closed
   * at the source and still on the board. A sweep asks each posting's own ATS
   * API (search/postingLiveness.js) whether it still exists — best-scored
   * first, each posting at most once a day, a few requests in flight per host
   * — and retires the closed ones. It never runs during a pipeline run, and
   * whatever it learned before a stop is kept.
   */
  const postingSweep = { running: false, controller: null, last: null, startedAt: null, finishedAt: null };
  async function runPostingSweep({ limit = 300, maxAgeHours = 24 } = {}) {
    if (postingSweep.running || runState.running || !db?.listPostingsToCheck) return null;
    postingSweep.running = true;
    postingSweep.controller = new AbortController();
    postingSweep.startedAt = new Date().toISOString();
    try {
      const sweep = deps.sweepPostingsImpl ?? sweepPostings;
      const result = await sweep({ db, limit, maxAgeHours, signal: postingSweep.controller.signal });
      postingSweep.last = result;
      if (result?.checked) {
        noteUserMutation();
        logger?.info?.(`posting check: ${result.checked} checked, ${result.closed} closed (${result.retired} retired)`);
      }
      return result;
    } catch (err) {
      postingSweep.last = { error: sanitizeErrorMessage(err?.message ?? String(err)) };
      return null;
    } finally {
      postingSweep.running = false;
      postingSweep.controller = null;
      postingSweep.finishedAt = new Date().toISOString();
    }
  }
  function schedulePostingSweeps() {
    if (process.env.JOB_AGENT_POSTING_SWEEP === 'off' || !config?.root) return;
    const first = setTimeout(() => { runPostingSweep().catch(() => {}); }, deps.postingSweepDelayMs ?? 90_000);
    const every = setInterval(() => { runPostingSweep().catch(() => {}); }, deps.postingSweepEveryMs ?? 6 * 3600_000);
    first.unref?.();
    every.unref?.();
    server.on('close', () => {
      clearTimeout(first);
      clearInterval(every);
      postingSweep.controller?.abort();
    });
  }

  /**
   * Withdraw approved packets that can no longer be filled (built for another
   * profile, or the file is gone) so Today never offers a retry that can only
   * be refused. See apply/packetHygiene.js. Cheap: a handful of approval rows.
   */
  function reconcilePackets() {
    if (process.env.JOB_AGENT_PACKET_HYGIENE === 'off' || !config?.candidate) return null;
    try {
      const out = reconcileStalePackets({ db, config, ...(deps.loadPacketImpl ? { loadPacketImpl: deps.loadPacketImpl } : {}) });
      if (out.superseded.length) {
        noteUserMutation();
        logger?.info?.(`withdrew ${out.superseded.length} unusable packet(s): ${out.superseded.map((s) => s.jobId).join(', ')}`);
      }
      return out;
    } catch (err) {
      logger?.warn?.(`packet check failed: ${sanitizeErrorMessage(err?.message ?? String(err))}`);
      return null;
    }
  }

  let rescoreTimer = null;
  function scheduleRescore() {
    if (rescoreTimer || !config?.root) return;
    rescoreTimer = setTimeout(() => {
      rescoreTimer = null;
      if (runState.running) return;
      try {
        const out = (deps.rescoreStaleImpl ?? rescoreStale)({ db, config });
        noteUserMutation();
        logger?.info?.(`re-scored ${out?.rescored ?? 0} job(s) under the active profile`);
      } catch (err) {
        logger?.warn?.(`re-score after profile change failed: ${sanitizeErrorMessage(err.message)}`);
      }
    }, 50);
    rescoreTimer.unref?.();
  }

  /**
   * Retire postings that aged past the retention window while nobody ran
   * discovery. rescoreStale re-judges rows posted before the cutoff, so a
   * dashboard left open for weeks — or reopened after a long gap — never leads
   * Today with a posting the exclusion stage would already have retired. Shares
   * scheduleRescore's coalescing and its "yield to a running pipeline" rule.
   */
  function scheduleRetentionSweeps() {
    if (process.env.JOB_AGENT_RETENTION_SWEEP === 'off' || !config?.root) return;
    const first = setTimeout(scheduleRescore, deps.retentionSweepDelayMs ?? 2_000);
    const every = setInterval(scheduleRescore, deps.retentionSweepEveryMs ?? 6 * 3600_000);
    first.unref?.();
    every.unref?.();
    server.on('close', () => { clearTimeout(first); clearInterval(every); });
  }

  /**
   * Description enrichment (src/search/enrich.js), run off the request path.
   *
   * OFF until the user enables it (data/settings.json, from the "Discovery &
   * data quality" dialog); "Fetch now" is always available as an explicit
   * action. It never runs during a search, and a search starting mid-pass stops
   * it between rows — every row already read is kept, and the next pass
   * resumes with what is left.
   */
  const enrichment = {
    running: false, controller: null, trigger: null, startedAt: null, finishedAt: null, progress: null, last: null,
  };
  function enrichmentStatus() {
    const { running, trigger, startedAt, finishedAt, progress, last } = enrichment;
    return {
      running, trigger, startedAt, finishedAt, progress, last,
      enabled: config?.runtime?.enrichment?.enabled === true,
      stopping: running && enrichment.controller?.signal.aborted === true,
    };
  }
  /** @returns {{started: boolean, reason?: string}} */
  function startEnrichmentPass(trigger) {
    if (enrichment.running) return { started: false, reason: 'description fetching is already running' };
    if (runState.running) return { started: false, reason: `a ${runState.phase} run is in progress — try again when it finishes` };
    if (!config?.scoring) return { started: false, reason: 'configuration is not loaded' };
    const controller = new AbortController();
    Object.assign(enrichment, {
      running: true, controller, trigger, startedAt: new Date().toISOString(), finishedAt: null, progress: null,
    });
    const impl = deps.runEnrichmentImpl ?? runEnrichment;
    const pass = (async () => {
      try {
        const stats = await impl({
          db, config,
          shouldCancel: () => controller.signal.aborted || runState.running,
          onProgress: (p) => { enrichment.progress = p; },
        });
        enrichment.last = { ...stats, finishedAt: new Date().toISOString(), trigger };
        if (stats?.fetched || stats?.failed) noteUserMutation();
        logger?.info?.(`description fetch: ${stats?.fetched ?? 0} read, ${stats?.failed ?? 0} failed, ${stats?.nowActionable ?? 0} now worth a look`);
      } catch (err) {
        enrichment.last = { error: sanitizeErrorMessage(err?.message ?? String(err)), finishedAt: new Date().toISOString(), trigger };
      } finally {
        enrichment.running = false;
        enrichment.controller = null;
        enrichment.finishedAt = new Date().toISOString();
      }
    })();
    track(pass);
    return { started: true };
  }
  function scheduleEnrichment() {
    if (process.env.JOB_AGENT_ENRICHMENT === 'off' || !config?.root) return;
    // A tick, not a fixed timer, so turning the setting on (or changing the
    // interval) takes effect without a restart.
    const tick = () => {
      const settings = config?.runtime?.enrichment;
      if (settings?.enabled !== true || enrichment.running || runState.running) return;
      const last = enrichment.finishedAt ? Date.parse(enrichment.finishedAt) : 0;
      if (Date.now() - last < (Number(settings.intervalHours) || 6) * 3600_000) return;
      startEnrichmentPass('scheduled');
    };
    const first = setTimeout(tick, deps.enrichmentDelayMs ?? 120_000);
    const every = setInterval(tick, deps.enrichmentTickMs ?? 15 * 60_000);
    first.unref?.();
    every.unref?.();
    server.on('close', () => { clearTimeout(first); clearInterval(every); enrichment.controller?.abort(); });
  }

  /**
   * Record the questions one assist run could not answer.
   *
   * This is the learning loop's only capture point: without it the human
   * answers the question in the browser and the knowledge dies with the run.
   * Never throws — a queue write must not turn a successful fill into a failure.
   *
   * @param {string} jobId
   * @param {object} result assist result (carries `needsUser`)
   */
  function captureUnansweredQuestions(jobId, result) {
    const root = config?.root;
    const questions = Array.isArray(result?.needsUser) ? result.needsUser : [];
    if (!root || questions.length === 0) return;
    try {
      const job = db.getJob?.(jobId) ?? {};
      recordUnansweredQuestions(root, {
        jobId,
        company: job.company ?? null,
        title: job.title ?? null,
        url: result.url ?? job.url ?? null,
        ats: job.ats ?? job.ats_platform ?? null,
        questions,
        now: nowDate(),
      });
    } catch (err) {
      logger?.warn?.(`could not record unanswered questions for ${jobId}: ${err.message}`);
    }
  }

  /**
   * The Application Profile page in one payload: the fields the filler can use,
   * the screening answers it draws on, and the questions it could not answer.
   */
  function profileState() {
    const root = config?.root;
    if (!root) {
      return {
        available: false,
        reason: 'This dashboard was started without a project root, so the config files cannot be located.',
        fields: PROFILE_FIELDS, missing: [], answers: [], questions: { open: [], resolved: [], openCount: 0, requiredCount: 0 },
      };
    }
    const profile = readProfile(root);
    const screening = readScreeningAnswers(root);
    const questions = summarizeQuestionQueue(root);
    return {
      available: true,
      // `placeholder` marks a value that is still the shipped TEMPLATE text, not
      // something the person wrote. The page shows it as grey placeholder text in
      // an empty box, so it can never be mistaken for (or sent as) their answer.
      profile: { ...profile, fields: profile.fields.map((f) => ({ ...f, placeholder: isPlaceholderValue(f.value) })) },
      screening: { ...screening, answers: screening.answers.map((a) => ({ ...a, placeholder: isPlaceholderValue(a.answer) })) },
      questions: {
        ...questions,
        // Suggested id/patterns are computed here, so the browser never has to
        // reimplement the matcher's tokenizing rules and get them subtly wrong.
        open: questions.open.map((q) => ({
          ...q,
          suggestedId: suggestAnswerId(q.label),
          suggestedPatterns: suggestPatterns(q.label),
        })),
      },
    };
  }

  /** Project root, or a 400 when this dashboard was started without one. */
  function requireConfigRoot() {
    const root = config?.root;
    if (!root) {
      throw new Error('This dashboard was started without a project root, so the config files cannot be edited.');
    }
    return root;
  }

  /**
   * Run a config write, reporting its refusals as 400s.
   *
   * A rejected profile or answer is the request being wrong — a bad email, a
   * pattern that could never match, an answer that would misstate work
   * authorization. Letting those fall through to the generic 500 handler would
   * present the user's own typo as "the dashboard is broken".
   */
  function saving(res, work) {
    // `fields` (when a validator set it) maps each form field to its message.
    const fail = (err) => sendJson(res, err?.statusCode ?? 400, {
      error: sanitizeErrorMessage(err?.message ?? String(err)),
      ...(err?.fields && typeof err.fields === 'object' ? { fields: err.fields } : {}),
      ...(err?.existing && typeof err.existing === 'object' ? { existing: err.existing } : {}),
    });
    try {
      const out = work();
      // An ASYNC handler's throw is a rejected promise, which a plain
      // try/catch never sees — user-input errors came back as 500s.
      return out && typeof out.then === 'function' ? out.catch(fail) : out;
    } catch (err) {
      return fail(err);
    }
  }

  /**
   * True when the job may NOT be filled again: it was submitted, or an
   * auto-submit click is still unverified (re-filling could double-apply).
   */
  function isSubmittedOrUnverified(jobRow) {
    return Boolean(jobRow) && (Number(jobRow.applied) === 1
      || jobRow.status === LIFECYCLE.SUBMITTED
      || jobRow.status === LIFECYCLE.SUBMIT_UNVERIFIED);
  }

  /**
   * Re-read a queued job's LIVE state right before filling it. A batch queue is
   * built once up front, but the human keeps using the dashboard while it runs —
   * a job they reject/archive/submit (or whose approval they revoke) mid-run
   * must not be opened and filled anyway.
   *
   * @param {string} jobId
   * @returns {string|null} reason to skip, or null to proceed
   */
  function liveSkipReason(jobId) {
    const live = db.getJob?.(jobId);
    if (!live) return null; // exotic test stubs — keep legacy behavior
    if (isSubmittedOrUnverified(live)) return 'submitted while the batch was running, skipped';
    if (live.user_decision === 'rejected' || live.user_decision === 'archived') {
      return `you ${live.user_decision} it while the batch was running, skipped`;
    }
    const liveApproval = db.getApprovalByJob?.(jobId);
    if (liveApproval && liveApproval.approval_status !== APPROVAL_STATUS.APPROVED) {
      return 'its approval was revoked while the batch was running, skipped';
    }
    return null;
  }

  /**
   * Rewrite data/job_tracker.csv so the spreadsheet always mirrors the DB after
   * any mutating action (approve/reject/decision/submit/assist). No-ops when the
   * config has no root (unit tests) or the write fails — the API never 500s
   * just because the CSV could not be refreshed.
   *
   * @returns {string|null} the CSV path, or null when skipped
   */
  function writeTrackerNow() {
    const root = config?.root;
    if (!root) return null;
    try {
      const writeImpl = deps.writeJobTrackerImpl ?? writeJobTracker;
      return writeImpl(db, root).path;
    } catch (err) {
      logger?.warn?.(`tracker refresh failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Coalescing scheduler for the tracker rewrite.
   *
   * The CSV mirrors the whole jobs table, so writing it is O(all jobs) — at 32k
   * rows that is a real chunk of blocked event loop. Doing it INLINE meant every
   * shortlist/approve/note click paid for a full-table export before the
   * response was sent, and a bulk action paid for it once per job.
   *
   * Now a mutation only marks the CSV dirty; one write runs shortly after the
   * burst settles. The DB is already the source of truth, so a sub-second lag on
   * a derived spreadsheet is invisible — and `/api/export/tracker.csv` still
   * writes synchronously so an explicit download is never stale.
   */
  let trackerTimer = null;
  let trackerDirty = false;
  const TRACKER_DEBOUNCE_MS = deps.trackerDebounceMs ?? 400;
  function refreshTracker() {
    if (!config?.root) return;
    trackerDirty = true;
    if (trackerTimer) return;
    trackerTimer = setTimeout(() => {
      trackerTimer = null;
      if (!trackerDirty) return;
      trackerDirty = false;
      track(Promise.resolve().then(writeTrackerNow));
    }, TRACKER_DEBOUNCE_MS);
    // Never hold the process open just for a pending CSV rewrite.
    trackerTimer.unref?.();
  }

  /** Flush any pending tracker write (shutdown + explicit export). */
  function flushTracker() {
    if (trackerTimer) { clearTimeout(trackerTimer); trackerTimer = null; }
    if (!trackerDirty) return null;
    trackerDirty = false;
    return writeTrackerNow();
  }

  /**
   * Make the packet navigate to the URL the user actually sees on the board.
   *
   * The packet's `job.url` is frozen at prepare time; if discovery later
   * refreshed the job's URL (e.g. an Indeed/aggregator link resolved to the
   * direct company page), the packet would still point the browser at the old,
   * already-closed link. We always trust the live DB `job.url` so auto-apply
   * opens the same posting shown in the dashboard. Returns the packet unchanged
   * when the DB has no URL (never blanks out a working packet URL).
   *
   * @param {object} packet loaded application packet
   * @param {string} jobId
   * @returns {object} the reconciled packet
   */
  function reconcilePacket(packet, jobId) {
    if (!packet) return packet;
    const job = db.getJob?.(jobId);
    const liveUrl = job?.url;
    if (liveUrl && packet.job && packet.job.url !== liveUrl) {
      logger?.info?.(`assist: using live job URL for ${jobId} (packet URL was stale)`);
      packet.job = { ...packet.job, url: liveUrl };
    }
    return packet;
  }

  /**
   * Is the packet stored for this job the ACTIVE candidate's?
   *
   * There is one job store and one approvals table for every profile, and a
   * packet used to record nothing about who it was built for — so switching
   * profiles and pressing Auto-fill filled the new candidate's application from
   * the previous candidate's tailored resume, cover letter and screening
   * answers. Reusing a stored packet is only safe once it has been asked whose
   * it is. See `packetOwnershipCheck`.
   *
   * @param {object|null} approval approval row for the job
   * @returns {{ok: boolean, reason: string|null}} ok when there is nothing
   *   stored (nothing to reuse) or the stored packet belongs to this candidate
   */
  function storedPacketIsOurs(approval) {
    if (!approval) return { ok: true, reason: null };
    const loaded = deps.loadPacketImpl ? deps.loadPacketImpl(approval) : loadPacket(approval);
    // An unreadable packet is handled by the caller that needs its contents;
    // it is not an ownership problem.
    if (!loaded) return { ok: true, reason: null };
    return packetOwnershipCheck(loaded, config);
  }

  /**
   * Read a generated resume for the local review panel. The path comes only
   * from the selected DB row, is resolved through the real filesystem, and
   * must remain inside this Job Agent workspace. Pending-review packets are
   * intentionally readable here: seeing the resume is part of human approval.
   */
  function workspaceArtifact(raw, missingMessage = 'the generated resume file could not be found') {
    const rootPath = config?.root;
    if (!rootPath) throw Object.assign(new Error('resume preview is unavailable without a project root'), { statusCode: 404 });
    let workspace;
    let candidate;
    try {
      workspace = realpathSync(rootPath);
      candidate = realpathSync(isAbsolute(raw) ? raw : resolve(workspace, raw));
    } catch {
      throw Object.assign(new Error(missingMessage), { statusCode: 404 });
    }
    // Platform-correct containment. A raw `startsWith` compared drive-letter
    // case literally, and since realpathSync preserves the case it is handed,
    // a workspace of `c:\job-agent` never matched a stored `C:\job-agent\…`
    // artifact — which 403'd every resume preview and download.
    return assertInsideDirectory(workspace, candidate, 'resume path escapes the Job Agent workspace');
  }

  /** Find a recorded PDF or recover an already-generated sibling PDF. */
  function existingResumePdf(job) {
    const docx = job.resume_docx_path ?? job.resume_path ?? null;
    const absolute = (value) => (isAbsolute(value) ? value : resolve(config?.root ?? '.', value));
    const freshPdf = (value) => {
      if (!value || !existsSync(absolute(value))) return false;
      if (!docx || !existsSync(absolute(docx))) return true;
      // Re-tailoring overwrites the DOCX but may leave an older sibling PDF.
      // Never show that stale preview as if it matched the new resume.
      return statSync(absolute(value)).mtimeMs >= statSync(absolute(docx)).mtimeMs;
    };
    if (freshPdf(job.resume_pdf_path)) return job.resume_pdf_path;
    if (!docx) return null;
    const sibling = join(dirname(docx), `${basename(docx, extname(docx))}.pdf`);
    return freshPdf(sibling) ? sibling : null;
  }

  async function materializeResumePreview(jobId) {
    const job = db.getJob?.(jobId);
    if (!job) throw Object.assign(new Error(`unknown job id: ${jobId}`), { statusCode: 404 });
    let pdfPath = existingResumePdf(job);
    let generated = false;
    if (!pdfPath) {
      const docxRaw = job.resume_docx_path ?? job.resume_path ?? null;
      if (!docxRaw) throw Object.assign(new Error('tailored resume is not available for this job'), { statusCode: 404 });
      const docxPath = workspaceArtifact(docxRaw);
      if (extname(docxPath).toLowerCase() !== '.docx') {
        throw Object.assign(new Error('the tailored resume is not a DOCX and cannot be previewed'), { statusCode: 422 });
      }
      const convert = deps.ensureResumePdfFn ?? ensureResumePdf;
      const result = await convert(docxPath, deps);
      if (!result?.exported || !result.pdfPath) {
        // 422, not 500: this is a known, explainable limitation of the machine,
        // not a server fault. The DOCX always exists — say so, so the user
        // downloads it instead of concluding the resume failed to generate.
        const reason = result?.reason ?? 'unknown conversion error';
        throw Object.assign(
          new Error(`PDF preview is unavailable on this machine (${reason}). `
            + 'The tailored DOCX is ready to download.'),
          { statusCode: 422, docxAvailable: true },
        );
      }
      pdfPath = result.pdfPath;
      generated = true;
    }
    const safePdf = workspaceArtifact(pdfPath, 'the generated PDF preview could not be found');
    if (extname(safePdf).toLowerCase() !== '.pdf') {
      throw Object.assign(new Error('the generated preview is not a PDF'), { statusCode: 422 });
    }
    if (job.resume_pdf_path !== safePdf) db.upsertJob({ id: jobId, resume_pdf_path: safePdf });
    return { ready: true, generated, url: `/api/jobs/${encodeURIComponent(jobId)}/resume?format=pdf` };
  }

  /**
   * Role and skill evidence from the current master resume, with a diff against
   * the profile that actually drives discovery.
   *
   * Uploading a new resume used to change nothing upstream — the file was
   * written, and `candidate.targetTitles` kept steering every source. This is
   * what makes that visible. It does not WRITE anything: see
   * src/resume/resumeProfile.js for why adopting stays an explicit human act.
   */
  function resumeSuggestions() {
    const root = config?.root;
    if (!root) {
      return { available: false, reason: 'no workspace root is configured' };
    }
    const file = masterResumeFile(root);
    if (!existsSync(file)) {
      return { available: false, reason: 'no master resume has been uploaded yet' };
    }
    try {
      const { paragraphs } = extractDocxText(readFileSync(file));
      const evidence = extractResumeEvidence(paragraphs);
      const diff = diffAgainstProfile(evidence, config.candidate ?? {});
      return { available: true, evidence, diff, targetTitles: config.candidate?.targetTitles ?? [] };
    } catch (err) {
      // A present-but-unreadable master is worth saying plainly; tailoring will
      // hit the same problem.
      return { available: false, reason: `the master resume could not be read: ${sanitizeErrorMessage(err.message)}` };
    }
  }

  /**
   * A profile plus what it makes the agent DO.
   *
   * The second half is the point. A profile is only meaningful through its
   * consequences — which queries go to the boards, which titles are recognized,
   * which families are in scope — and those were previously invisible, which is
   * how a run could keep using one person's titles with nothing saying so.
   */
  function summarizeSearchProfile(profile) {
    // Same root as activation uses, so what this panel promises is exactly what
    // activating would write. Defaulting the root here would read the taxonomy
    // from the installed package instead of this workspace.
    const derived = deriveFromProfile(profile, { root: config?.root });
    return {
      profile,
      // Labelled by ORIGIN so the UI can never present evidence as preference.
      background: profile.background,
      searchIntent: profile.searchIntent,
      effect: {
        families: derived.families.map((f) => ({ id: f.id, label: f.label })),
        searchPhrases: derived.searchPhrases,
        targetTitles: derived.candidate.targetTitles,
        statedRoles: profile.searchIntent.targetRoles,
        expandedRoles: derived.candidate.targetTitles.filter(
          (t) => !profile.searchIntent.targetRoles.some((r) => r.toLowerCase() === t.toLowerCase()),
        ),
        categories: derived.categories.map((c) => ({ id: c.id, label: c.label, weight: c.weight })),
        gapVocabularySize: derived.marketSkills.length,
      },
    };
  }

  function readResumePreview(jobId, requestedFormat = 'auto') {
    const job = db.getJob?.(jobId);
    if (!job) throw Object.assign(new Error(`unknown job id: ${jobId}`), { statusCode: 404 });
    const pdfPath = existingResumePdf(job);
    const docxPath = job.resume_docx_path ?? job.resume_path ?? null;
    const raw = requestedFormat === 'pdf' ? pdfPath
      : requestedFormat === 'docx' ? docxPath
        : (pdfPath ?? docxPath);
    if (!raw) {
      const label = requestedFormat === 'pdf' ? 'PDF preview' : 'tailored resume';
      throw Object.assign(new Error(`${label} is not available for this job`), { statusCode: 404 });
    }
    const candidate = workspaceArtifact(raw);
    // Only the two document types this route is for. The path comes from a DB
    // column, and containment alone would still serve ANY file inside the
    // workspace — .env, the SQLite file, the candidate config — under a
    // resume content type, if a row ever pointed at one.
    const extension = extname(candidate).toLowerCase();
    if (extension !== '.pdf' && extension !== '.docx') {
      throw Object.assign(new Error('the stored resume is not a PDF or DOCX file'), { statusCode: 422 });
    }
    const size = statSync(candidate).size;
    if (size > MAX_RESUME_PREVIEW_BYTES) {
      throw Object.assign(new Error('resume is too large to preview'), { statusCode: 413 });
    }
    const type = extension === '.pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return { bytes: readFileSync(candidate), name: basename(candidate), type, inline: extension === '.pdf' };
  }

  /* ───────────────────────── master resume ───────────────────────── */

  /**
   * Resolve the master resume + its version-history directory, or explain why
   * they are unavailable. The paths are DERIVED from the workspace root (never
   * from the request), and containment is asserted anyway so a hand-edited
   * config root cannot point the writer outside the workspace.
   */
  function masterResumePaths() {
    const root = config?.root;
    if (!root) {
      throw Object.assign(
        new Error('the master resume is unavailable because no project root is configured'),
        { statusCode: 503 },
      );
    }
    const workspace = resolve(root);
    // The ACTIVE person's resume and its history (src/profile/workspace.js).
    const paths = workspacePaths(workspace);
    const file = paths.resume;
    const historyDir = paths.history;
    assertInsideDirectory(workspace, file, 'master resume path escapes the Job Agent workspace');
    assertInsideDirectory(workspace, historyDir, 'master resume history escapes the Job Agent workspace');
    return { workspace, file, historyDir };
  }

  const masterResumeState = () => buildMasterResume(db, {
    root: config?.root ?? null, now: nowDate(),
  });

  /** Timestamped, collision-free name for a kept previous version. */
  function backupName(historyDir) {
    const stamp = nowDate().toISOString().replace(/[:.]/g, '-');
    let candidate = join(historyDir, `MASTER_RESUME.${stamp}.docx`);
    for (let n = 2; existsSync(candidate) && n < 100; n += 1) {
      candidate = join(historyDir, `MASTER_RESUME.${stamp}-${n}.docx`);
    }
    return candidate;
  }

  /**
   * Keep the history directory bounded — it is a safety net, not an archive.
   *
   * Lists the directory itself. It used to call masterResumeState() — which
   * re-extracts the whole master resume's text and scans the jobs table for
   * stale packets — only to read the backup list, and the upload then called it
   * AGAIN for its response: two full builds per upload, one thrown away.
   */
  function pruneBackups(historyDir) {
    let names = [];
    try { names = readdirSync(historyDir); } catch { return; }
    const kept = names
      .filter((name) => /^MASTER_RESUME\..+\.docx$/i.test(name))
      .map((name) => {
        try { return { name, mtimeMs: statSync(join(historyDir, name)).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of kept.slice(MAX_MASTER_BACKUPS)) {
      try { rmSync(join(historyDir, stale.name), { force: true }); }
      catch (err) { logger?.warn?.(`could not prune old master resume ${stale.name}: ${err.message}`); }
    }
  }

  /**
   * Replace the master resume with validated bytes.
   *
   * This is the one place in the whole project that WRITES the master resume,
   * so every guarantee lives here:
   *   - the bytes must really be a readable Word document with resume-like
   *     content (a renamed PDF, an empty template, or a corrupt upload is
   *     rejected BEFORE anything is overwritten);
   *   - the outgoing file is copied to resumes/base/history first, so the
   *     replacement is always undoable;
   *   - the new file is written to a temp name and renamed into place, so an
   *     interrupted write can never leave a half-written master behind.
   *
   * @param {object} args
   * @param {string} args.filename original name, for the extension check
   * @param {Buffer} args.bytes file contents
   * @returns {object} { replaced, backup, master }
   */
  function replaceMasterResume({ filename, bytes }) {
    const { file, historyDir } = masterResumePaths();
    const fail = (message, statusCode) => {
      throw Object.assign(new Error(message), { statusCode });
    };
    if (!/\.docx$/i.test(String(filename ?? ''))) {
      fail('the master resume must be a .docx file, the tailor reads Word documents only '
        + '(export from Google Docs as .docx, or "Save As" .docx in Word)', 400);
    }
    if (!bytes.length) fail('the uploaded file is empty', 400);
    if (bytes.length > MAX_MASTER_RESUME_BYTES) {
      fail(`the file is ${Math.round(bytes.length / 1024)} KB, the limit is `
        + `${Math.round(MAX_MASTER_RESUME_BYTES / 1024 / 1024)} MB`, 413);
    }
    if (!isDocxBuffer(bytes)) {
      fail('that file is not a .docx. It has a .docx name but its contents are something else '
        + '(often a PDF or an old .doc renamed), open it in Word and use "Save As → .docx"', 415);
    }
    let extracted;
    try {
      extracted = extractDocxText(bytes);
    } catch (err) {
      // A decompression bomb gets its own plain answer; anything else is "unreadable".
      if (err?.code === 'DOCX_TOO_LARGE') fail('resume too large when decompressed', 422);
      fail(`the .docx could not be read: ${err.message}`, 422);
    }
    if (extracted.wordCount < MIN_MASTER_RESUME_WORDS) {
      fail(`only ${extracted.wordCount} words of text were found in that document. `
        + 'The master resume is the source every tailored resume is built from, so an empty '
        + 'or image-only file is rejected rather than silently breaking every future packet', 422);
    }

    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(historyDir, { recursive: true });

    let backup = null;
    if (existsSync(file)) {
      const backupPath = backupName(historyDir);
      // COPY, not rename: if the write below fails, the current master is
      // still exactly where every runner expects it.
      copyFileSync(file, backupPath);
      backup = basename(backupPath);
    }
    const temp = `${file}.uploading`;
    try {
      writeFileSync(temp, bytes);
      renameSync(temp, file);
    } catch (err) {
      try { rmSync(temp, { force: true }); } catch { /* nothing to clean up */ }
      throw err;
    }
    pruneBackups(historyDir);
    logger?.info?.(`master resume replaced (${bytes.length} bytes, ${extracted.wordCount} words)`
      + `${backup ? `; previous version kept as ${backup}` : ''}`);
    return { replaced: true, backup, master: masterResumeState() };
  }

  /** Roll back to a kept previous version (itself backed up first). */
  function restoreMasterResume(name) {
    const { historyDir } = masterResumePaths();
    // The name comes from the client, so it is reduced to a bare filename,
    // pattern-checked, and re-asserted to live inside the history directory.
    const safe = basename(String(name ?? ''));
    if (!/^MASTER_RESUME\..+\.docx$/i.test(safe)) {
      throw Object.assign(new Error('that is not a kept master resume version'), { statusCode: 400 });
    }
    const source = join(historyDir, safe);
    assertInsideDirectory(historyDir, source, 'version path escapes the master resume history');
    if (!existsSync(source)) {
      throw Object.assign(new Error(`no kept version named ${safe}`), { statusCode: 404 });
    }
    // Reuse the write path so a restore is validated and backed up exactly
    // like an upload — restoring is never a way around the checks.
    const result = replaceMasterResume({ filename: safe, bytes: readFileSync(source) });
    return { ...result, restored: safe };
  }

  function readMasterResumeFile() {
    const { file } = masterResumePaths();
    if (!existsSync(file)) {
      throw Object.assign(new Error('there is no master resume to download yet'), { statusCode: 404 });
    }
    const size = statSync(file).size;
    if (size > MAX_MASTER_RESUME_BYTES) {
      throw Object.assign(new Error('the master resume is too large to serve'), { statusCode: 413 });
    }
    return { bytes: readFileSync(file), name: basename(file) };
  }

  /** Build a privacy-safe, mutation-free Auto-Apply preview for the UI/API. */
  function autoApplyEligibility(jobIds, autoSubmitAuthorized = false) {
    const ids = Array.isArray(jobIds) ? [...new Set(jobIds.filter(Boolean))] : [];
    const packetErrors = new Map();
    const items = ids.map((jobId) => {
      const job = db.getJob?.(jobId) ?? null;
      const approval = db.getApprovalByJob?.(jobId) ?? null;
      let packet = null;
      const packetRef = approval ?? (job?.application_packet_path
        ? { job_id: jobId, packet_path: job.application_packet_path }
        : null);
      if (packetRef) {
        try {
          packet = deps.loadPacketImpl ? deps.loadPacketImpl(packetRef) : loadPacket(packetRef);
        } catch (err) {
          packetErrors.set(jobId, sanitizeErrorMessage(err.message));
        }
      }
      return { job, approval, packet };
    });
    const preview = evaluateAutoApplyBatch({ items, autoSubmitAuthorized });
    for (const item of preview.items) {
      const packetError = packetErrors.get(item.jobId);
      if (!packetError) continue;
      item.eligible = false;
      item.reasons.unshift(`Application packet could not be read: ${packetError}`);
      item.nextAction = item.reasons[0];
    }
    preview.eligible = preview.items.filter((x) => x.eligible).length;
    preview.ineligible = preview.items.length - preview.eligible;
    return preview;
  }

  async function startRun(phase) {
    // A pipeline run owns the rows; a posting check retiring them underneath
    // it is exactly the overlap the sweep promises never to cause.
    postingSweep.controller?.abort();
    if (runState.running) {
      const err = new Error(`a ${runState.phase} run is already in progress`);
      err.statusCode = 409;
      throw err;
    }
    // Another PROCESS (a CLI discover / watch) may be writing the same rows.
    const runLock = takeRunLock(phase);
    const runId = randomUUID();
    // This run's own logger: its run id, its log lines, its run_log row.
    const runLogger = typeof logger?.forRun === 'function' ? logger.forRun(runId) : logger;
    const sourceItems = phase === 'discover'
      ? (config?.jobboards?.sources ?? [])
        .filter((source) => source.enabled)
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
        .map((source) => ({
          source: source.id, adapter: source.adapter, status: 'queued',
          found: 0, errors: 0, durationMs: null, cached: false,
        }))
      : [];
    runAbort = new AbortController();
    // Open the run_log row. The dashboard defines its own startRun and never
    // called logger.startRun(), so no row was ever inserted and the matching
    // endRun UPDATE hit nothing — run_log held 0 rows against 101,857 jobs.
    // Observability that looked present and was not.
    const runStartedAt = new Date().toISOString();
    try {
      db.reapAbandonedRuns?.();
      db.insertRunLog?.({
        run_id: runId, mode: phase, started_at: runStartedAt,
        jobs_found: 0, jobs_scored: 0, jobs_queued: 0,
        jobs_prepared: 0, jobs_applied: 0, jobs_discarded: 0, errors: null,
      });
    } catch (err) {
      // Never let bookkeeping stop a run the user asked for.
      logger?.warn?.({ runId, phase, err: err.message }, 'could not open run_log row');
    }
    // discover/score can upsert thousands of rows in quick succession; without
    // this the dashboard's decoration cache misses on nearly every poll for the
    // run's full duration (see setDuringBulkRun in data.js).
    setDuringBulkRun(true);
    Object.assign(runState, {
      running: true, phase, startedAt: new Date().toISOString(),
      finishedAt: null, lastError: null, cancelRequested: false,
      runId, rca: [], partial: false,
      progress: sourceItems.length ? {
        kind: 'sources', total: sourceItems.length, completed: 0,
        currentSource: null, items: sourceItems,
      } : null,
    });
    const onSource = (event) => {
      const progress = runState.progress;
      if (!progress || progress.kind !== 'sources') return;
      const item = progress.items.find((entry) => entry.source === event.source);
      if (!item) return;
      if (event.phase === 'start') {
        item.status = 'running';
        item.startedAt = event.at ?? new Date().toISOString();
        progress.currentSource = event.source;
      } else {
        item.status = event.phase === 'cancelled' ? 'cancelled' : (event.errors > 0 ? 'partial' : 'done');
        item.found = event.found ?? item.found;
        item.errors = event.errors ?? item.errors;
        item.durationMs = event.durationMs ?? item.durationMs;
        item.cached = event.cached === true;
        progress.completed = progress.items.filter((entry) => ['done', 'partial', 'cancelled'].includes(entry.status)).length;
        const active = progress.items.find((entry) => entry.status === 'running');
        progress.currentSource = active?.source ?? null;
      }
    };
    // Fire and forget from the request's perspective; tracked so shutdown can
    // drain the work before the database is closed.
    track((async () => {
      let r = null;
      try {
        r = await runners[phase]({
          shouldCancel: () => runState.cancelRequested,
          abortSignal: runAbort.signal,
          searchHooks: { onSource },
          logger: runLogger,
        });
        // Per-source failures (a board that timed out, a token that expired)
        // do NOT fail the run — valid results from healthy sources were kept.
        // They surface as structured RCA entries and mark the run "partial".
        const sourceErrors = Array.isArray(r?.errors) ? r.errors : [];
        // How many jobs each source actually DELIVERED. Without this the RCA
        // cannot tell a source that died from one that lost a single page, and
        // it told the user "results are missing" for a Workday run that had
        // just returned 38,830 jobs.
        const keptBySource = new Map(
          (r?.perSource ?? []).map((s) => [s.source, Number(s.found ?? 0)]),
        );
        runState.rca = collapseRca(sourceErrors.map((e) => buildRca({
          operation: phase,
          source: e.source ?? e.company ?? null,
          kept: keptBySource.has(e.source) ? keptBySource.get(e.source) : null,
          scope: inferScope(e),
          // Adapters carry the HTTP status structurally. Without it the
          // classifier is left guessing from prose, and a 429 whose message
          // happens to contain "fetch failed" gets reported as a network fault.
          error: e.error ?? e,
          status: e.status ?? undefined,
          // An adapter that knows exactly what went wrong — an exhausted usage
          // allowance, say — must not have that overwritten by a guess from the
          // HTTP status. Dropping it classified a spent Apify credit as a
          // generic "provider error" and offered the wrong advice.
          category: e.category ?? undefined,
          attempt: e.attempts ?? 0,
          degraded: e.degraded === true,
          count: e.count ?? 1,
          runId,
          partialResultsValid: true,
        })));
        runState.partial = sourceErrors.length > 0;
        runState.lastResult = {
          phase, counters: r.counters ?? null,
          partial: runState.partial,
          failedSources: runState.rca.map((x) => x.source).filter(Boolean),
          perSource: r.perSource ?? [],
          cancelled: r.cancelled === true || runState.cancelRequested,
          durationMs: Date.now() - Date.parse(runState.startedAt),
        };
      } catch (err) {
        runState.lastError = `${phase} failed: ${sanitizeErrorMessage(err.message)}`;
        runState.rca = [buildRca({ operation: phase, error: err, runId })];
        runState.partial = false;
      } finally {
        if (runState.progress?.kind === 'sources') {
          for (const item of runState.progress.items) {
            if (item.status === 'queued' || item.status === 'running') {
              item.status = runState.cancelRequested ? 'cancelled' : 'done';
            }
          }
          runState.progress.completed = runState.progress.items.length;
          runState.progress.currentSource = null;
        }
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
        setDuringBulkRun(false);
        // Close the run_log row with what the run actually did. updateRunLog
        // upserts, so a run whose opening insert failed still leaves a record.
        try {
          // THIS run's counters only (a failed run has none — it used to
          // record the PREVIOUS run's lastResult). Every numeric counter is
          // passed; updateRunLog keeps the ones run_log has a column for, so
          // jobs_new / jobs_discarded_stale / … are no longer dropped.
          const counters = r?.counters ?? {};
          const numeric = Object.fromEntries(Object.entries(counters)
            .filter(([key, value]) => key.startsWith('jobs_') && Number.isFinite(Number(value)))
            .map(([key, value]) => [key, Number(value)]));
          db.updateRunLog?.(runId, {
            jobs_found: 0, jobs_scored: 0, jobs_queued: 0, jobs_prepared: 0, jobs_applied: 0, jobs_discarded: 0,
            ...numeric,
            mode: phase,
            started_at: runStartedAt,
            ended_at: runState.finishedAt,
            per_source: Array.isArray(r?.perSource) ? JSON.stringify(r.perSource.slice(0, 100)) : null,
            errors: runState.lastError
              ? runState.lastError
              : (runState.rca.length ? JSON.stringify(runState.rca.slice(0, 20)) : null),
          });
        } catch (err) {
          logger?.warn?.({ runId, phase, err: err.message }, 'could not close run_log row');
        }
        runLock.release();
        // The spreadsheet mirrors the table: rewrite it ONCE per run, at the end.
        refreshTracker();
      }
    })());
    return { started: true, phase, runId };
  }

  async function startAssist(jobId) {
    if (runState.running) {
      const err = new Error(`busy: ${runState.phase} is in progress`);
      err.statusCode = 409;
      throw err;
    }
    // Idempotency guard (same as the CLI): never re-fill a completed — or
    // unverified — application; that risks submitting it twice.
    if (isSubmittedOrUnverified(db.getJob?.(jobId))) {
      const err = new Error('this job was already submitted (or has an unverified auto-submit), not re-filling to avoid a duplicate application');
      err.statusCode = 409;
      throw err;
    }
    const approval = db.getApprovalByJob?.(jobId);
    if (!approval || approval.approval_status !== APPROVAL_STATUS.APPROVED) {
      const err = new Error('packet is not human-approved, approve it first');
      err.statusCode = 400;
      throw err;
    }
    const loaded = deps.loadPacketImpl ? deps.loadPacketImpl(approval) : loadPacket(approval);
    if (!loaded) {
      const err = new Error(`packet file unreadable for job ${jobId}`);
      err.statusCode = 500;
      throw err;
    }
    // Refuse rather than re-prepare: this path is a human pressing Auto-fill on
    // one reviewed job, and quietly replacing the documents they approved would
    // defeat the approval boundary just as surely as filling somebody else's.
    const owned = packetOwnershipCheck(loaded, config);
    if (!owned.ok) {
      const err = new Error(
        `this packet is not the active candidate's — ${owned.reason}. `
        + 'Prepare it again so the resume, cover letter and screening answers describe whoever is applying.',
      );
      err.statusCode = 409;
      throw err;
    }
    const packet = reconcilePacket(loaded, jobId);
    const runId = randomUUID();
    Object.assign(runState, {
      running: true, phase: `assist:${jobId}`, startedAt: new Date().toISOString(),
      finishedAt: null, lastError: null, cancelRequested: false,
      runId, rca: [], partial: false,
      progress: {
        kind: 'jobs', total: 1, completed: 0, currentJobId: jobId,
        items: [{ jobId, status: 'queued' }],
      },
    });
    track((async () => {
      try {
        const result = await assistFn({
          packet, config, mode: 'LIVE_ASSIST', approval, options: {},
          deps: {
            // Same hand-off watch the batch path wires: a human who submits in
            // the window we leave open is recorded (as submit_unverified until
            // they confirm), instead of the job silently staying "ready".
            onHumanSubmitted: (update) => { recordAssistResult(db, jobId, update); refreshTracker(); },
            ...deps,
            shouldCancel: () => runState.cancelRequested,
          },
        });
        recordAssistResult(db, jobId, result);
        refreshTracker();
        runState.lastResult = {
          phase: 'assist', jobId, status: result.status,
          blockers: result.blockers ?? [], resumed: result.resumed === true,
        };
        runState.progress = {
          total: 1, completed: 1, currentJobId: null,
          items: [{ jobId, status: result.status, blockers: result.blockers ?? [] }],
        };
      } catch (err) {
        const message = sanitizeErrorMessage(err.message);
        runState.lastError = `assist failed: ${message}`;
        runState.rca = [buildRca({ operation: 'assist', source: jobId, error: err, runId })];
        runState.progress = {
          total: 1, completed: 1, currentJobId: null,
          items: [{ jobId, status: 'failed', error: message }],
        };
      } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
      }
    })());
    return { started: true, jobId, runId, note: 'browser will stop before submit, review and click Submit yourself' };
  }

  /**
   * Auto-apply across a chosen set of jobs — fully orchestrated, ONE browser at
   * a time. For each job this now runs the WHOLE chain a human used to click
   * through by hand:
   *
   *   1. PREPARE  — jobs without a packet get a tailored resume + packet built
   *   2. APPROVE  — clicking Auto-apply IS the explicit human approval
   *   3. FILL     — open the posting, fill every known field, advance safe
   *                 Next/Continue steps, and STOP before the final Submit
   *
   * Nothing is ever auto-submitted — the browser is left open on the final page
   * for the human to review and click Submit. Jobs whose packet cannot be
   * prepared/loaded are reported in `skipped`, never silently dropped. The
   * batch runs in the background; the UI polls /api/run/status for progress.
   *
   * When `runOpts.autoSubmit` is true (an explicit, per-run human choice), the
   * runner also clicks the final Submit — but only on a completely clean form
   * and under the daily application cap; see applyRunner.tryAutoSubmit.
   *
   * @param {string[]} jobIds
   * @param {{ autoSubmit?: boolean }} [runOpts]
   * @returns {{ started: true, queued: number }}
   */
  function startAssistBatch(jobIds, runOpts = {}) {
    if (runState.running) {
      const err = new Error(`busy: ${runState.phase} is in progress`);
      err.statusCode = 409;
      throw err;
    }
    const ids = batchJobIds(jobIds);
    if (ids.length === 0) {
      const err = new Error('select at least one job to auto-apply');
      err.statusCode = 400;
      throw err;
    }
    const runId = randomUUID();
    Object.assign(runState, {
      running: true, phase: `auto-apply (0/${ids.length})`,
      startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
      cancelRequested: false, runId, rca: [], partial: false,
      progress: {
        // `kind` tells the UI whether to label these rows as boards or jobs.
        kind: 'jobs', total: ids.length, completed: 0, currentJobId: null,
        items: ids.map((jobId) => ({ jobId, status: 'queued' })),
      },
    });
    const batchStartedAt = runState.startedAt;
    track((async () => {
      const results = [];
      const skipped = [];
      let queueLen = 0;
      let cancelled = false;
      try {
        // LAUNCH PREFLIGHT. Without a browser every job in the batch failed
        // one at a time, each with Playwright's multi-line install banner as
        // its "reason". Check once, before anything is prepared or approved,
        // and fail the batch with the one line that fixes it. Skipped when
        // the runner is injected (it does not launch Playwright) unless a
        // preflight is injected too.
        const preflight = deps.browserPreflight
          ?? (deps.assistFn ? null : async () => {
            const { checkBrowserAvailable } = await import('../automation/browser.js');
            return checkBrowserAvailable({ channel: config?.runtime?.browserChannel ?? null });
          });
        const browser = preflight ? await preflight() : { ok: true };
        if (!browser?.ok) {
          const reason = `${browser?.code ?? 'browser_unavailable'}: ${browser?.message ?? 'Browser not installed — run: npx playwright install chromium'}`;
          runState.lastError = reason;
          for (const jobId of ids) skipped.push({ jobId, reason });
          runState.progress.items = ids.map((jobId) => ({ jobId, status: 'skipped', reason }));
          runState.progress.completed = ids.length;
          runState.lastResult = {
            phase: 'assist-batch', total: 0, skipped, results, environment: browser?.code ?? 'browser_unavailable',
          };
          return;
        }

        // Auto-submit is fail-closed before any browser opens. Ordinary
        // fill-and-review batches retain the existing prepare/approve flow.
        let autoSubmitEligible = null;
        // Packet each auto-submit job pointed at when the run was authorized.
        const reviewedPacketPath = new Map();
        const { autoSubmitReviewProblem } = await import('../apply/autoApplyEligibility.js');
        if (runOpts.autoSubmit === true) {
          const preview = autoApplyEligibility(ids, true);
          autoSubmitEligible = new Set(preview.items.filter((x) => x.eligible).map((x) => x.jobId));
          for (const item of preview.items.filter((x) => !x.eligible)) {
            skipped.push({ jobId: item.jobId, reason: item.reasons.join(' ') });
          }
          runState.progress.items = preview.items.map((item) => ({
            jobId: item.jobId,
            status: item.eligible ? 'queued' : 'ineligible',
            ...(item.eligible ? {} : { reason: item.reasons[0] }),
          }));
          runState.progress.completed = preview.ineligible;
          // ONLY PACKETS A HUMAN REVIEWED BEFORE THIS RUN. The ordinary flow
          // below prepares missing/foreign packets and approves them itself;
          // for auto-submit that meant a packet nobody had seen was built,
          // approved and submitted in one step. Such jobs are excluded here.
          for (const jobId of [...autoSubmitEligible]) {
            const approval = db.getApprovalByJob?.(jobId) ?? null;
            const owned = storedPacketIsOurs(approval);
            const problem = !owned.ok
              ? `its packet is not the active candidate's (${owned.reason})`
              : autoSubmitReviewProblem({ job: db.getJob?.(jobId), approval, batchStartedAt });
            if (problem) {
              autoSubmitEligible.delete(jobId);
              skipped.push({ jobId, reason: `not auto-submitted: ${problem}` });
              const item = runState.progress.items.find((x) => x.jobId === jobId);
              if (item) Object.assign(item, { status: 'ineligible', reason: problem });
              runState.progress.completed += 1;
            } else {
              reviewedPacketPath.set(jobId, approval.packet_path);
            }
          }
        }

        // 0. Never queue a job that is already submitted (or whose auto-submit
        //    is unverified) — auto-approving + re-filling it could double-apply.
        const candidates = [];
        for (const jobId of ids) {
          if (autoSubmitEligible && !autoSubmitEligible.has(jobId)) continue;
          if (isSubmittedOrUnverified(db.getJob?.(jobId))) {
            skipped.push({ jobId, reason: 'already submitted, skipped to avoid a duplicate application' });
          } else {
            candidates.push(jobId);
          }
        }

        // 1. Prepare packets for jobs that don't have one yet (tailored resume
        //    + application packet). Failures are honest skips, not crashes.
        // A job needs a packet when it has none — and equally when the one it
        // has belongs to a different candidate or was prepared under a
        // different search profile. Re-preparing rebuilds the documents for
        // whoever is active now; `enqueueForApproval` repoints the approval at
        // the new packet and resets it to pending, so the foreign packet can
        // never be the thing that gets filled.
        const needPacket = candidates.filter((id) => {
          const approval = db.getApprovalByJob?.(id);
          if (!approval) return true;
          const owned = storedPacketIsOurs(approval);
          if (!owned.ok) {
            logger?.info?.(`auto-apply: re-preparing ${id} — ${owned.reason}`);
          }
          return !owned.ok;
        });
        if (needPacket.length) {
          runState.phase = `auto-apply, preparing ${needPacket.length} packet(s)…`;
          const prepareImpl = deps.prepareForJobsFn ?? preparePacketsForJobs;
          const prep = await prepareImpl({
            config, db, logger, jobIds: needPacket,
            deps: { ...deps, shouldCancel: () => runState.cancelRequested },
          });
          for (const f of prep.failed ?? []) skipped.push({ jobId: f.jobId, reason: f.error });
        }

        // 2+3. Approve (the click is the approval) and fill, one at a time.
        const queue = [];
        for (const jobId of candidates) {
          if (skipped.some((s) => s.jobId === jobId)) continue;
          let approval = db.getApprovalByJob?.(jobId);
          if (!approval) { skipped.push({ jobId, reason: 'no packet could be prepared' }); continue; }
          if (approval.approval_status !== APPROVAL_STATUS.APPROVED) {
            approveJobPacket(db, jobId);
            approval = db.getApprovalByJob(jobId);
          }
          const loaded = deps.loadPacketImpl ? deps.loadPacketImpl(approval) : loadPacket(approval);
          if (!loaded) { skipped.push({ jobId, reason: 'packet file unreadable' }); continue; }
          queue.push({ jobId, packet: reconcilePacket(loaded, jobId), approval });
        }
        queueLen = queue.length;

        let done = 0;
        const autoSubmit = runOpts.autoSubmit === true;
        // Seed the daily cap from what was already submitted today, and bump
        // it as this batch submits, so one batch can never blow past the cap.
        let dailyCount = db.countAppliedOnLocalDay?.(nowDate(), config?.candidate?.location?.timezone ?? null) ?? db.countAppliedOn?.(new Date().toISOString().slice(0, 10)) ?? 0;
        for (const { jobId, packet, approval } of queue) {
          // The queue is a snapshot; honor what the human did SINCE it was
          // built. Cancel stops between jobs (never mid-fill), and a job the
          // user rejected/archived/submitted during the run is skipped.
          if (runState.cancelRequested) {
            cancelled = true;
            skipped.push({ jobId, reason: 'cancelled before this job started' });
            const item = runState.progress.items.find((x) => x.jobId === jobId);
            if (item) Object.assign(item, { status: 'cancelled' });
            runState.progress.completed += 1;
            continue;
          }
          // Re-checked at the moment of filling: an approval or packet that
          // changed while earlier jobs were running was not what was reviewed.
          const liveSkip = liveSkipReason(jobId) ?? (autoSubmit
            ? (() => {
              const problem = autoSubmitReviewProblem({
                job: db.getJob?.(jobId), approval: db.getApprovalByJob?.(jobId),
                batchStartedAt, snapshotPacketPath: reviewedPacketPath.get(jobId) ?? null,
              });
              return problem ? `not auto-submitted: ${problem}` : null;
            })()
            : null);
          if (liveSkip) {
            skipped.push({ jobId, reason: liveSkip });
            done += 1;
            // Keep the visible counter moving; without this the header stalled
            // (e.g. stuck at 2/5) whenever a queued job was skipped mid-run.
            runState.progress.completed += 1;
            continue;
          }
          runState.phase = `auto-apply (${done + 1}/${queue.length}), ${jobId}`;
          runState.progress.currentJobId = jobId;
          const progressItem = runState.progress.items.find((x) => x.jobId === jobId);
          if (progressItem) progressItem.status = 'opening';
          try {
            const result = await assistFn({
              packet, config, mode: 'LIVE_ASSIST', approval, dailyCount,
              options: { autoSubmit },
              deps: {
                // A confirmation page the human reaches in the handed-over
                // window is recorded as submit_unverified with its evidence.
                onHumanSubmitted: (update) => { recordAssistResult(db, jobId, update); refreshTracker(); },
                ...deps,
                shouldCancel: () => runState.cancelRequested,
              },
            });
            recordAssistResult(db, jobId, result);
            captureUnansweredQuestions(jobId, result);
            if (result.submitted === true) dailyCount += 1;
            const itemResult = {
              jobId, status: result.status, submitted: result.submitted === true,
              blockers: result.blockers ?? [], resumed: result.resumed === true,
              // What was actually answered on the live form, and why a
              // final submit was held back — the audit trail for a run that
              // may click Submit on the user's behalf.
              ...(Array.isArray(result.liveAnswers) ? { liveAnswers: result.liveAnswers } : {}),
              ...(result.autoSubmitWithheld ? { autoSubmitWithheld: result.autoSubmitWithheld } : {}),
            };
            results.push(itemResult);
            if (progressItem) Object.assign(progressItem, itemResult);
          } catch (err) {
            const message = sanitizeErrorMessage(err.message);
            results.push({ jobId, status: 'failed', error: message });
            if (progressItem) Object.assign(progressItem, { status: 'failed', error: message });
            runState.rca.push(buildRca({ operation: 'auto-apply', source: jobId, error: err, runId }));
          }
          done += 1;
          runState.progress.completed += 1;
        }
        runState.progress.currentJobId = null;
        for (const skip of skipped) {
          const item = runState.progress.items.find((x) => x.jobId === skip.jobId);
          if (item && ['queued', 'opening'].includes(item.status)) {
            Object.assign(item, { status: cancelled ? 'cancelled' : 'skipped', reason: skip.reason });
          }
        }
        runState.progress.completed = ids.length;
        refreshTracker();
        runState.lastResult = {
          phase: 'assist-batch', total: queue.length, skipped, results,
          ...(cancelled ? { cancelled: true } : {}),
        };
      } catch (err) {
        // A background batch failure must NEVER escape — an unhandled rejection
        // here would crash the whole dashboard process (the UI would then only
        // ever show "Failed to fetch").
        const message = sanitizeErrorMessage(err.message);
        runState.lastError = `auto-apply failed: ${message}`;
        runState.rca.push(buildRca({ operation: 'auto-apply', error: err, runId }));
        runState.lastResult = { phase: 'assist-batch', total: queueLen, skipped, results };
      } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
      }
    })());
    return { started: true, queued: ids.length, runId };
  }

  /** Current time: injectable as a function for deterministic tests. */
  const nowDate = () => (typeof deps.now === 'function' ? deps.now() : new Date());

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      // A malformed percent-escape in the path (`/api/jobs/%E0%A4`) makes
      // decodeURIComponent throw URIError — the request is wrong, not the
      // server, so it is a 400 rather than a 500.
      const status = err instanceof URIError ? 400 : (err.statusCode ?? 500);
      const body = { error: sanitizeErrorMessage(err instanceof URIError ? 'malformed URL escape in the request path' : err.message) };
      if (err.holder) body.holder = err.holder;
      if (res.headersSent) { res.end(); return; }
      sendJson(res, status, body);
    }
  });

  async function route(req, res) {
    setSecurityHeaders(res);
    // ── Cross-site request defense ─────────────────────────────────────────
    // Binding to 127.0.0.1 stops the NETWORK, not the user's own browser: any
    // website they visit can fire fetch('http://127.0.0.1:4646/…'), and a
    // DNS-rebinding page can even read responses. Requests must therefore
    // carry a loopback Host header, and browser requests that declare an
    // Origin must come from localhost.
    if (!isLoopbackHost(req.headers.host)) {
      return sendJson(res, 403, { error: 'forbidden: the dashboard only serves localhost' });
    }
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // The optional Chromium extension has a different origin by design. It is
    // admitted only on this narrow API namespace, only from a real extension
    // origin, and only with a 32+ byte shared key. All ordinary dashboard
    // routes retain the stricter same-loopback-origin policy below.
    if (path.startsWith('/api/extension/')) {
      const origin = String(req.headers.origin ?? '');
      const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
      // Edge does not consistently attach the extension origin to privileged
      // loopback fetches (depending on popup/service-worker context). Treat the
      // high-entropy shared key as authentication, while Fetch Metadata + CORS
      // continue to reject normal cross-site webpages. A null/absent Origin is
      // accepted only on this key-protected namespace.
      const allowedTransport = isChromiumExtensionOrigin(origin)
        || isAllowedOrigin(origin)
        || origin === 'null';
      if (!allowedTransport || fetchSite === 'cross-site') {
        return sendJson(res, 403, { error: 'forbidden: extension transport rejected' });
      }
      if (origin) setExtensionCors(res, origin);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!validExtensionKey(extensionKey, req.headers['x-job-agent-key'])) {
        return sendJson(res, extensionKey ? 401 : 503, {
          error: extensionKey
            ? 'invalid Job Agent extension key'
            : 'extension API is disabled; set JOB_AGENT_EXTENSION_KEY in .env and restart',
        });
      }

      const match = path.match(/^\/api\/extension\/jobs\/([^/]+)(?:\/(payload|result|files\/(resume|cover-letter)))?$/);
      if (!match) return sendJson(res, 404, { error: `no extension route: ${req.method} ${path}` });
      const jobId = decodeURIComponent(match[1]);
      const action = match[2] ?? 'payload';
      if (req.method === 'GET' && action === 'payload') {
        return sendJson(res, 200, buildExtensionPayload({
          db, config, jobId, loadPacketImpl: deps.loadPacketImpl,
        }));
      }
      if (req.method === 'GET' && action.startsWith('files/')) {
        const artifact = readApprovedArtifact({
          db, config, jobId, kind: match[3], loadPacketImpl: deps.loadPacketImpl,
        });
        res.writeHead(200, {
          'content-type': artifact.type,
          'content-length': artifact.bytes.length,
          'content-disposition': `attachment; filename="${artifact.name.replace(/["\r\n]/g, '_')}"`,
        });
        res.end(artifact.bytes);
        return;
      }
      if (req.method === 'POST' && action === 'result') {
        const body = await readBody(req);
        // The extension may only REPORT on a job it was given an approved
        // packet for. This route used to accept any id: an unknown one created
        // nothing but still "recorded", and a submitted (or unverified-submit)
        // job could be flipped back to assist_started / ready_for_submit —
        // un-submitting an application and re-opening it for a second fill.
        const current = db.getJob?.(jobId);
        if (!current) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
        if (isSubmittedOrUnverified(current)) {
          return sendJson(res, 409, { error: 'this job is already submitted (or awaiting submit verification) — result not recorded' });
        }
        const approvalRow = db.getApprovalByJob?.(jobId);
        if (!approvalRow || approvalRow.approval_status !== APPROVAL_STATUS.APPROVED) {
          return sendJson(res, 409, { error: 'this job\'s packet is not human-approved — approve it before using the extension' });
        }
        const filled = Array.isArray(body.filled) ? body.filled.slice(0, 120).map((x) => ({
          field: String(x?.field ?? '').slice(0, 80),
          label: String(x?.label ?? '').slice(0, 120),
          source: String(x?.source ?? '').slice(0, 40),
        })) : [];
        const blockers = Array.isArray(body.blockers)
          ? body.blockers.slice(0, 40).map((x) => String(x).slice(0, 240)) : [];
        const formDetected = body.formDetected === true;
        const startedApplication = body.startedApplication === true;
        const readyForReview = body.readyForReview === true
          && formDetected && filled.length > 0 && blockers.length === 0;
        const status = readyForReview ? LIFECYCLE.READY_FOR_SUBMIT
          : formDetected && blockers.length > 0 ? LIFECYCLE.ASSIST_BLOCKED
            : LIFECYCLE.ASSIST_STARTED;
        const phases = [
          { phase: 'extension_assist_started', at: nowDate().toISOString() },
          { phase: status, at: nowDate().toISOString() },
        ];

        // Once a user follows an aggregator's Apply link, remember the verified
        // employer URL. Future extension runs open the useful direct page
        // instead of bouncing through LinkedIn/Indeed again.
        if (body.contextVerified === true && isSafeObservedApplicationUrl(body.observedUrl)) {
          if (isAggregatorUrl(current.url)) {
            db.upsertJob({ id: jobId, url: String(body.observedUrl).slice(0, 2048) });
          }
        }
        recordAssistResult(db, jobId, {
          status, submitted: false, filled, blockers, phases,
        });
        refreshTracker();
        return sendJson(res, 200, {
          recorded: true, status, formDetected, startedApplication, readyForReview,
        });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    // Origin is not reliably sent for cross-site GETs (for example an image or
    // form navigation). Modern browsers do send Fetch Metadata, so reject an
    // explicitly cross-site request before it can trigger even a read endpoint
    // with work behind it, such as the on-demand health check.
    if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
      return sendJson(res, 403, { error: 'forbidden: cross-site requests are not allowed' });
    }
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    if (!readOnly && !isAllowedOrigin(req.headers.origin, server.address()?.port)) {
      return sendJson(res, 403, { error: 'forbidden: cross-origin requests are not allowed' });
    }
    // CSRF: a state-changing request must be one a plain HTML form or an
    // <img>/no-cors fetch CANNOT send. Those can only produce the three
    // "simple" content types (form-urlencoded, multipart, text/plain) and no
    // custom headers, and some browsers omit Origin on them — which the check
    // above treats as a same-origin client. Requiring JSON, or the custom
    // `X-Job-Agent: 1` header the dashboard sends on every request, forces a
    // CORS preflight that a foreign page can never pass.
    if (!readOnly && !isTrustedMutation(req)) {
      return sendJson(res, 403, {
        error: 'forbidden: send JSON (content-type: application/json) or the X-Job-Agent: 1 header',
      });
    }

    if (readOnly && (path === '/' || path === '/index.html')) {
      const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }
    // Interview-prep mini-site, mounted under /learn (a separate hash-routed SPA).
    // Redirect the bare path to /learn/ so the SPA's relative asset URLs resolve
    // under /learn/assets/ rather than the dashboard root.
    if (req.method === 'GET' && path === '/learn') {
      res.writeHead(302, { location: '/learn/' });
      res.end();
      return;
    }
    if (req.method === 'GET' && (path === '/learn/' || path === '/learn/index.html')) {
      const html = readFileSync(join(PUBLIC_DIR, 'learn', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    // Static assets (css/js/img/fonts) for the dashboard and the /learn mini-site.
    if (readOnly && (path.startsWith('/assets/') || path.startsWith('/learn/assets/'))) {
      return serveStatic(req, res, path);
    }
    if (req.method === 'GET' && path === '/api/stats') {
      // Stale-while-revalidate: a stats rebuild blocks this single-threaded
      // server for seconds on a large store; the tiles can show the last value
      // (flagged `stale: true`) while one rebuild runs after the response.
      return sendJson(res, 200, dashboardStats(db, { now: nowDate(), config, allowStale: true }));
    }
    // The Today queue: the ten next actions + setup notices (see todayQueue).
    if (req.method === 'GET' && path === '/api/today') {
      return sendJson(res, 200, todayQueue(db, { now: nowDate(), config, browserAvailable: await browserAvailableCached() }));
    }
    // The Applications workspace: every application as a card in its stage,
    // with recorded outcomes, follow-ups and the numbers they add up to.
    if (req.method === 'GET' && path === '/api/applications') {
      return sendJson(res, 200, applicationsWorkspace(db, { now: nowDate(), config }));
    }
    if (req.method === 'GET' && path === '/api/jobs') {
      const filters = Object.fromEntries(url.searchParams.entries());
      filters.now = nowDate();
      // One page, not the table: `?limit=1e9` would serialize every row of a
      // 100k-job database. The UI's largest page size is 500.
      if (Number(filters.limit) > MAX_JOBS_PAGE) filters.limit = String(MAX_JOBS_PAGE);
      return sendJson(res, 200, boardPage(db, filters));
    }
    // Ad-hoc query-first discovery: "find jobs matching this phrase, now".
    // Shares the run lock with /api/run, because it drives the same pipeline
    // and two concurrent writers would interleave upserts on the same rows.
    if (req.method === 'POST' && path === '/api/search') {
      const body = await readBody(req);
      const query = String(body.query ?? '').trim();
      if (!query) return sendJson(res, 400, { error: 'enter something to search for' });
      if (runState.running) {
        return sendJson(res, 409, { error: `a ${runState.phase} run is in progress — wait for it to finish` });
      }
      /*
       * TAKE THE LOCK, do not merely look at it.
       *
       * This checked `runState.running` and never SET it, so the mutual
       * exclusion it documents only worked in one direction: a run blocked a
       * search, and a search blocked nothing. Starting "Find new jobs" while a
       * role search was in flight ran both pipelines against the same jobs
       * table at once — the interleaved upserts this guard exists to prevent,
       * and with the two modes now writing different `discovery_mode` values to
       * the same rows, the ownership rule in persistJob would be racing too.
       *
       * Held in a finally so a failed search can never strand the lock and
       * leave every later run answering 409.
       */
      const searchLock = takeRunLock('role_search');
      Object.assign(runState, {
        running: true, phase: `role search: ${query}`, startedAt: new Date().toISOString(),
        finishedAt: null, lastError: null, cancelRequested: false,
        runId: randomUUID(), rca: [], partial: false, progress: null,
      });
      try {
        const searchFn = deps.querySearchFn ?? runQuerySearch;
        const result = await searchFn({ config, db, logger, query, deps });
        return sendJson(res, 200, result);
      } catch (err) {
        runState.lastError = sanitizeErrorMessage(err.message);
        return sendJson(res, err.statusCode ?? 400, { error: sanitizeErrorMessage(err.message) });
      } finally {
        runState.running = false;
        runState.finishedAt = new Date().toISOString();
        searchLock.release();
      }
    }
    /*
     * The role searches that have been run and still hold rows.
     *
     * Role-search results live in the same table as the personalized board but
     * are fenced off by `discovery_mode`, so they need their own index — there
     * is no other way to find them again, and without one they would be rows
     * nobody could reach or clean up.
     */
    if (req.method === 'GET' && path === '/api/search/history') {
      return sendJson(res, 200, { searches: db.listRoleSearches?.() ?? [] });
    }
    // Discard one role search entirely. Scoped to `discovery_mode` in SQL, so
    // it can never reach a row the personalized board owns.
    if (req.method === 'DELETE' && path === '/api/search') {
      const query = String(url.searchParams.get('query') ?? '').trim();
      if (!query) return sendJson(res, 400, { error: 'which search should be cleared?' });
      const removed = db.deleteRoleSearch?.(query) ?? 0;
      // `kept`: rows the user had acted on (applied, decided, packet, queued)
      // are re-owned by the personalized board instead of deleted.
      return sendJson(res, 200, { query, removed, kept: db.lastRoleSearchKept ?? 0 });
    }
    if (req.method === 'GET' && path === '/api/run/status') {
      return sendJson(res, 200, runState);
    }
    // Run HISTORY, as opposed to the live state above. run_log was written by
    // nothing and read by nothing, so "what did last night's run do?" had no
    // answer anywhere in the product.
    if (req.method === 'GET' && path === '/api/runs') {
      const requested = Number(url.searchParams.get('limit') ?? RUNS_DEFAULT_LIMIT);
      const limit = Number.isFinite(requested) && requested >= 1
        ? Math.min(RUNS_MAX_LIMIT, Math.floor(requested)) : RUNS_DEFAULT_LIMIT;
      return sendJson(res, 200, { runs: (db.listRunLogs?.({ limit }) ?? []).map(runSummary) });
    }
    if (req.method === 'POST' && path === '/api/run/cancel') {
      if (!runState.running) {
        return sendJson(res, 409, { error: 'nothing is running' });
      }
      runState.cancelRequested = true;
      // Abort in-flight and gate-queued network work too. Without this, cancel
      // was cooperative polling only: adapters noticed between operations, but a
      // request already on the wire still had to finish or time out (30s), so
      // stopping a discovery run took ~30 seconds.
      runAbort?.abort();
      return sendJson(res, 202, {
        cancelling: true,
        phase: runState.phase,
        note: runState.phase === 'discover'
          ? 'queued discovery work is dropped and in-flight requests are aborted; results already found are kept'
          : 'the current safe step will finish, then queued work will stop',
      });
    }
    if (req.method === 'GET' && path === '/api/sections') {
      const sections = dashboardSections(db, { now: nowDate() });
      // `?only=<key>`: one section, for a panel that refreshes on its own.
      const only = url.searchParams.get('only');
      if (only) {
        if (!Object.hasOwn(sections, only)) {
          return sendJson(res, 400, { error: `unknown section "${only}" (use ${Object.keys(sections).join(', ')})` });
        }
        return sendJson(res, 200, { [only]: sections[only] });
      }
      return sendJson(res, 200, sections);
    }
    if (req.method === 'GET' && path === '/api/reports') {
      return sendJson(res, 200, buildReports(db, { now: nowDate(), config }));
    }
    if (req.method === 'GET' && path === '/api/documents') {
      return sendJson(res, 200, buildDocuments(db, { root: config?.root ?? null, now: nowDate() }));
    }
    if (req.method === 'GET' && path === '/api/master-resume') {
      return sendJson(res, 200, masterResumeState());
    }
    if (req.method === 'GET' && path === '/api/master-resume/file') {
      const artifact = readMasterResumeFile();
      // A DOCX can never render in the browser, so it is always a download and
      // is locked down accordingly.
      res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-length': artifact.bytes.length,
        'content-disposition': `attachment; filename="${artifact.name.replace(/["\r\n]/g, '_')}"`,
      });
      res.end(artifact.bytes);
      return;
    }
    if (req.method === 'POST' && path === '/api/master-resume') {
      const body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
      const encoded = String(body.contentBase64 ?? '');
      if (!encoded) {
        return sendJson(res, 400, { error: 'no file contents were received' });
      }
      // Reject anything that is not strict base64 before decoding: Buffer.from
      // silently DISCARDS invalid characters, which would turn a mangled
      // upload into a plausible-looking but corrupt resume.
      if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) {
        return sendJson(res, 400, { error: 'the file contents were not transferred correctly, try again' });
      }
      const bytes = Buffer.from(encoded, 'base64');
      const result = replaceMasterResume({ filename: body.filename, bytes });
      // The whole point of the upload: say immediately whether this resume and
      // the saved search profile are describing the same job. Replacing the
      // file changes nothing about discovery on its own.
      return sendJson(res, 200, { ...result, suggestions: resumeSuggestions() });
    }
    // Role/skill evidence read out of the CURRENT master resume, next to what
    // discovery is actually searching for. Read-only: it proposes, and adopting
    // anything is a separate, explicit POST — see src/resume/resumeProfile.js
    // for why deriving targetTitles automatically would be wrong.
    if (req.method === 'GET' && path === '/api/master-resume/suggestions') {
      return sendJson(res, 200, resumeSuggestions());
    }
    if (req.method === 'POST' && path === '/api/master-resume/restore') {
      const body = await readBody(req);
      return sendJson(res, 200, restoreMasterResume(body.name));
    }
    /* ── Search profiles ───────────────────────────────────────────────────
     *
     * WHOSE SEARCH IS RUNNING? These endpoints exist so the board can answer
     * that, and so a different candidate's resume can produce a different
     * search without anyone editing JSON by hand. `/api/profile` above is a
     * different thing: the contact details the FORM FILLER types. This is what
     * the agent LOOKS FOR.
     */
    // Re-read the active profile's background (roles, employers, education,
    // skills) from the master resume — the fix for a profile still carrying
    // the template's "Example Corp". Search goals are never touched.
    if (req.method === 'POST' && path === '/api/search-profiles/refresh-background') {
      if (runState.running) {
        return sendJson(res, 409, { error: `a ${runState.phase} run is in progress — try again when it finishes` });
      }
      const root = requireConfigRoot();
      const result = await refreshBackgroundFromResume(root, masterResumeFile(root), { db });
      if (!result.ok) return sendJson(res, 409, { error: result.reason });
      let warning = null;
      if (result.changed.length) {
        warning = reloadConfig();
        if (!warning) scheduleRescore();
      }
      return sendJson(res, 200, { id: result.id, changed: result.changed, warning });
    }
    if (req.method === 'GET' && path === '/api/search-profiles') {
      const root = requireConfigRoot();
      const listing = listSearchProfiles(root);
      const active = readActiveProfile(root);
      return sendJson(res, 200, {
        ...listing,
        active: active ? summarizeSearchProfile(active) : null,
      });
    }
    // Read the master resume as a PROPOSAL: what it says, whether it looks like
    // the same person, and the three things the user may do about it. Read-only
    // — see src/profile/fromResume.js for why adopting stays an explicit act.
    if (req.method === 'GET' && path === '/api/search-profiles/from-resume/preview') {
      const root = requireConfigRoot();
      const result = await proposeProfileFromResume(root, masterResumeFile(root));
      return sendJson(res, 200, result);
    }
    // Catch-all by id. MUST stay after every literal sub-path above: it treats
    // whatever follows the prefix as a profile id, so a route added below it
    // silently becomes a 404 for a profile that does not exist.
    if (req.method === 'GET' && path.startsWith('/api/search-profiles/')) {
      const root = requireConfigRoot();
      const id = decodeURIComponent(path.slice('/api/search-profiles/'.length));
      const profile = readSearchProfile(root, id);
      if (!profile) return sendJson(res, 404, { error: `no profile named "${id}"` });
      return sendJson(res, 200, summarizeSearchProfile(profile));
    }
    if (req.method === 'POST' && path === '/api/search-profiles/activate') {
      const body = await readBody(req);
      /**
       * A RUN IN PROGRESS OWNS THE CONFIGURATION IT STARTED WITH.
       *
       * Activation rewrites candidate.json, scoring.json, exclusions.json and
       * the screening answers, then reloads the in-memory config. An auto-apply
       * batch holds a queue of packets built BEFORE that, but reads `config`
       * fresh on every iteration — so activating mid-batch filled the remaining
       * jobs with one profile's screening answers onto another profile's
       * documents, in the same run. The batch is short and the switch can wait.
       */
      // A dry run computes and writes nothing, so it stays available.
      if (runState.running && body.dryRun !== true) {
        return sendJson(res, 409, {
          error: `a ${runState.phase} run is in progress — wait for it to finish before switching search profiles, `
            + 'so one batch cannot mix two profiles\' answers and documents',
        });
      }
      return saving(res, () => {
        const root = requireConfigRoot();
        const summary = activateProfile(root, String(body.id ?? ''), { dryRun: body.dryRun === true });
        // Activation rewrites candidate.json, scoring.json and exclusions.json.
        // The in-memory config MUST be reloaded or the board keeps serving the
        // previous candidate's search until the process restarts.
        const warning = summary.dryRun ? null : reloadConfig();
        // A different person: every route now reads THEIR database.
        const workspaceChanged = summary.dryRun ? false : useActiveWorkspace();
        if (!summary.dryRun && !warning) scheduleRescore();
        return sendJson(res, 200, { ...summary, warning, workspaceChanged });
      });
    }
    // Re-open a resume question the user had settled with "Keep my current
    // goals". Clearing the acknowledgment is the only way back to the prompt,
    // so the decision is durable without being irreversible.
    if (req.method === 'POST' && path === '/api/search-profiles/acknowledge-resume') {
      const body = await readBody(req);
      return saving(res, () => {
        const root = requireConfigRoot();
        if (body.clear === true) {
          return sendJson(res, 200, acknowledgeResumeMismatch(root, ''));
        }
        const proposed = readActiveProfile(root);
        if (!proposed) return sendJson(res, 200, { acknowledged: false });
        return sendJson(res, 200, acknowledgeResumeMismatch(root, String(body.fingerprint ?? '')));
      });
    }
    if (req.method === 'POST' && path === '/api/search-profiles/migrate') {
      return saving(res, () => {
        const result = migrateLegacyCandidate(requireConfigRoot());
        return sendJson(res, 200, result);
      });
    }
    if (req.method === 'DELETE' && path.startsWith('/api/search-profiles/')) {
      const id = decodeURIComponent(path.slice('/api/search-profiles/'.length));
      return saving(res, () => sendJson(res, 200, deleteSearchProfile(requireConfigRoot(), id)));
    }
    /* ── adding and editing a person ──────────────────────────────────────
     * "Add profile" never replaces anyone's resume: a resume given here is read
     * for the form and saved into the NEW person's own workspace only. */
    if (req.method === 'POST' && path === '/api/search-profiles/read-resume') {
      const body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
      return saving(res, () => {
        const bytes = decodeResumeUpload(body);
        const { paragraphs } = extractDocxText(bytes);
        const draft = profileFromResume(paragraphs, {});
        return sendJson(res, 200, {
          fields: {
            fullName: draft.identity.fullName,
            email: draft.contact.email,
            phone: draft.contact.phone,
            targetRoles: draft.searchIntent.targetRoles,
            seniority: draft.searchIntent.seniority || '',
          },
          found: {
            roles: draft.searchIntent.targetRoles.length,
            jobs: draft.background.workHistory.length,
            skills: draft.background.skills.length,
          },
        });
      });
    }
    if (req.method === 'POST' && path === '/api/search-profiles') {
      const body = await readBody(req, MAX_UPLOAD_BODY_BYTES);
      if (runState.running && body.activate === true) {
        return sendJson(res, 409, { error: `a ${runState.phase} run is in progress — add the profile after it finishes` });
      }
      return saving(res, () => {
        const root = requireConfigRoot();
        let resume = null;
        if (body.resume?.contentBase64) {
          const bytes = decodeResumeUpload(body.resume);
          resume = { bytes, background: buildBackground(extractDocxText(bytes).paragraphs, { sourceFile: '' }) };
          delete resume.background._name; delete resume.background._headline; delete resume.background._contact;
        }
        const created = createPersonProfile(root, body.fields ?? {}, { resume });
        // The list being viewed right now: seeding copies from it.
        const viewedDb = db;
        let activated = null; let warning = null; let workspaceChanged = false;
        if (body.activate === true) {
          try { activated = activateProfile(root, created.id); }
          catch (err) { deleteSearchProfile(root, created.id); throw err; }
          warning = reloadConfig();
          workspaceChanged = useActiveWorkspace();
        }
        const seed = body.seed === true ? seedNewPerson(root, created.id, viewedDb) : { seeded: 0 };
        if (activated && !warning) scheduleRescore(); // scores the seeded copies under THEIR profile
        return sendJson(res, 200, { ...created, activated, warning, workspaceChanged, seeded: seed.seeded });
      });
    }
    if (req.method === 'PATCH' && path.startsWith('/api/search-profiles/')) {
      const id = decodeURIComponent(path.slice('/api/search-profiles/'.length));
      const body = await readBody(req);
      return saving(res, () => {
        const root = requireConfigRoot();
        const updated = updatePersonProfile(root, id, body.fields ?? {});
        let warning = null;
        // Editing the ACTIVE person changes what is searched for right now.
        if (updated.active) {
          if (runState.running) {
            throw Object.assign(new Error(`saved — the change applies after the ${runState.phase} run finishes`), { statusCode: 409 });
          }
          activateProfile(root, id);
          warning = reloadConfig();
          if (!warning) scheduleRescore();
        }
        return sendJson(res, 200, { ...updated, warning });
      });
    }
    if (req.method === 'POST' && path === '/api/search-profiles/from-resume') {
      const body = await readBody(req);
      /**
       * A RUN IN PROGRESS OWNS THE CONFIGURATION IT STARTED WITH.
       *
       * Activation rewrites candidate.json, scoring.json, exclusions.json and
       * the screening answers, then reloads the in-memory config. An auto-apply
       * batch holds a queue of packets built BEFORE that, but reads `config`
       * fresh on every iteration — so activating mid-batch filled the remaining
       * jobs with one profile's screening answers onto another profile's
       * documents, in the same run. The batch is short and the switch can wait.
       */
      // "keep" is an explicit no-op and changes no configuration.
      if (runState.running && String(body.choice ?? '') !== 'keep') {
        return sendJson(res, 409, {
          error: `a ${runState.phase} run is in progress — wait for it to finish before switching search profiles, `
            + 'so one batch cannot mix two profiles\' answers and documents',
        });
      }
      return saving(res, async () => {
        const root = requireConfigRoot();
        const choice = String(body.choice ?? '');
        const proposed = await proposeProfileFromResume(root, masterResumeFile(root));

        if (choice === 'keep') {
          // DURABLY recorded, not merely acknowledged in the response. This
          // returned a message and wrote nothing, so the drawer re-ran the
          // comparison on its next render and asked the same question again —
          // a decision the user had already made, over and over.
          //
          // "Keep" is also the one choice that still means something with no
          // resume on disk: there is nothing to compare against, so there is
          // nothing to record, and the answer is the same either way.
          const ack = proposed.available
            ? acknowledgeResumeMismatch(root, proposed.resumeFingerprint)
            : { acknowledged: false };
          return sendJson(res, 200, {
            choice,
            changed: false,
            acknowledged: ack.acknowledged,
            message: ack.acknowledged
              ? 'Your current search goals are unchanged. This resume will not be queried again unless you edit it.'
              : 'Your current search goals are unchanged.',
          });
        }
        if (!proposed.available) throw new Error(proposed.reason);

        if (choice === 'create') {
          // REFUSE BEFORE SAVING. Activation rejects a profile with no target
          // roles, but this route used to save first — so the refusal left an
          // unusable profile on disk, and every retry added another copy.
          if (!(proposed.proposal.searchIntent?.targetRoles ?? []).length) {
            throw Object.assign(new Error(
              'No job titles could be read from this resume, so a profile made from it would search for nothing. '
              + 'Put each job title on its own line (or before its dates), then upload the resume again.',
            ), { statusCode: 422 });
          }
          // Building again from the same resume — or for the same person whose
          // saved profile cannot search — updates that profile instead of
          // saving another copy beside it.
          const reuseId = resumeProfileToReuse(root, proposed.proposal, proposed.resumeFingerprint);
          // The new person gets their OWN workspace (their own jobs, resume and
          // outputs), and the resume they were built from is copied into it, so
          // switching back to the previous person never tailors from theirs.
          const id = reuseId ?? proposed.proposal.id;
          const workspace = (reuseId ? readSearchProfile(root, reuseId)?.workspace : '') || id;
          const ownResume = workspacePaths(root, workspace).resume;
          if (ownResume !== masterResumeFile(root)) {
            mkdirSync(dirname(ownResume), { recursive: true });
            copyFileSync(masterResumeFile(root), ownResume);
          }
          const saved = saveSearchProfile(root, {
            ...proposed.proposal,
            id,
            workspace,
            label: body.label || proposed.proposal.label,
            background: { ...proposed.proposal.background, sourceFile: ownResume, resumeFingerprint: proposed.resumeFingerprint ?? '' },
          });
          // Saving is not activating: a new profile never takes over the search
          // without a second, deliberate action.
          const viewedDb = db;
          if (body.activate === true) {
            const summary = activateProfile(root, saved.id);
            const warning = reloadConfig();
            const workspaceChanged = useActiveWorkspace();
            const seed = body.seed === true ? seedNewPerson(root, saved.id, viewedDb) : { seeded: 0 };
            if (!warning) scheduleRescore();
            return sendJson(res, 200, { choice, changed: true, ...saved, activated: summary, warning, workspaceChanged, seeded: seed.seeded });
          }
          return sendJson(res, 200, { choice, changed: true, ...saved, activated: null });
        }
        if (choice === 'merge') {
          const merged = mergeIntoActiveProfile(root, {
            roles: Array.isArray(body.roles) ? body.roles : [],
            skills: Array.isArray(body.skills) ? body.skills : [],
            industries: Array.isArray(body.industries) ? body.industries : [],
          });
          const summary = activateProfile(root, merged.id);
          const warning = reloadConfig();
          if (!warning) scheduleRescore();
          return sendJson(res, 200, { choice, changed: true, ...merged, activated: summary, warning });
        }
        throw new Error('choice must be one of: create, keep, merge');
      });
    }

    // ── Application profile ────────────────────────────────────────────────
    // The values the form filler types, the answers it draws on, and the
    // questions it could not answer. Editing them here replaces hand-editing
    // two JSON files, and every write is validated before it reaches disk.
    if (req.method === 'GET' && path === '/api/profile') {
      return sendJson(res, 200, profileState());
    }
    if (req.method === 'POST' && path === '/api/profile') {
      const body = await readBody(req);
      return saving(res, () => {
        const root = requireConfigRoot();
        if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) {
          throw new Error('send { values: { "<field path>": "<value>" } }');
        }
        const saved = writeProfile(root, body.values);
        return sendJson(res, 200, { ...saved, warning: reloadConfig(), profile: readProfile(root) });
      });
    }
    if (req.method === 'POST' && path === '/api/profile/adopt') {
      const body = await readBody(req);
      const titles = Array.isArray(body.titles) ? body.titles.slice(0, 40) : [];
      const skills = Array.isArray(body.skills) ? body.skills.slice(0, 200) : [];
      if (!titles.length && !skills.length) {
        return sendJson(res, 400, { error: 'nothing was selected to adopt' });
      }
      if (runState.running) {
        return sendJson(res, 409, { error: `a ${runState.phase} run is in progress — try again when it finishes` });
      }
      return saving(res, () => {
        const result = adoptResumeEvidence(requireConfigRoot(), { titles, skills });
        // targetTitles drives every query-first source and Workday's derived
        // phrases, so the in-memory config must not keep serving the old list —
        // and verdicts judged against the old titles are re-scored.
        const warning = reloadConfig();
        if (!warning) scheduleRescore();
        return sendJson(res, 200, { ...result, warning, suggestions: resumeSuggestions() });
      });
    }
    if (req.method === 'POST' && path === '/api/profile/answers') {
      const body = await readBody(req);
      return saving(res, () => {
        const root = requireConfigRoot();
        const saved = writeScreeningAnswers(root, {
          defaults: body.defaults ?? {},
          answers: Array.isArray(body.answers) ? body.answers : [],
        });
        return sendJson(res, 200, { ...saved, warning: reloadConfig(), screening: readScreeningAnswers(root) });
      });
    }
    if (req.method === 'POST' && path === '/api/profile/questions/answer') {
      const body = await readBody(req);
      return saving(res, () => {
        const root = requireConfigRoot();
        // The original question travels with the answer so the truthfulness
        // check can see the POLARITY of what is being answered, not just the
        // text of the answer. That is the only way an affirmative reply to a
        // reversed sponsorship question can be caught.
        const saved = upsertScreeningAnswer(root, {
          id: body.id,
          patterns: Array.isArray(body.patterns) ? body.patterns : [],
          answer: body.answer,
          type: body.type,
        }, { question: body.question, replace: body.replace === true });
        if (body.key) markQuestionAnswered(root, String(body.key), { answerId: saved.id, now: nowDate() });
        return sendJson(res, 200, { ...saved, warning: reloadConfig(), ...profileState() });
      });
    }
    if (req.method === 'POST' && path === '/api/profile/questions/status') {
      const body = await readBody(req);
      return saving(res, () => {
        const root = requireConfigRoot();
        const key = String(body.key ?? '');
        if (!key) throw new Error('which question? send its key');
        const outcome = body.status === 'open'
          ? reopenQuestion(root, key)
          : dismissQuestion(root, key, { now: nowDate() });
        if (!outcome.ok) throw new Error(outcome.reason);
        return sendJson(res, 200, profileState());
      });
    }
    if (req.method === 'GET' && path === '/api/data-quality') {
      return sendJson(res, 200, dataQualitySummary(db, config, { now: nowDate(), enrichmentState: enrichmentStatus() }));
    }
    if (req.method === 'GET' && path === '/api/enrichment') {
      return sendJson(res, 200, enrichmentStatus());
    }
    if (req.method === 'POST' && path === '/api/enrichment/start') {
      await readBody(req);
      const out = startEnrichmentPass('manual');
      return sendJson(res, out.started ? 202 : 409, out.started ? enrichmentStatus() : { error: out.reason });
    }
    if (req.method === 'POST' && path === '/api/enrichment/stop') {
      await readBody(req);
      enrichment.controller?.abort();
      return sendJson(res, 200, enrichmentStatus());
    }
    if (req.method === 'POST' && path === '/api/settings') {
      const body = await readBody(req);
      if (!config?.root) return sendJson(res, 400, { error: 'settings need a project root' });
      const before = freshnessSummary(config);
      let settings;
      try {
        settings = writeUserSettings(config.root, body);
      } catch (err) {
        return sendJson(res, err.statusCode ?? 500, { error: sanitizeErrorMessage(err.message) });
      }
      const warning = reloadConfig();
      const after = freshnessSummary(config);
      // A new window or retention changes verdicts already on the board; the
      // same deferred re-judge a profile switch uses applies them.
      if (before.discoveryWindow !== after.discoveryWindow || before.retentionDays !== after.retentionDays) {
        scheduleRescore();
      }
      return sendJson(res, 200, { settings, warning, freshness: after, enrichment: enrichmentStatus() });
    }
    if (path === '/api/postings/sweep' && req.method === 'GET') {
      const { running, last, startedAt, finishedAt } = postingSweep;
      return sendJson(res, 200, { running, last, startedAt, finishedAt });
    }
    if (path === '/api/postings/sweep' && req.method === 'POST') {
      const body = await readBody(req);
      if (postingSweep.running) return sendJson(res, 409, { error: 'a posting check is already running' });
      if (runState.running) return sendJson(res, 409, { error: `a ${runState.phase} run is in progress — try again when it finishes` });
      const limit = Math.max(1, Math.min(2000, Number(body?.limit) || 300));
      // Re-check everything asked for, not just what is a day old.
      track(runPostingSweep({ limit, maxAgeHours: Number(body?.maxAgeHours ?? 1) }));
      return sendJson(res, 202, { started: true, limit });
    }
    if (req.method === 'GET' && path === '/api/health') {
      // Full doctor pass (config, resume, python, browsers, dirs) — the
      // Settings page's system-health panel. Doctor spawns Python etc., so it
      // runs on demand only, never on the landing path.
      return sendJson(res, 200, await healthReport());
    }
    if (req.method === 'GET' && path === '/api/export/jobs.csv') {
      const csv = exportRowsToCsv(buildExportRows(db, { now: nowDate() }));
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="jobagent_jobs.csv"',
      });
      res.end(csv);
      return;
    }
    if (req.method === 'GET' && path === '/api/export/tracker.csv') {
      const root = config?.root;
      if (!root) return sendJson(res, 400, { error: 'no project root configured for export' });
      // Explicit download: flush any pending debounced write, then rewrite
      // synchronously so the bytes the user gets are never stale.
      flushTracker();
      const writeImpl = deps.writeJobTrackerImpl ?? writeJobTracker;
      const { path: csvPath } = writeImpl(db, root);
      const csv = (deps.readTextImpl ?? ((p) => readFileSync(p, 'utf8')))(csvPath);
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="job_tracker.csv"',
      });
      res.end(csv);
      return;
    }
    if (req.method === 'POST' && path === '/api/run') {
      const body = await readBody(req);
      if (!RUN_PHASES.has(body.phase)) {
        return sendJson(res, 400, { error: `phase must be one of: ${[...RUN_PHASES].join(', ')}` });
      }
      return sendJson(res, 202, await startRun(body.phase));
    }
    if (req.method === 'POST' && path === '/api/auto-apply/eligibility') {
      const body = await readBody(req);
      const ids = batchJobIds(body.jobIds);
      if (ids.length === 0) return sendJson(res, 400, { error: 'select at least one job to preview' });
      return sendJson(res, 200, autoApplyEligibility(ids, body.autoSubmit === true));
    }
    if (req.method === 'POST' && path === '/api/assist-batch') {
      const body = await readBody(req);
      // "Assist" and the UI's "Auto-apply" always mean prepare + approve +
      // fill for review. A stray/legacy autoSubmit boolean must never turn this
      // ordinary action into a final submission.
      return sendJson(res, 202, startAssistBatch(body.jobIds, { autoSubmit: false }));
    }
    if (req.method === 'POST' && path === '/api/auto-submit-batch') {
      const body = await readBody(req);
      if (body.confirmed !== true) {
        return sendJson(res, 400, {
          error: 'auto-submit requires confirmed:true for this specific run',
        });
      }
      return sendJson(res, 202, startAssistBatch(body.jobIds, { autoSubmit: true }));
    }
    if (req.method === 'POST' && path === '/api/approve-batch') {
      const body = await readBody(req);
      const ids = batchJobIds(body.jobIds);
      const approved = [];
      const failed = [];
      for (const jobId of ids) {
        try { approveJobPacket(db, jobId); approved.push(jobId); }
        catch (err) { failed.push({ jobId, error: err.message }); }
      }
      refreshTracker();
      return sendJson(res, 200, { approved, failed });
    }
    if (req.method === 'POST' && path === '/api/prepare-batch') {
      const body = await readBody(req);
      const ids = batchJobIds(body.jobIds);
      if (ids.length === 0) return sendJson(res, 400, { error: 'select at least one job to prepare' });
      if (runState.running) {
        return sendJson(res, 409, { error: `busy: ${runState.phase} is in progress` });
      }
      const prepareLock = takeRunLock('prepare-selected');
      // Reset the FULL run state, including runId/rca/progress. Leaving the
       // previous run's `progress` in place made the header report stale
       // counters (e.g. "prepare-selected (3) running… 13/13").
      Object.assign(runState, {
        running: true, phase: `prepare-selected (${ids.length})`,
        startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
        cancelRequested: false, runId: randomUUID(), rca: [], partial: false,
        progress: {
          total: ids.length, completed: 0, currentJobId: null,
          items: ids.map((jobId) => ({ jobId, status: 'queued' })),
        },
      });
      track((async () => {
        try {
          const prepareImpl = deps.prepareForJobsFn ?? preparePacketsForJobs;
          const r = await prepareImpl({
            config, db, logger, jobIds: ids,
            deps: { ...deps, shouldCancel: () => runState.cancelRequested },
          });
          refreshTracker();
          // Mirror the outcome onto the progress items so the UI can show which
          // specific jobs were prepared and which failed.
          if (runState.progress?.items) {
            const failedById = new Map((r.failed ?? []).map((f) => [f.jobId, f.error]));
            for (const item of runState.progress.items) {
              const failure = failedById.get(item.jobId);
              Object.assign(item, failure
                ? { status: 'failed', error: failure }
                : { status: 'prepared' });
            }
            runState.progress.completed = runState.progress.items.length;
          }
          runState.lastResult = {
            phase: 'prepare-selected',
            counters: { jobs_prepared: r.prepared.length },
            prepared: r.prepared, failed: r.failed,
          };
        } catch (err) {
          runState.lastError = `prepare-selected failed: ${err.message}`;
        } finally {
          runState.running = false;
          runState.finishedAt = new Date().toISOString();
          prepareLock.release();
        }
      })());
      return sendJson(res, 202, { started: true, queued: ids.length });
    }
    if (req.method === 'POST' && path === '/api/decide-batch') {
      const body = await readBody(req);
      const ids = batchJobIds(body.jobIds);
      const updated = [];
      const failed = [];
      for (const jobId of ids) {
        try { applyDecision(db, jobId, body.decision, { reason: body.reason ?? null }); updated.push(jobId); }
        catch (err) { failed.push({ jobId, error: err.message }); }
      }
      refreshTracker();
      return sendJson(res, 200, { updated, failed, decision: body.decision });
    }
    if (req.method === 'POST' && path === '/api/add-url') {
      const body = await readBody(req);
      const ingestImpl = deps.ingestUrlFn ?? ingestUrl;
      const result = await ingestImpl({ config, db, logger, url: body.url, deps });
      refreshTracker();
      return sendJson(res, 200, result);
    }

    const resumeMatch = path.match(/^\/api\/jobs\/([^/]+)\/resume$/);
    if (req.method === 'GET' && resumeMatch) {
      const jobId = decodeURIComponent(resumeMatch[1]);
      const requested = url.searchParams.get('format') ?? 'auto';
      if (!['auto', 'pdf', 'docx'].includes(requested)) {
        return sendJson(res, 400, { error: 'resume format must be auto, pdf, or docx' });
      }
      const artifact = readResumePreview(jobId, requested);
      // The PDF is intentionally embeddable only by this same-origin local
      // dashboard. DOCX remains a download because browsers cannot render it.
      res.setHeader('x-frame-options', artifact.inline ? 'SAMEORIGIN' : 'DENY');
      res.setHeader('content-security-policy', artifact.inline
        ? "default-src 'none'; frame-ancestors 'self'"
        : "default-src 'none'; frame-ancestors 'none'");
      res.writeHead(200, {
        'content-type': artifact.type,
        'content-length': artifact.bytes.length,
        'content-disposition': `${artifact.inline ? 'inline' : 'attachment'}; filename="${artifact.name.replace(/["\r\n]/g, '_')}"`,
      });
      res.end(artifact.bytes);
      return;
    }

    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(?:\/([a-z-]+))?$/);
    if (jobMatch) {
      const [, jobId, action] = jobMatch.map((s) => (s ? decodeURIComponent(s) : s));
      if (req.method === 'GET' && !action) {
        const detail = jobDetail(db, jobId, { ...deps, root: config?.root ?? null, config, now: nowDate() });
        if (!detail) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
        return sendJson(res, 200, detail);
      }
      if (req.method === 'POST' && action === 'resume-preview') {
        const result = await materializeResumePreview(jobId);
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'check-link') {
        const job = db.getJob?.(jobId);
        if (!job) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
        if (!isSafeObservedApplicationUrl(job.url)) {
          return sendJson(res, 400, { error: 'job URL must be a non-local HTTP(S) address' });
        }
        const checker = deps.checkLinkFn ?? checkJobLink;
        const result = await checker(job.url, { ...deps, job: { id: job.id, url: job.url, source: job.source } });
        // A definitive answer from the ATS is recorded; a closed posting nobody
        // acted on leaves the board (discarded, "expired: …"), as the sweep does.
        let retired = false;
        const state = result?.liveness?.state;
        if (state === 'open' || state === 'closed') {
          try {
            retired = db.recordPostingCheck?.(jobId, { state, via: result.liveness.via })?.retired === true;
            noteUserMutation();
          } catch { /* the check result is still worth returning */ }
        }
        return sendJson(res, 200, { ...result, retired });
      }
      if (req.method === 'POST' && action === 'link') {
        const job = db.getJob?.(jobId);
        if (!job) return sendJson(res, 404, { error: `unknown job id: ${jobId}` });
        const body = await readBody(req);
        const replacement = String(body.url ?? '').trim();
        if (!isSafeObservedApplicationUrl(replacement)) {
          return sendJson(res, 400, { error: 'replacement must be a non-local HTTP(S) job URL' });
        }
        if (isAggregatorUrl(replacement)) {
          return sendJson(res, 400, { error: 'use the direct employer/ATS application URL, not another aggregator link' });
        }
        db.upsertJob({ id: jobId, url: replacement });
        refreshTracker();
        return sendJson(res, 200, { updated: true, jobId, url: replacement });
      }
      if (req.method === 'POST' && action === 'decision') {
        const body = await readBody(req);
        // Optional `reason` (DECISION_REASONS) + `reasonNote` (<= 200 chars).
        const result = applyDecision(db, jobId, body.decision, { reason: body.reason ?? null, reasonNote: body.reasonNote ?? null });
        refreshTracker();
        return sendJson(res, 200, result);
      }
      // Revert the most recent decision on ONE job, restoring the exact
      // decision and reason it replaced (409 when there is nothing to undo).
      if (req.method === 'POST' && action === 'undo-decision') {
        await readBody(req);
        const result = undoDecision(db, jobId);
        refreshTracker();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'approve') {
        const result = approveJobPacket(db, jobId);
        refreshTracker();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'reject-packet') {
        const result = rejectJobPacket(db, jobId);
        refreshTracker();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'mark-submitted') {
        const body = await readBody(req);
        const result = markSubmittedByHuman(db, jobId, {
          now: nowDate(),
          confirmationNumber: body.confirmationNumber,
          verified: body.verified === true,
          note: body.note,
        });
        // Keep the privacy-minimized resumable checkpoint aligned when one
        // exists. Legacy jobs without a checkpoint remain valid DB records.
        try {
          const approval = db.getApprovalByJob?.(jobId);
          const packet = approval
            ? (deps.loadPacketImpl ? deps.loadPacketImpl(approval) : loadPacket(approval))
            : null;
          if (packet && config?.root) {
            const evidence = [body.confirmationNumber, body.note].filter(Boolean);
            await markApplicationUserSubmitted({ root: config.root, packet, evidence });
            if (result.verified) {
              await markApplicationVerified({ root: config.root, packet, evidence: evidence.length ? evidence : ['human confirmed submission evidence'] });
            }
          }
        } catch (err) {
          logger?.warn?.(`application-state submission sync skipped for ${jobId}: ${sanitizeErrorMessage(err.message)}`);
        }
        refreshTracker();
        return sendJson(res, 200, result);
      }
      // Recruiting outcomes and follow-ups on a SUBMITTED application. Each is
      // validated and appended as an event; none changes the job's status,
      // submission or decision, and none approves or submits anything.
      if (req.method === 'POST' && action === 'outcome') {
        const body = await readBody(req);
        return sendJson(res, 200, recordOutcome(db, jobId, {
          outcome: body.outcome, on: body.on ?? null, note: body.note ?? null, now: nowDate(), config,
        }));
      }
      if (req.method === 'POST' && action === 'undo-outcome') {
        await readBody(req);
        return sendJson(res, 200, undoOutcome(db, jobId, { now: nowDate(), config }));
      }
      if (req.method === 'POST' && action === 'follow-up') {
        const body = await readBody(req);
        return sendJson(res, 200, updateFollowUp(db, jobId, {
          action: body.action, dueOn: body.dueOn ?? null, note: body.note ?? null, now: nowDate(), config,
        }));
      }
      if (req.method === 'POST' && action === 'note') {
        const body = await readBody(req);
        const result = setJobNote(db, jobId, body.note);
        // Notes travel in the tracker CSV; the refresh is debounced (400 ms).
        refreshTracker();
        return sendJson(res, 200, result);
      }
      if (req.method === 'POST' && action === 'assist') {
        return sendJson(res, 202, await startAssist(jobId));
      }
      if (req.method === 'GET' && action === 'eligibility') {
        return sendJson(res, 200, autoApplyEligibility(
          [jobId], url.searchParams.get('autoSubmit') === 'true',
        ).items[0]);
      }
      // One-click end-to-end: prepare (if needed) -> approve -> fill for human
      // review. This named action NEVER clicks the final Submit button.
      if (req.method === 'POST' && action === 'auto-apply') {
        await readBody(req); // consume/validate any legacy JSON body
        return sendJson(res, 202, startAssistBatch([jobId], { autoSubmit: false }));
      }
    }

    sendJson(res, 404, { error: `no route: ${req.method} ${path}` });
  }

  schedulePostingSweeps();
  scheduleRetentionSweeps();
  scheduleEnrichment();
  reconcilePackets();

  return {
    server, runState, inFlight, flushTracker, browserAvailableCached, closeWorkspaceDbs,
    // The LIVE bundle, not the one booted with: routes that rewrite config
    // files reload it into this closure, and `startDashboard` cannot see that
    // from its own immutable parameter.
    currentConfig: () => config,
  };
}

/**
 * Start the dashboard on 127.0.0.1.
 *
 * @param {object} args createDashboardServer args + { port }
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, close: Function }>}
 */
export function startDashboard({ config, db, logger, port = 4646, deps = {} } = {}) {
  const {
    server, runState, inFlight, flushTracker, currentConfig, browserAvailableCached, closeWorkspaceDbs,
  } = createDashboardServer({ config, db, logger, deps });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is already in use, another dashboard is probably running. `
          + `Open http://127.0.0.1:${port} in your browser, or close the other process `
          + `(or start this one with a different port).`));
        return;
      }
      reject(err);
    });
    // 127.0.0.1 only — the dashboard must never be reachable from the network.
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      // Learn the browser's real state once at boot so the first page's labels
      // are right; afterwards /api/today refreshes it at most once a minute.
      browserAvailableCached().catch(() => {});
      resolve({
        server,
        runState,
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        /**
         * The config bundle the server is CURRENTLY serving.
         *
         * Not a convenience: several routes rewrite config files on disk and
         * then reload them into the request handler's closure, and "did the
         * live bundle actually follow?" is a different question from "is the
         * file on disk right?". Activating a search profile is the case that
         * matters — if the reload silently fails, every subsequent run keeps
         * using the previous candidate's titles until the process restarts,
         * which is the exact silent staleness the profile model exists to end.
         *
         * It must come from `createDashboardServer`, which owns the mutable
         * binding. `startDashboard`'s own `config` parameter is the BOOT value
         * and never changes, so reading it here would have reported a stale
         * answer forever while looking correct.
         */
        currentConfig,
        close: async () => {
          runState.cancelRequested = true;
          await new Promise((r) => server.close(r));
          await Promise.allSettled([...inFlight]);
          // Write out any tracker refresh still sitting in the debounce window
          // so shutting down never loses the last action's CSV update.
          try { flushTracker(); } catch { /* best effort on shutdown */ }
          closeWorkspaceDbs();
        },
      });
    });
  });
}

/**
 * Keep the long-lived dashboard process alive when detached background work
 * throws. The dashboard fires browser automation as fire-and-forget jobs and
 * leaves a real browser open for the human to review; if the user closes that
 * window (or Playwright's transport errors), the resulting unhandled rejection
 * would otherwise terminate the whole server and every later request would fail
 * with the browser's generic "Failed to fetch". This records the error on
 * `runState.lastError` (so the UI surfaces it) and keeps serving; an uncaught
 * EXCEPTION is logged and exits(1) (see onException). Process
 * signals (SIGINT/SIGTERM) are deliberately NOT intercepted. Returns an
 * uninstall function so tests never leak global handlers.
 *
 * @param {object} args
 * @param {object} [args.runState] shared run state to annotate
 * @param {object} [args.logger]
 * @param {NodeJS.EventEmitter} [args.proc=process]
 * @returns {() => void} uninstall the handlers
 */
export function installProcessSafetyNet({ runState, logger, proc = process, exit = null } = {}) {
  const record = (kind) => (reason) => {
    const msg = reason?.message ?? String(reason);
    logger?.error?.(`dashboard survived an ${kind}: ${msg}`);
    if (runState) runState.lastError = `background error (server still up): ${msg}`;
  };
  const onRejection = record('unhandled rejection');
  /*
   * An uncaught EXCEPTION is different: Node's own documentation is explicit
   * that the process is in an undefined state afterwards (a half-run
   * synchronous handler, a stream mid-write, a transaction left open on the
   * SQLite handle). Carrying on served requests from that state. It is logged,
   * then the process exits non-zero so the launcher / user restarts it clean.
   * A rejected promise is recoverable, and keeps the old survive-and-report
   * behaviour above.
   */
  const onException = (err) => {
    const msg = err?.message ?? String(err);
    try { logger?.error?.(`dashboard stopping after an uncaught exception: ${msg}`); } catch { /* logging must not block exit */ }
    try { console.error(`[dashboard] uncaught exception — exiting: ${err?.stack ?? msg}`); } catch { /* ignore */ }
    (exit ?? ((code) => proc.exit?.(code)))(1);
  };
  proc.on('unhandledRejection', onRejection);
  proc.on('uncaughtException', onException);
  return () => {
    proc.off?.('unhandledRejection', onRejection);
    proc.off?.('uncaughtException', onException);
  };
}

/* ------------------------------- helpers --------------------------------- */

/** Hostnames that mean "this machine's browser talking to its own dashboard". */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Is this Host header a loopback host (any port)? A missing Host is allowed —
 * only ancient non-browser clients omit it, and the socket is loopback-bound.
 * @param {string|undefined} host
 */
export function isLoopbackHost(host) {
  if (!host) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Is this Origin header acceptable for a state-changing request? Absent means
 * a same-origin/non-browser client (fetch/curl); "null" is an opaque origin
 * (sandboxed iframe, file://) and is rejected like any foreign site.
 * @param {string|undefined} origin
 */
export function isAllowedOrigin(origin, port) {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return false;
  try {
    const url = new URL(origin);
    if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return false;
    // Loopback is not one origin: a dev server or another local app on
    // 127.0.0.1:3000 is a different site, and its "simple" text/plain POST
    // reaches us without a CORS preflight. When the caller knows our port,
    // only a page served from THIS dashboard may change state.
    if (port === undefined) return true;
    const originPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return originPort === String(port);
  } catch {
    return false;
  }
}

/**
 * Is this state-changing request one a foreign page could not have forged?
 * JSON bodies and the custom `X-Job-Agent: 1` header both require a CORS
 * preflight; see the CSRF note in route().
 * @param {import('node:http').IncomingMessage} req
 */
export function isTrustedMutation(req) {
  if (String(req.headers['x-job-agent'] ?? '') === '1') return true;
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

/** JSON bodies at least this large are gzipped when the client accepts it. */
const GZIP_MIN_BYTES = 64 * 1024;

/** Does the request that produced `res` accept gzip? */
function acceptsGzip(res) {
  return /\bgzip\b/i.test(String(res.req?.headers?.['accept-encoding'] ?? ''));
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  // Measured live: a default 100-row board page is ~210 KB and the full stats
  // payload is larger; gzip cuts JSON like this ~8x for a few ms of CPU.
  if (text.length >= GZIP_MIN_BYTES && acceptsGzip(res)) {
    const zipped = gzipSync(text);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      vary: 'Accept-Encoding',
      'content-length': zipped.length,
    });
    res.end(zipped);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function setExtensionCors(res, origin) {
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, x-job-agent-key');
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'Origin');
}

function isAggregatorUrl(value) {
  try {
    return /(^|\.)(linkedin|indeed|glassdoor|dice|ziprecruiter)\./i.test(new URL(value).hostname);
  } catch { return false; }
}

/**
 * A URL is only an application URL if it is a PUBLIC http(s) address. Delegates
 * to the shared guard so this endpoint, the link-replacement endpoint, and
 * add-url all reject the same things (loopback, RFC-1918, link-local/metadata,
 * internal hostnames, embedded credentials).
 */
function isSafeObservedApplicationUrl(value) {
  return isPublicHttpUrl(value);
}

function batchJobIds(value) {
  const ids = Array.isArray(value)
    ? [...new Set(value.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
    : [];
  if (ids.length > MAX_BATCH_JOBS) {
    throw Object.assign(new Error(`batch is limited to ${MAX_BATCH_JOBS} jobs`), { statusCode: 400 });
  }
  return ids;
}

/** Defense-in-depth headers for every page, API response, and static asset. */
function setSecurityHeaders(res) {
  res.setHeader('content-security-policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "object-src 'none'",
    // The SPA now loads from /assets/js/app.js and uses delegated listeners
    // instead of inline on* handlers, so inline SCRIPT is no longer permitted
    // at all — an injected <script> or handler cannot execute.
    "script-src 'self'",
    // Inline STYLE is still required: progress/meter widths are set as style
    // attributes from data (element.style.width), which style-src governs.
    "style-src 'self' 'unsafe-inline'",
  ].join('; '));
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('cache-control', 'no-store');
}

/** Minimal MIME map for the bundled SPA assets. */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/**
 * Serve a static file from PUBLIC_DIR. Defends against path traversal by
 * resolving the request and rejecting anything that escapes PUBLIC_DIR
 * (OWASP A01/A03). Returns 404 for missing files, 403 for escapes.
 *
 * Assets revalidate instead of re-downloading: each carries an ETag built from
 * its size and mtime, and `no-cache` (not `no-store`) lets the browser answer
 * a reload with a 304 when nothing changed. An edited file gets a new ETag, so
 * a stale script can never be served.
 *
 * @param {import('node:http').ServerResponse} res
 * @param {string} urlPath request pathname (e.g. "/assets/js/app.js")
 * @param {string} [ifNoneMatch] the request's If-None-Match header
 */
function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); }
  catch { return sendJson(res, 400, { error: 'malformed URL escape in the request path' }); }
  // A NUL byte reached statSync and surfaced as a 500.
  if (rel.includes('\0')) return sendJson(res, 400, { error: 'invalid character in the request path' });
  const abs = normalize(join(PUBLIC_DIR, rel));
  // Same containment helper as the artifact reads, so both use the platform's
  // real path semantics rather than raw string prefixes.
  if (!isInsideDirectory(PUBLIC_DIR, abs)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  let asset;
  try {
    asset = cachedAsset(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'ENOTDIR') {
      return sendJson(res, 404, { error: `not found: ${urlPath}` });
    }
    throw err;
  }
  // `no-cache` = "revalidate every time", NOT "do not store": the browser
  // keeps the bytes and asks with If-None-Match, and an unchanged asset costs
  // a 304 with no body. The API keeps `no-store` (set in setSecurityHeaders).
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('etag', asset.etag);
  if (String(req.headers['if-none-match'] ?? '') === asset.etag) {
    res.writeHead(304);
    res.end();
    return;
  }
  const gzip = asset.gzip && acceptsGzip(res);
  const bytes = gzip ? asset.gzip : asset.bytes;
  res.writeHead(200, {
    'content-type': asset.type,
    'content-length': bytes.length,
    ...(asset.gzip ? { vary: 'Accept-Encoding' } : {}),
    ...(gzip ? { 'content-encoding': 'gzip' } : {}),
  });
  // HEAD: identical headers, no body.
  res.end(req.method === 'HEAD' ? undefined : bytes);
}

/** Text asset types worth gzipping. */
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg\+xml)/;

/**
 * In-memory static cache keyed by path, validated by mtime + size.
 *
 * serveStatic used to readFileSync every asset on every request — app.js is
 * ~200 KB and the page loads it on every reload. A stat is ~20x cheaper than a
 * read, and still picks up an edited file immediately (Node does not
 * hot-reload the server, but the assets are served from disk precisely so a
 * reload shows new front-end code).
 * @type {Map<string, {mtimeMs: number, size: number, bytes: Buffer, gzip: Buffer|null, etag: string, type: string}>}
 */
const STATIC_CACHE = new Map();

function cachedAsset(abs) {
  const st = statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error('not a file'), { code: 'EISDIR' });
  const hit = STATIC_CACHE.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const bytes = readFileSync(abs);
  const type = MIME_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  const etag = `"${createHash('sha1').update(bytes).digest('base64url')}"`;
  const gzip = COMPRESSIBLE.test(type) && bytes.length > 1024 ? gzipSync(bytes) : null;
  const entry = { mtimeMs: st.mtimeMs, size: st.size, bytes, gzip, etag, type };
  STATIC_CACHE.set(abs, entry);
  return entry;
}

/**
 * Read and parse a JSON request body (empty body -> {}).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes=1e6] cap for this route. Only the master-resume
 *   upload raises it; every other endpoint keeps the small default so a stray
 *   local request cannot make the dashboard buffer megabytes.
 */
/**
 * A resume sent as base64 JSON ({ contentBase64 }) -> its bytes, or a 400.
 * Same checks as the master-resume upload: strict base64 (Buffer.from would
 * silently drop bad characters), the size cap, and a real .docx.
 */
function decodeResumeUpload(body = {}) {
  const encoded = String(body.contentBase64 ?? '');
  const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
  if (!encoded) fail('no file contents were received');
  if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(encoded)) fail('the file contents were not transferred correctly, try again');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_MASTER_RESUME_BYTES) fail(`that file is over ${Math.round(MAX_MASTER_RESUME_BYTES / 1024 / 1024)} MB`, 413);
  if (!isDocxBuffer(bytes)) fail('that is not a Word (.docx) file — save it as .docx and try again');
  return bytes;
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    let chunks = [];
    let size = 0;
    let tooLarge = false;
    const fail = (message, statusCode) => reject(Object.assign(new Error(message), { statusCode }));
    req.on('data', (chunk) => {
      if (tooLarge) {
        // Keep DRAINING an over-sized body instead of destroying the socket.
        // Killing it here meant the browser reported a generic network failure
        // and never saw the 413 that explains what to do about it.
        size += chunk.length;
        // A client that keeps streaming far past the limit is not a mistake.
        if (size > maxBytes * 4) req.destroy();
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks = []; // release what was buffered
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      if (tooLarge) return fail('body too large', 413);
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data.trim()) return resolve({});
      let parsed;
      try { parsed = JSON.parse(data); }
      catch { return fail('invalid JSON body', 400); }
      // Every route reads fields off the body; a bare `null` or `42` would
      // surface as a TypeError (500) instead of a clear 400.
      if (parsed === null || typeof parsed !== 'object') return fail('JSON body must be an object', 400);
      resolve(parsed);
    });
    req.on('error', (err) => reject(err));
    req.on('aborted', () => fail('the request was interrupted before it finished', 400));
  });
}
