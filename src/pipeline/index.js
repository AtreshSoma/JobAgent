/**
 * Pipeline orchestrator.
 *
 * Ties the stages together: search -> exclude -> classify sponsorship -> score ->
 * explain/tier -> persist -> (PREPARE) build packet + enqueue for human approval
 * -> report. It is mode-aware and side-effect-light:
 *
 *   - DRY_RUN:     search, score, persist, and report only. No packets, no AI,
 *                  no browser. Safe to run with zero secrets.
 *   - PREPARE:     additionally builds application packets (resume reference +
 *                  cover letter + prefill plan) and enqueues them for review.
 *                  STILL never submits.
 *   - LIVE_ASSIST: same preparation; submission remains gated behind explicit
 *                  human approval + live-submit runtime (handled downstream).
 *
 * All external effects (search fetch, resume tailoring) are injectable so the
 * pipeline is fully testable offline.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

import { writeFileAtomic } from '../utils/fsSafe.js';

import { runSearch } from '../search/index.js';
import { urlKeyFor } from '../search/deduplicator.js';
import { classifyDiscovery } from '../search/discoveryFilter.js';
import { applyFreshnessFilter, UNDATED_REASON } from '../search/freshnessFilter.js';
import { sourceKind } from '../search/sources.js';
import { applyExclusions } from '../scoring/exclusionFilter.js';
import { classifySponsorship } from '../scoring/sponsorshipClassifier.js';
import { classifyEmployment } from '../scoring/employmentClassifier.js';
import { scoreJob } from '../scoring/scorer.js';
import { explainScore, TIERS } from '../scoring/explainScore.js';
import { compareJobsForQueue } from '../scoring/jobRanking.js';
import { generateCoverLetter } from '../apply/coverLetter.js';
import { buildApplicationPacket, writePacket } from '../apply/applicationPacket.js';
import { enqueueForApproval } from '../apply/approvalQueue.js';
import { generateReport } from '../reports/reportGenerator.js';
import { EVENT_TYPES } from '../logging/jobLogger.js';
import { dateStamp, formatPostedRelative } from '../utils/dates.js';
import { buildJobPaths } from '../utils/outputPaths.js';
import { tailorResumeForJob } from '../resume/tailorRunner.js';
import { LIFECYCLE, lifecycleForTier, isQueuedTier, isProtectedJobRow } from '../lifecycle.js';
import { emptyCounters, writeAllArtifacts } from '../outputs.js';

/**
 * Tiers that warrant AUTO-building an application packet in PREPARE/LIVE_ASSIST.
 * Deliberately excludes Queue: Queue is "worth a human look", not "worth a
 * tailored resume" — auto-preparing it was measured producing 153 medium-fit
 * packets vs 8 strong-fit ones, burying the real candidates. Queue jobs can
 * still be prepared explicitly via the dashboard's "Prepare selected".
 */
const PREPARE_TIERS = new Set([TIERS.PRIORITY, TIERS.APPLY]);

/**
 * @param {object} args
 * @param {object} args.config loadConfig() bundle
 * @param {import('../logging/db.js').Database} args.db
 * @param {import('../logging/jobLogger.js').JobLogger} args.logger
 * @param {string} args.mode DRY_RUN | PREPARE | LIVE_ASSIST
 * @param {object} [args.deps]
 * @param {Function} [args.deps.searchFn] override runSearch (testing)
 * @param {Function} [args.deps.tailorFn] resume tailoring hook -> returns path
 * @param {Date} [args.deps.now]
 * @returns {Promise<object>} run summary with counters + scored jobs
 */
