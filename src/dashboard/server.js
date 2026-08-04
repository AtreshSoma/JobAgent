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
 *   POST /api/master-resume/restore       roll back to a kept previous version
 *   POST /api/jobs/:id/check-link         classify current URL availability
 *   POST /api/jobs/:id/link {url}         replace stale URL with a direct job URL
 *   POST /api/jobs/:id/decision {decision} shortlist | rejected | archived | clear
 *   POST /api/jobs/:id/approve            approve prepared packet (human gate)
 *   POST /api/jobs/:id/reject-packet      reject prepared packet
 *   POST /api/jobs/:id/mark-submitted     record YOUR manual submission
 *   POST /api/jobs/:id/assist             fill the approved packet, stop before submit
 *   POST /api/run {phase}                 discover | score | prepare (async)
 *   POST /api/run/cancel                  stop a running batch between jobs
 *   GET  /api/run/status                  current/last run state
 *   GET  /api/sections                    curated command-center sections
 *   POST /api/jobs/:id/note {note}        save a free-text note on a job
 *   POST /api/decide-batch {jobIds,decision}  bulk shortlist/reject/archive
 *   POST /api/add-url {url}               ingest one public job URL (score + track)
 *   POST /api/auto-submit-batch            explicit advanced final-submit path
 *   GET  /api/export/jobs.csv             rich CSV of every job + score/status
 */

import { createServer } from 'node:http';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import {
  join, dirname, normalize, extname, isAbsolute, resolve, basename,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureResumePdf } from '../resume/pdfPreview.js';
import { checkJobLink } from './linkHealth.js';

import { buildRca, sanitizeErrorMessage } from '../utils/failureRca.js';
import { isPublicHttpUrl } from '../utils/publicUrl.js';
import { assertInsideDirectory, isInsideDirectory } from '../utils/pathSafe.js';

import {
  dashboardStats, boardPage, jobDetail, applyDecision,
  approveJobPacket, rejectJobPacket, markSubmittedByHuman,
  dashboardSections, setJobNote, buildExportRows, exportRowsToCsv, buildReports,
  buildDocuments, buildMasterResume, MASTER_RESUME_RELATIVE, MASTER_HISTORY_RELATIVE,
} from './data.js';
import { extractDocxText, isDocxBuffer } from '../resume/docxText.js';
import {
  runScore, runRescore, runPrepareApps, loadPacket, recordAssistResult,
  preparePacketsForJobs, ingestUrl,
} from '../cli/commands.js';
import { assistApply } from '../automation/applyRunner.js';
import { evaluateAutoApplyBatch } from '../apply/autoApplyEligibility.js';
import { markApplicationUserSubmitted, markApplicationVerified } from '../apply/applicationState.js';
import { APPROVAL_STATUS } from '../apply/approvalQueue.js';
import { LIFECYCLE } from '../lifecycle.js';
import { writeJobTracker } from '../reports/jobTracker.js';
import {
  buildExtensionPayload, isChromiumExtensionOrigin, readApprovedArtifact,
  validExtensionKey,
} from '../extension/companion.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

/** Phases the dashboard may trigger. Submission is intentionally absent. */
const RUN_PHASES = new Set(['discover', 'score', 'prepare']);

/** Most RCA rows to keep after collapsing — a panel, not a log file. */
const MAX_RCA_ENTRIES = 25;

