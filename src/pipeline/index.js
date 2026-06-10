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
import { mkdirSync, writeFileSync } from 'node:fs';

import { runSearch } from '../search/index.js';
import { classifyDiscovery } from '../search/discoveryFilter.js';
import { applyFreshnessFilter } from '../search/freshnessFilter.js';
import { sourceKind } from '../search/sources.js';
import { applyExclusions } from '../scoring/exclusionFilter.js';
import { classifySponsorship } from '../scoring/sponsorshipClassifier.js';
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
import { LIFECYCLE, lifecycleForTier, isQueuedTier } from '../lifecycle.js';
import { emptyCounters, writeAllArtifacts } from '../outputs.js';

/** Tiers that warrant building an application packet in PREPARE/LIVE_ASSIST. */
const PREPARE_TIERS = new Set([TIERS.PRIORITY, TIERS.APPLY, TIERS.QUEUE]);

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
  const { jobs, duplicates, errors } = await searchFn({
    jobboards: config.jobboards,
    candidate: config.candidate,
    scoring: config.scoring,
    // Only skip jobs we have already APPLIED to. Merely-seen or prepared jobs
    // are re-discovered so DRY_RUN -> PREPARE -> LIVE_ASSIST can build on them.
    // Honors runtime.excludeAlreadyApplied (default true).
    existsInDb: (job) => {
      if (config?.runtime?.excludeAlreadyApplied === false) return false;
      const existing = db.getJob(job.id);
      return Boolean(existing && existing.applied);
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
  for (const { job, reason } of freshness.dropped) {
    counters.jobs_discarded += 1;
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });
    persistJob(db, job, { status: 'discarded', discard_reason: `stale: ${reason}` });
    discovered.push(discoveredRow(job, discovery, {
      keptForScoring: false, discardReason: `stale: ${reason}`, lifecycle: LIFECYCLE.HARD_DISCARDED,
    }));
    reportRows.push(reportRow(job, discovery, { status: 'discarded', discard_reason: `stale: ${reason}` }));
  }

  // Record undated jobs in the SEPARATE review bucket. They are NOT scored,
  // prepared, or counted as fresh — only surfaced for a human to inspect.
  for (const job of freshness.review) {
    counters.jobs_unknown_date_review += 1;
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });
    persistJob(db, job, { status: 'unknown_date_review', discard_reason: 'unknown posting date' });
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
    const discovery = job.rawMetadata?.discovery
      ?? classifyDiscovery(job, { candidate: config.candidate, scoring: config.scoring });

    // 1. Hard exclusions.
    const exclusion = applyExclusions(job, config.exclusions, { now });
    if (exclusion.excluded) {
      counters.jobs_discarded += 1;
      persistJob(db, job, { status: 'discarded', discard_reason: exclusion.reason });
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
      matched_keywords: score.matchedKeywords, missing_keywords: score.missingKeywords,
      explanation, status: tier === TIERS.DISCARD ? 'discarded' : 'scored',
    });
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
    if (mode !== 'DRY_RUN' && PREPARE_TIERS.has(tier)) {
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
  return { counters, scoredJobs, discovered, scored, queued, review: reviewRows, report, errors, artifacts };
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

/** Build, persist, and enqueue an application packet for one strong job. */
async function preparePacket({ config, db, logger, job, score, tier, deps, counters }) {
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
  let resumeTailored = false;
  let resumeWarning = null;
  let resumeValidation = null;
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
    resumeTailored = Boolean(tailored?.tailored);
    resumeWarning = tailored?.warning ?? null;
    resumeValidation = tailored?.validation ?? null;
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
        meta: { output_path: resumePath, pdf_path: resumePdfPath, validation: resumeValidation },
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
    resumeTailored, resumeWarning, resumePdfPath, resumeValidation,
    formFields: job.formFields ?? [],
    html: job.html ?? '',
  });
  const packetPath = writePacket(packet, outPaths.folder, outPaths.packetName);
  persistJob(db, job, {
    status: 'prepared', resume_path: resumePath, cover_letter_path: coverLetterPath,
    resume_docx_path: resumeTailored ? resumePath : null,
    resume_pdf_path: resumePdfPath,
    application_packet_path: packetPath, output_folder_path: outPaths.folder,
    ats_platform: packet.ats.platform,
  });

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
  writeFileSync(path, text, 'utf8');
}

function persistJob(db, job, fields) {
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
    ...fields,
  });
}