export async function runPipeline({ config, db, logger, mode, deps = {} } = {}) {
  const now = deps.now ?? new Date();
  const searchFn = deps.searchFn ?? runSearch;

  logger.event(EVENT_TYPES.SEARCH_START, { message: 'Starting search' });
  // Preload the set of already-APPLIED job ids ONCE (cheap) rather than issuing
  // a per-job SELECT during dedup — a discovery run examines thousands of jobs.
  const excludeApplied = config?.runtime?.excludeAlreadyApplied !== false;
  const appliedIds = excludeApplied ? db.getAppliedJobIds() : null;
  // Provider-specific ids can change across sources/runs. Refresh the same id,
  // but do not create another actionable row for a URL already owned by a
  // different live/protected record.
  const activeUrlOwners = new Map(
    (db.getActiveJobUrls?.() ?? [])
      .map((row) => [urlKeyFor(row), row.id])
      .filter(([key]) => key),
  );
  const workdayDetailCache = db.getReusableWorkdayDetail
    ? (jobId) => db.getReusableWorkdayDetail(jobId)
    : null;
  const { jobs, duplicates, errors, perSource = [], cancelled: searchCancelled = false } = await searchFn({
    jobboards: config.jobboards,
    candidate: config.candidate,
    scoring: config.scoring,
    ctx: {
      ...(deps.searchCtx ?? {}),
      root: config.root,
      shouldCancel: deps.shouldCancel,
      // Aborts in-flight and gate-queued network work on cancel. `shouldCancel`
      // is only checked BETWEEN operations, so without this a request already on
      // the wire ran to completion or to its timeout — a ~30s "Stopping…".
      abortSignal: deps.abortSignal,
      workdayDetailCache,
    },
    hooks: deps.searchHooks ?? {},
    // Only skip jobs we have already APPLIED to. Merely-seen or prepared jobs
    // are re-discovered so DRY_RUN -> PREPARE -> LIVE_ASSIST can build on them.
    // Honors runtime.excludeAlreadyApplied (default true).
    existsInDb: (job) => {
      if (appliedIds?.has(job.id)) return true;
      const owner = activeUrlOwners.get(urlKeyFor(job));
      return Boolean(owner && owner !== job.id);
    },
  });
  logger.event(EVENT_TYPES.SEARCH_END, {
    message: `Search complete: ${jobs.length} jobs, ${duplicates.length} dupes, ${errors.length} errors`,
    meta: { found: jobs.length, duplicates: duplicates.length, errors: errors.length },
  });

  // Freshness gate: prioritize recent postings. Stale (and optionally undated)
  // jobs are filtered out BEFORE scoring/preparation. Config-driven; the 3-day
  // fallback widens the window automatically when the strict window is thin.
  const freshness = applyFreshnessFilter(jobs, config.runtime ?? {}, { now });
  const freshJobs = freshness.kept;
  if (freshness.dropped.length || freshness.review.length) {
    logger.event(EVENT_TYPES.FRESHNESS_FILTERED, {
      message: `Freshness ${freshness.mode}: kept ${freshJobs.length}, dropped ${freshness.dropped.length}`
        + (freshness.review.length ? `, ${freshness.review.length} held for unknown-date review` : '')
        + (freshness.fallbackUsed ? ' (3-day fallback applied)' : ''),
      meta: {
        mode: freshness.mode,
        windowDays: freshness.windowDays,
        effectiveWindowDays: freshness.effectiveWindowDays,
        fallbackUsed: freshness.fallbackUsed,
        counts: freshness.counts,
      },
    });
  }

  const counters = { ...emptyCounters(), jobs_found: jobs.length };
  if (searchCancelled) counters.jobs_cancelled += 1;
  const scoredJobs = [];
  // Full-visibility audit trail of every discovered job and what happened to it.
  const discovered = [];
  // Rows fed to the report: includes hard-discarded jobs (which never reach
  // scoredJobs) so the report can show found / discarded / weak / scored / queued.
  const reportRows = [];
  // Rows for data/scored_jobs.json (everything that survived hard exclusions).
  const scored = [];
  // Rows for data/queued_jobs.json (only queued-tier jobs worth acting on).
  const queued = [];
  // Undated jobs held in a SEPARATE review bucket (never mixed into fresh
  // results). Surfaced in data/unknown_date_review.json for manual triage.
  const reviewRows = [];

  // Record freshness-dropped jobs in the audit trail + report so they remain
  // visible (as discarded) rather than silently vanishing.
  //
  // "stale" is a claim about AGE. A posting with no parseable date is not old —
  // its date is unknown, which is a different problem with a different fix
  // (verify the link). Blanket-prefixing every drop with "stale:" mislabeled
  // thousands of undated rows as expired, and hid them from the "needs date
  // check" review the UI offers. Undated drops therefore keep their own honest
  // reason and are tagged so the dashboard can count them.
  for (const { job, reason } of freshness.dropped) {
    counters.jobs_discarded += 1;
    const undated = reason === UNDATED_REASON;
    if (undated) counters.jobs_unknown_date_review += 1;
    const discardReason = undated ? reason : `stale: ${reason}`;
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });
    persistJob(db, job, { status: 'discarded', discard_reason: discardReason }, config.exclusions?.employmentTypes);
    discovered.push(discoveredRow(job, discovery, {
      keptForScoring: false, discardReason, lifecycle: LIFECYCLE.HARD_DISCARDED,
    }));
    reportRows.push(reportRow(job, discovery, { status: 'discarded', discard_reason: discardReason }));
  }

  // Record undated jobs in the SEPARATE review bucket. They are NOT scored,
  // prepared, or counted as fresh — only surfaced for a human to inspect.
  for (const job of freshness.review) {
    counters.jobs_unknown_date_review += 1;
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });
    persistJob(db, job, { status: 'unknown_date_review', discard_reason: 'unknown posting date' }, config.exclusions?.employmentTypes);
    const dRow = discoveredRow(job, discovery, {
      keptForScoring: false, discardReason: 'unknown posting date',
      lifecycle: LIFECYCLE.UNKNOWN_DATE_REVIEW,
    });
    discovered.push(dRow);
    reviewRows.push(dRow);
    reportRows.push(reportRow(job, discovery, {
      status: 'unknown_date_review', discard_reason: 'unknown posting date',
    }));
  }

  for (const job of freshJobs) {
    if (deps.shouldCancel?.()) {
      counters.jobs_cancelled += 1;
      break;
    }
    // Find New Jobs is incremental: an unchanged record that already has a
    // score does not need deterministic scoring work repeated. Re-score is the
    // explicit command for applying changed scoring configuration to all rows.
    const existing = db.getJob?.(job.id) ?? null;
    if (mode === 'DRY_RUN' && existing?.score != null && materiallyUnchanged(existing, job)) {
      counters.jobs_skipped_unchanged += 1;
      continue;
    }
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });

    // 1. Hard exclusions.
    const exclusion = applyExclusions(job, config.exclusions, { now });
    if (exclusion.excluded) {
      counters.jobs_discarded += 1;
      persistJob(db, job, { status: 'discarded', discard_reason: exclusion.reason }, config.exclusions?.employmentTypes);
      logger.event(EVENT_TYPES.EXCLUSION_MATCHED, {
        jobId: job.id, message: exclusion.reason, meta: { category: exclusion.category },
      });
      discovered.push(discoveredRow(job, discovery, {
        keptForScoring: false, discardReason: exclusion.reason, lifecycle: LIFECYCLE.HARD_DISCARDED,
      }));
      reportRows.push(reportRow(job, discovery, { status: 'discarded', discard_reason: exclusion.reason }));
      continue;
    }

    // 2. Sponsorship + 3. Score + 4. Tier.
    const sponsorship = classifySponsorship(job, config.scoring.sponsorship);
    const score = scoreJob(job, { scoring: config.scoring, sponsorship, candidate: config.candidate, now });
    const { tier, explanation, sponsorshipGated } = explainScore(score, config.scoring);
    counters.jobs_scored += 1;
    const queuedTier = isQueuedTier(tier, config.scoring);
    let lifecycle = lifecycleForTier(tier, config.scoring);

    const enriched = { ...job, score: score.total, tier, sponsorship: sponsorship.status, explanation, lifecycle };
    scoredJobs.push(enriched);
    const row = reportRow(job, discovery, {
      score: score.total, tier, sponsorship: sponsorship.status,
      missing_keywords: score.missingKeywords,
      status: tier === TIERS.DISCARD ? 'discarded' : 'scored',
    });
    reportRows.push(row);

    persistJob(db, job, {
      score: score.total, tier, sponsorship: sponsorship.status,
      // The evidence behind the sponsorship verdict, so the badge is auditable
      // rather than an unexplained assertion.
      sponsorship_signals: sponsorship.signals ?? [],
      matched_keywords: score.matchedKeywords, missing_keywords: score.missingKeywords,
      explanation, status: tier === TIERS.DISCARD ? 'discarded' : 'scored',
    }, config.exclusions?.employmentTypes);
    logger.event(EVENT_TYPES.SCORE_EXPLAINED, {
      jobId: job.id, message: `${score.total}/100 -> ${tier}`,
      meta: { score: score.total, tier, sponsorship: sponsorship.status, sponsorshipGated, posted: formatPostedRelative(job.postedAt, now) },
    });

    if (tier === TIERS.DISCARD) {
      counters.jobs_discarded += 1;
      const dRow = discoveredRow(job, discovery, {
        keptForScoring: true, score: score.total, tier, sponsorship: sponsorship.status,
        matchedKeywords: score.matchedKeywords, missingKeywords: score.missingKeywords,
        discardReason: 'below near-miss threshold', lifecycle: LIFECYCLE.SCORED,
      });
      discovered.push(dRow);
      scored.push(dRow);
      continue;
    }
    if (queuedTier) {
      counters.jobs_queued += 1;
    }

    // 5. PREPARE / LIVE_ASSIST: build a packet for strong, sponsorship-cleared roles.
    let packetPath = null;
    // An optional prepareFilter lets watch mode tailor ONLY brand-new jobs each
    // cycle (skip re-tailoring already-prepared ones). Defaults to preparing all
    // eligible tiers, so normal runs are unchanged.
    const shouldPrepare = typeof deps.prepareFilter === 'function' ? deps.prepareFilter(job) : true;
    if (mode !== 'DRY_RUN' && PREPARE_TIERS.has(tier) && shouldPrepare) {
      packetPath = await preparePacket({ config, db, logger, job, score, tier, deps, counters });
      if (packetPath) {
        lifecycle = LIFECYCLE.PREPARED;
        enriched.application_packet_path = packetPath;
        enriched.status = 'prepared';
        enriched.lifecycle = lifecycle;
        row.application_packet_path = packetPath;
        row.status = 'prepared';
      }
    }

    const dRow = discoveredRow(job, discovery, {
      keptForScoring: true, score: score.total, tier, sponsorship: sponsorship.status,
      matchedKeywords: score.matchedKeywords, missingKeywords: score.missingKeywords,
      packetPath, lifecycle,
    });
    discovered.push(dRow);
    scored.push(dRow);
    if (queuedTier) queued.push(dRow);
  }

  // Order every actionable list freshest-first (last-24h > sponsorship > score >
  // direct ATS) so queues, artifacts, and console summaries surface the newest,
  // most-feasible roles at the top.
  const rankByFreshness = compareJobsForQueue(now);
  scoredJobs.sort(rankByFreshness);
  scored.sort(rankByFreshness);
  queued.sort(rankByFreshness);

  // Persist the full-visibility artifacts (found / scored / queued / review).
  const artifacts = writeAllArtifacts(
    config.root,
    { discovered, scored, queued, review: reviewRows, duplicates, errors, counters },
    deps,
  );

  // Report (built from reportRows so hard-discarded jobs are represented too).
  const stamp = deps.stamp ?? dateStamp(now);
  const report = generateReport({
    jobs: reportRows,
    outDir: join(config.root, 'reports'),
    stamp,
  });

  logger.endRun(counters);
  return {
    counters, scoredJobs, discovered, scored, queued, review: reviewRows,
    report, errors, artifacts, perSource, cancelled: searchCancelled,
  };
}