/** Bound user-triggered batches so one local request cannot monopolize the UI. */
const MAX_BATCH_JOBS = 200;

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
    const key = `${e.source ?? ''}|${e.operation ?? ''}|${e.category}|${e.status ?? ''}|${e.degraded ? 'd' : 'f'}`;
    const seen = merged.get(key);
    if (!seen) {
      merged.set(key, { ...e });
      continue;
    }
    seen.count += e.count ?? 1;
    seen.retryCount = Math.max(seen.retryCount, e.retryCount ?? 0);
    // Keep the first message as the representative sample; the count carries
    // the rest. Recompute the impact so it reflects the folded total.
    seen.impact = buildRca({
      operation: seen.operation,
      source: seen.source,
      error: seen.message,
      status: seen.status ?? undefined,
      degraded: seen.degraded,
      count: seen.count,
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
export function createDashboardServer({ config, db, logger, deps = {} } = {}) {
  const extensionKey = deps.extensionKey ?? process.env.JOB_AGENT_EXTENSION_KEY ?? '';
  const runners = {
    // "Find New Jobs" must leave jobs ON THE BOARD. The bare discover phase
    // only writes data/found_jobs.json — never the SQLite DB the board reads —
    // so the button appeared to do nothing (header stuck at "0 found in last
    // 24h" no matter how many jobs the run found). Route it through the
    // scoring pipeline, which discovers, scores, AND persists in one pass.
    discover: deps.discoverFn ?? ((runDeps = {}) => runScore({ config, db, logger, deps: { ...deps, ...runDeps } })),
    // "Re-score" recomputes fit for jobs ALREADY on the board from their stored
    // JDs — no network, no re-discovery. (It used to silently re-run the full
    // discovery pipeline, which is what the Find button is for.)
    score: deps.scoreFn ?? ((runDeps = {}) => runRescore({ config, db, logger, deps: { ...deps, ...runDeps } })),
    prepare: deps.prepareFn ?? ((runDeps = {}) => runPrepareApps({ config, db, logger, deps: { ...deps, ...runDeps } })),
  };
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
    promise.finally(() => inFlight.delete(promise));
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
    if (isSubmittedOrUnverified(live)) return 'submitted while the batch was running — skipped';
    if (live.user_decision === 'rejected' || live.user_decision === 'archived') {
      return `you ${live.user_decision} it while the batch was running — skipped`;
    }
    const liveApproval = db.getApprovalByJob?.(jobId);
    if (liveApproval && liveApproval.approval_status !== APPROVAL_STATUS.APPROVED) {
      return 'its approval was revoked while the batch was running — skipped';
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
        throw Object.assign(new Error(`PDF preview could not be generated: ${result?.reason ?? 'unknown conversion error'}`), { statusCode: 422 });
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
    const size = statSync(candidate).size;
    if (size > MAX_RESUME_PREVIEW_BYTES) {
      throw Object.assign(new Error('resume is too large to preview'), { statusCode: 413 });
    }
    const extension = extname(candidate).toLowerCase();
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
    const file = join(workspace, MASTER_RESUME_RELATIVE);
    const historyDir = join(workspace, MASTER_HISTORY_RELATIVE);
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

  /** Keep the history directory bounded — it is a safety net, not an archive. */
  function pruneBackups(historyDir) {
    const kept = masterResumeState().backups ?? [];
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
      fail('the master resume must be a .docx file — the tailor reads Word documents only '
        + '(export from Google Docs as .docx, or "Save As" .docx in Word)', 400);
    }
    if (!bytes.length) fail('the uploaded file is empty', 400);
    if (bytes.length > MAX_MASTER_RESUME_BYTES) {
      fail(`the file is ${Math.round(bytes.length / 1024)} KB — the limit is `
        + `${Math.round(MAX_MASTER_RESUME_BYTES / 1024 / 1024)} MB`, 413);
    }
    if (!isDocxBuffer(bytes)) {
      fail('that file is not a .docx. It has a .docx name but its contents are something else '
        + '(often a PDF or an old .doc renamed) — open it in Word and use "Save As → .docx"', 415);
    }
    let extracted;
    try {
      extracted = extractDocxText(bytes);
    } catch (err) {
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
    if (runState.running) {
      const err = new Error(`a ${runState.phase} run is already in progress`);
      err.statusCode = 409;
      throw err;
    }
    const runId = randomUUID();
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
      try {
        const r = await runners[phase]({
          shouldCancel: () => runState.cancelRequested,
          abortSignal: runAbort.signal,
          searchHooks: { onSource },
        });
        // Per-source failures (a board that timed out, a token that expired)
        // do NOT fail the run — valid results from healthy sources were kept.
        // They surface as structured RCA entries and mark the run "partial".
        const sourceErrors = Array.isArray(r?.errors) ? r.errors : [];
        runState.rca = collapseRca(sourceErrors.map((e) => buildRca({
          operation: phase,
          source: e.source ?? e.company ?? null,
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
      const err = new Error('this job was already submitted (or has an unverified auto-submit) — not re-filling to avoid a duplicate application');
      err.statusCode = 409;
      throw err;
    }
    const approval = db.getApprovalByJob?.(jobId);
    if (!approval || approval.approval_status !== APPROVAL_STATUS.APPROVED) {
      const err = new Error('packet is not human-approved — approve it first');
      err.statusCode = 400;
      throw err;
    }
    const loaded = deps.loadPacketImpl ? deps.loadPacketImpl(approval) : loadPacket(approval);
    if (!loaded) {
      const err = new Error(`packet file unreadable for job ${jobId}`);
      err.statusCode = 500;
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
          deps: { ...deps, shouldCancel: () => runState.cancelRequested },
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
    return { started: true, jobId, runId, note: 'browser will stop before submit — review and click Submit yourself' };
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
    track((async () => {
      const results = [];
      const skipped = [];
      let queueLen = 0;
      let cancelled = false;
      try {
        // Auto-submit is fail-closed before any browser opens. Ordinary
        // fill-and-review batches retain the existing prepare/approve flow.
        let autoSubmitEligible = null;
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
        }

        // 0. Never queue a job that is already submitted (or whose auto-submit
        //    is unverified) — auto-approving + re-filling it could double-apply.
        const candidates = [];
        for (const jobId of ids) {
          if (autoSubmitEligible && !autoSubmitEligible.has(jobId)) continue;
          if (isSubmittedOrUnverified(db.getJob?.(jobId))) {
            skipped.push({ jobId, reason: 'already submitted — skipped to avoid a duplicate application' });
          } else {
            candidates.push(jobId);
          }
        }

        // 1. Prepare packets for jobs that don't have one yet (tailored resume
        //    + application packet). Failures are honest skips, not crashes.
        const needPacket = candidates.filter((id) => !db.getApprovalByJob?.(id));
        if (needPacket.length) {
          runState.phase = `auto-apply — preparing ${needPacket.length} packet(s)…`;
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
        let dailyCount = db.countAppliedOn?.(new Date().toISOString().slice(0, 10)) ?? 0;
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
          const liveSkip = liveSkipReason(jobId);
          if (liveSkip) {
            skipped.push({ jobId, reason: liveSkip });
            done += 1;
            // Keep the visible counter moving; without this the header stalled
            // (e.g. stuck at 2/5) whenever a queued job was skipped mid-run.
            runState.progress.completed += 1;
            continue;
          }
          runState.phase = `auto-apply (${done + 1}/${queue.length}) — ${jobId}`;
          runState.progress.currentJobId = jobId;
          const progressItem = runState.progress.items.find((x) => x.jobId === jobId);
          if (progressItem) progressItem.status = 'opening';
          try {
            const result = await assistFn({
              packet, config, mode: 'LIVE_ASSIST', approval, dailyCount,
              options: { autoSubmit },
              deps: { ...deps, shouldCancel: () => runState.cancelRequested },
            });
            recordAssistResult(db, jobId, result);
            if (result.submitted === true) dailyCount += 1;
            const itemResult = {
              jobId, status: result.status, submitted: result.submitted === true,
              blockers: result.blockers ?? [], resumed: result.resumed === true,
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
      sendJson(res, err.statusCode ?? 500, { error: sanitizeErrorMessage(err.message) });
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
          const current = db.getJob?.(jobId);
          if (current && isAggregatorUrl(current.url)) {
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
    if (req.method !== 'GET' && !isAllowedOrigin(req.headers.origin)) {
      return sendJson(res, 403, { error: 'forbidden: cross-origin requests are not allowed' });
    }

    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
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
    if (req.method === 'GET' && (path.startsWith('/assets/') || path.startsWith('/learn/assets/'))) {
      return serveStatic(res, path);
    }
    if (req.method === 'GET' && path === '/api/stats') {
      return sendJson(res, 200, dashboardStats(db, { now: nowDate() }));
    }
    if (req.method === 'GET' && path === '/api/jobs') {
      const filters = Object.fromEntries(url.searchParams.entries());
      filters.now = nowDate();
      return sendJson(res, 200, boardPage(db, filters));
    }
    if (req.method === 'GET' && path === '/api/run/status') {
      return sendJson(res, 200, runState);
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
      return sendJson(res, 200, dashboardSections(db, { now: nowDate() }));
    }
    if (req.method === 'GET' && path === '/api/reports') {
      return sendJson(res, 200, buildReports(db, { now: nowDate() }));
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
        return sendJson(res, 400, { error: 'the file contents were not transferred correctly — try again' });
      }
      const bytes = Buffer.from(encoded, 'base64');
      const result = replaceMasterResume({ filename: body.filename, bytes });
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && path === '/api/master-resume/restore') {
      const body = await readBody(req);
      return sendJson(res, 200, restoreMasterResume(body.name));
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
        try { applyDecision(db, jobId, body.decision); updated.push(jobId); }
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
        const detail = jobDetail(db, jobId, { ...deps, root: config?.root ?? null, now: nowDate() });
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
        return sendJson(res, 200, await checker(job.url, deps));
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
        const result = applyDecision(db, jobId, body.decision);
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
      if (req.method === 'POST' && action === 'note') {
        const body = await readBody(req);
        const result = setJobNote(db, jobId, body.note);
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

  return { server, runState, inFlight, flushTracker };
}

/**
 * Start the dashboard on 127.0.0.1.
 *
 * @param {object} args createDashboardServer args + { port }
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, close: Function }>}
 */
export function startDashboard({ config, db, logger, port = 4646, deps = {} } = {}) {
  const { server, runState, inFlight, flushTracker } = createDashboardServer({ config, db, logger, deps });
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        reject(new Error(`port ${port} is already in use — another dashboard is probably running. `
          + `Open http://127.0.0.1:${port} in your browser, or close the other process `
          + `(or start this one with a different port).`));
        return;
      }
      reject(err);
    });
    // 127.0.0.1 only — the dashboard must never be reachable from the network.
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        server,
        runState,
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        close: async () => {
          runState.cancelRequested = true;
          await new Promise((r) => server.close(r));
          await Promise.allSettled([...inFlight]);
          // Write out any tracker refresh still sitting in the debounce window
          // so shutting down never loses the last action's CSV update.
          try { flushTracker(); } catch { /* best effort on shutdown */ }
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
 * `runState.lastError` (so the UI surfaces it) and keeps serving. Process
 * signals (SIGINT/SIGTERM) are deliberately NOT intercepted. Returns an
 * uninstall function so tests never leak global handlers.
 *
 * @param {object} args
 * @param {object} [args.runState] shared run state to annotate
 * @param {object} [args.logger]
 * @param {NodeJS.EventEmitter} [args.proc=process]
 * @returns {() => void} uninstall the handlers
 */
export function installProcessSafetyNet({ runState, logger, proc = process } = {}) {
  const record = (kind) => (reason) => {
    const msg = reason?.message ?? String(reason);
    logger?.error?.(`dashboard survived an ${kind}: ${msg}`);
    if (runState) runState.lastError = `background error (server still up): ${msg}`;
  };
  const onRejection = record('unhandled rejection');
  const onException = record('uncaught exception');
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
export function isAllowedOrigin(origin) {
  if (origin === undefined || origin === '') return true;
  if (origin === 'null') return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
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
 * @param {import('node:http').ServerResponse} res
 * @param {string} urlPath request pathname (e.g. "/assets/js/app.js")
 */
function serveStatic(res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); }
  catch { rel = urlPath; }
  const abs = normalize(join(PUBLIC_DIR, rel));
  // Same containment helper as the artifact reads, so both use the platform's
  // real path semantics rather than raw string prefixes.
  if (!isInsideDirectory(PUBLIC_DIR, abs)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  let buf;
  try {
    buf = readFileSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') {
      return sendJson(res, 404, { error: `not found: ${urlPath}` });
    }
    throw err;
  }
  const type = MIME_TYPES[extname(abs).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(buf);
}

/**
 * Read and parse a JSON request body (empty body -> {}).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes=1e6] cap for this route. Only the master-resume
 *   upload raises it; every other endpoint keeps the small default so a stray
 *   local request cannot make the dashboard buffer megabytes.
 */
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
      try { resolve(JSON.parse(data)); }
      catch { fail('invalid JSON body', 400); }
    });
    req.on('error', (err) => reject(err));
    req.on('aborted', () => fail('the request was interrupted before it finished', 400));
  });
}