/** Compact entry for the data/found_jobs.json audit trail. */
function discoveredRow(job, discovery, extra = {}) {
  return {
    id: job.id,
    source: job.source,
    sourceKind: job.rawMetadata?.sourceKind ?? sourceKind(job.source),
    company: job.company,
    title: job.title,
    location: job.location,
    url: job.url,
    postedAt: job.postedAt ?? null,
    discoveryMatch: discovery?.match ?? 'unknown',
    discoverySignals: discovery?.signals ?? [],
    discoveryReasons: discovery?.reasons ?? [],
    keptForScoring: extra.keptForScoring ?? false,
    lifecycle: extra.lifecycle ?? LIFECYCLE.FOUND,
    score: extra.score ?? null,
    tier: extra.tier ?? null,
    sponsorship: extra.sponsorship ?? null,
    matchedKeywords: extra.matchedKeywords ?? [],
    missingKeywords: extra.missingKeywords ?? [],
    packetPath: extra.packetPath ?? null,
    discardReason: extra.discardReason ?? null,
  };
}

/** Row shape consumed by the report summarizer (mirrors jobs-table columns). */
function reportRow(job, discovery, extra = {}) {
  return {
    id: job.id,
    source: job.source,
    company: job.company,
    title: job.title,
    location: job.location,
    url: job.url,
    posted_at: job.postedAt ?? null,
    discoveryMatch: discovery?.match ?? 'unknown',
    score: extra.score ?? null,
    tier: extra.tier ?? null,
    sponsorship: extra.sponsorship ?? null,
    discard_reason: extra.discard_reason ?? null,
    missing_keywords: extra.missing_keywords ?? [],
    status: extra.status ?? null,
    application_packet_path: extra.application_packet_path ?? null,
  };
}

/**
 * Build, persist, and enqueue an application packet for one job.
 * Exported so "Prepare selected" (dashboard) can prepare specific jobs the
 * human chose, not only the tiers the pipeline auto-selects.
 */
export async function preparePacket({ config, db, logger, job, score, tier, deps, counters }) {
  const now = deps.now ?? new Date();
  // Professional, recruiter-friendly output location for every artifact:
  //   applications/output/{Company}/{Title}_{Date}/...
  const outPaths = buildJobPaths({
    root: config.root,
    company: job.company,
    title: job.title,
    dateOrId: dateStamp(now),
    candidateName: config.candidate?.identity?.fullName,
  });

  // Resume tailoring: an injected tailor wins (testing); otherwise run the real
  // Node->Python tailor. On any failure we fall back to the master resume and
  // record a warning so the packet is never silently broken. The master resume
  // is opened READ-ONLY by the tailor and is never overwritten.
  const master = join(config.root, 'resumes', 'base', 'MASTER_RESUME.docx');
  let resumePath = master;
  let resumePdfPath = null;
  let resumePreviewWarning = null;
  let resumeTailored = false;
  let resumeWarning = null;
  let resumeValidation = null;
  let resumeAtsReport = null;
  let resumeTailoring = null;
  const tailorFn = typeof deps.tailorFn === 'function' ? deps.tailorFn : tailorResumeForJob;
  try {
    // exportPdf — also emit a PDF alongside the .docx when enabled (most ATS
    // prefer PDF). Best-effort: requires Word/docx2pdf, falls back silently.
    // outputDir/outputFilename route the tailored docx straight into the
    // professional job folder with a clean, candidate-named filename.
    // The per-job "Most relevant to this role" focus line is OFF by default
    // (it read awkwardly near the header); opt back in with
    // config.runtime.resumeFocusLine === true.
    const tailored = await tailorFn({
      job, score, config,
      options: {
        addSummaryLine: config?.runtime?.resumeFocusLine === true,
        exportPdf: config?.runtime?.resumeExportPdf !== false,
        outputDir: outPaths.folder,
        outputFilename: `${outPaths.resumeBase}.docx`,
      },
      deps,
    });
    if (tailored?.output_path) resumePath = tailored.output_path;
    resumePdfPath = tailored?.pdf_path ?? null;
    resumePreviewWarning = tailored?.pdfWarning ?? null;
    resumeTailored = Boolean(tailored?.tailored);
    resumeWarning = tailored?.warning ?? null;
    resumeValidation = tailored?.validation ?? null;
    resumeAtsReport = tailored?.atsReport ?? null;
    resumeTailoring = tailored?.tailored
      ? {
          changes: tailored.changes ?? [],
          gaps: tailored.gaps ?? [],
          summaryLine: tailored.summaryLine ?? null,
          qualifications: tailored.qualifications ?? {},
          selectedContent: tailored.selectedContent ?? {},
          rewritePolicy: tailored.rewritePolicy ?? null,
          invariants: tailored.invariants ?? null,
          limitations: tailored.limitations ?? [],
          // Length is a review fact: the measured page count when a PDF was
          // rendered, the tailor's estimate otherwise.
          pageCount: tailored.pageCount ?? null,
          estimatedPages: tailored.invariants?.estimated_pages ?? null,
          // Audit for the optional grounded JD-requirement expansion.
          llmRequirements: tailored.llmRequirements ?? null,
        }
      : null;
    // A resume that fails hard validation (empty/unreadable/no sections/no
    // contact) must not be silently submitted — surface it as a warning so the
    // packet carries a blocker and the submit gate withholds.
    if (resumeValidation && resumeValidation.ok === false) {
      const why = (resumeValidation.issues ?? []).join('; ') || 'failed format validation';
      resumeWarning = resumeWarning ? `${resumeWarning}; ${why}` : `resume invalid: ${why}`;
    }
    if (resumeTailored) {
      logger.event(EVENT_TYPES.RESUME_GENERATED, {
        jobId: job.id, message: `tailored resume (${tailored.emphasized ?? 0} emphasized)`,
        meta: {
          output_path: resumePath, pdf_path: resumePdfPath, pdf_warning: resumePreviewWarning,
          validation: resumeValidation,
          atsScore: resumeAtsReport?.match_score ?? null, atsBand: resumeAtsReport?.band ?? null,
        },
      });
    } else if (resumeWarning) {
      logger.event(EVENT_TYPES.RESUME_GENERATED, {
        jobId: job.id, message: resumeWarning, level: 'warn',
        meta: { usedFallback: true },
      });
    }
  } catch (err) {
    resumeWarning = `resume tailoring failed: ${err.message}`;
    logger.error(resumeWarning, {}, job.id);
  }

  // Cover letter (deterministic; only when warranted).
  const cover = generateCoverLetter(job, score, {
    coverLetter: config.coverLetter,
    candidate: config.candidate,
    humanizerPatterns: config.humanizerPatterns,
  });
  let coverLetterPath = null;
  if (cover.generated) {
    coverLetterPath = writeCoverLetter(outPaths.folder, `${outPaths.coverLetterBase}.txt`, cover, deps);
    logger.event(EVENT_TYPES.COVER_LETTER_GENERATED, { jobId: job.id, message: `cover letter (${cover.wordCount} words)` });
  }

  const packet = buildApplicationPacket({
    job, score, tier,
    candidate: config.candidate,
    screeningAnswers: config.screeningAnswers,
    resumePath, coverLetter: cover, coverLetterPath,
    resumeTailored, resumeWarning, resumePdfPath, resumePreviewWarning, resumeValidation,
    tailoring: resumeTailoring,
    atsReport: resumeAtsReport,
    formFields: job.formFields ?? [],
    html: job.html ?? '',
  });
  const packetPath = writePacket(packet, outPaths.folder, outPaths.packetName);
  persistJob(db, job, {
    status: 'prepared', resume_path: resumePath, cover_letter_path: coverLetterPath,
    resume_docx_path: resumeTailored ? resumePath : null,
    resume_pdf_path: resumePdfPath,
    application_packet_path: packetPath, output_folder_path: outPaths.folder,
    // The true "prepared on" timestamp — daily stats must not infer it from
    // updated_at, which any later note/decision/re-score would bump.
    prepared_at: new Date().toISOString(),
    ats_platform: packet.ats.platform,
    ats_score: resumeAtsReport?.match_score ?? null,
    ats_band: resumeAtsReport?.band ?? null,
  }, config.exclusions?.employmentTypes);

  enqueueForApproval(db, { packet, packetPath });
  counters.jobs_prepared += 1;
  logger.event(EVENT_TYPES.APPROVAL_REQUIRED, {
    jobId: job.id, message: `Packet prepared for ${job.company} - awaiting human approval`,
    meta: { packetPath, blockers: packet.blockers },
  });
  return packetPath;
}

function writeCoverLetter(dir, fileName, cover, deps) {
  const writeImpl = deps.writeFileImpl ?? defaultWrite;
  const path = join(dir, fileName);
  writeImpl(dir, path, cover.text);
  return path;
}

function defaultWrite(dir, path, text) {
  mkdirSync(dir, { recursive: true });
  // Atomic: readers must never observe a torn cover letter / artifact.
  writeFileAtomic(path, text, 'utf8');
}

/** Statuses owned by discovery/scoring — the only ones the guard applies to. */
const DISCOVERY_STATUSES = new Set(['discarded', 'scored', 'unknown_date_review']);

/** Material fields whose change warrants re-scoring an already-seen posting. */
function materiallyUnchanged(row, job) {
  return String(row.company ?? '') === String(job.company ?? '')
    && String(row.title ?? '') === String(job.title ?? '')
    && String(row.location ?? '') === String(job.location ?? '')
    && String(row.url ?? '') === String(job.url ?? '')
    && String(row.jd_text ?? '') === String(job.jdText ?? '')
    && String(row.posted_at ?? '') === String(job.postedAt ?? '')
    && String(row.employment_type ?? '') === String(job.employmentType ?? '');
}

function persistJob(db, job, fields = {}, markers = {}) {
  const patch = { ...fields };
  // Downgrade guard: a re-discovered job the human already invested in
  // (decision, packet, approval, assist outcome, submission) keeps its status —
  // a stale/duplicate hit must never flip a prepared job back to "discarded".
  // Metadata (JD text, posted date, URL, score fields) still refreshes.
  // Narrow read where available — the guard only inspects four columns, so it
  // must not drag the row's jd_text along for every re-seen posting.
  const protectionRow = () => (typeof db.getJobProtectionFields === 'function'
    ? db.getJobProtectionFields(job.id)
    : db.getJob?.(job.id));
  if (DISCOVERY_STATUSES.has(patch.status) && isProtectedJobRow(protectionRow())) {
    delete patch.status;
    delete patch.discard_reason;
  }
  db.upsertJob({
    id: job.id,
    source: job.source,
    company: job.company,
    title: job.title,
    location: job.location,
    url: job.url,
    jd_text: job.jdText,
    posted_at: job.postedAt,
    applicant_count: job.applicantCount,
    employment_type: job.employmentType,
    employment_category: classifyEmployment(job, markers).category,
    ...(job.rawMetadata?.compensation
      ? { compensation_text: String(job.rawMetadata.compensation).trim() }
      : {}),
    ...patch,
  });
}
