# AUDIT_LOG — job-agent audit (2026-07-13)

Format: [module] [severity] [description] [fix status]

## Step 0.5 pre-verified findings

- [dashboard/frontend] [blocker] Finding A: `nextBestAction()`
  (src/dashboard/public/index.html) surfaced "⚡ Auto-apply" as the featured CTA
  for strong-fit jobs without consulting `sponsorshipGated`/`sponsorship`. A
  score-82 job downgraded to Queue by the sponsorship gate still got one-click
  Auto-apply; the gate was only checked late, server-side, and only for the
  auto-*submit* variant (src/apply/autoApplyEligibility.js:84) — the plain fill
  path never checked it. UX-level gate bypass vs README rule ("Queue-tier jobs
  are prepared only when you select them yourself"; gated roles' next action is
  "verify sponsorship first").
  [fix status: FIXED — `nextBestAction()` now returns a "Verify sponsorship ↗"
  primary action + "★ Verified — shortlist" for `sponsorshipGated && !userDecision`
  jobs, and `autoApplyOne()` requires an explicit confirm (counts as the user's
  per-job approval) before auto-applying a gated job. Validated by
  workbenchUi/dashboardServer/dashboardData suites.]
- [dashboard/data + README] [minor] Finding B: dashboard shows a 4th
  sponsorship bucket "Unclassified" (src/dashboard/data.js:573,
  `job.sponsorship ?? 'Unclassified'`). Verdict: **(a) intentional, README
  undocumented** — NOT a silent-skip bug. classifySponsorship() runs in the
  score path (src/pipeline/index.js:212, src/cli/commands.js:158,240) and always
  returns Confirmed/Likely/Unconfirmed; NULL sponsorship means the job came from
  a discover-only run or was hard-excluded before scoring. The dashboard bucket
  correctly avoids mislabeling those as "Unconfirmed".
  [fix status: FIXED — README "Sponsorship breakdown" bullet now documents the
  dashboard-only Unclassified bucket.]

## Module reviews (Step 1, in plan order)

- [search/index.js + sources.js] [none] Orchestration isolates per-source
  failures, preserves deterministic order via mapSettled, tags provenance kind.
  No defects. Tests green.
- [search/adapters: greenhouse, lever, ashby, smartrecruiters, manualUrls,
  genericPublicPage] [none] Official public APIs only; per-board errors
  isolated; Greenhouse uses first_published over updated_at (correct); CSV
  ingestion validates rows with per-row errors; JSON-LD parsing (normalize.js)
  handles @graph/arrays/malformed blocks. No defects. Tests green (104).
- [search/adapters/genericPublicPage] [minor] `run()` emits `source: source.id`
  (e.g. "generic-public-pages"), which is not in sources.js SOURCE_STRING_KIND,
  so such jobs report provenance kind "unknown" instead of "url-reader" in
  found_jobs.json. Cosmetic provenance-label drift; the adapter itself is
  correctly registered as a url-reader. [fix status: deferred — budget; add
  the source id (or map ids via adapterKind) to SOURCE_STRING_KIND]
- [search/adapters/apify.js] [none] Billing-aware: billed run-sync calls retry
  ONLY on 429 (isRetryableBilledRun) so a timeout never re-bills; token sent as
  Bearer header, stripped from error URLs; result cache; maxActorsPerRun cap.
  Matches the known Apify-billing gotcha. No defects. apifyBilling tests green.
- [search/adapters/workday.js] [none] Page-size clamped to CXS max 20; MAX_PAGES
  cap; pod-level host gate; detail-fetch failures aggregated into one degraded
  note. No defects (lines 300+ validated via workdayThrottling/searchAdapters
  suites, green).
- [search/normalize.js] [minor] `jobFromJsonLd` sourceJobId:
  `str(node.identifier?.value ?? node.identifier)` can yield "[object Object]"
  for PropertyValue objects without `.value`. Harmless to identity (dedup key
  uses company+title) but ugly in stored data. [fix status: deferred — budget]
- [search/deduplicator.js] [none] company+title primary key (deliberate,
  documented), URL secondary key with tracking-param stripping, richer-JD
  winner. exists_in_db predicate honored. No defects. Tests green.
- [search/freshnessFilter.js] [none] Default LAST_7_DAYS confirmed; ALL maps to
  Infinity (credentialManager.js:135-140) — no silent 7d fallback; undated jobs
  never mixed into kept; fallback widens only from stricter-than-3d windows.
  Matches README exactly. Tests green.
- [search/discoveryFilter.js] [none] Permissive, non-destructive, config-driven.
  No defects.
- [scoring/exclusionFilter.js] [none] Category order matches docs; clearance
  allowance honored; US-only gate word-boundary-matched with US markers winning;
  unknown locations deferred, never discarded. No defects. Tests green.
- [scoring/sponsorshipClassifier.js] [none] SAFETY-CRITICAL (review-only).
  Returns exactly Confirmed/Likely/Unconfirmed from config phrases +
  willingToSponsor flag; never emits "No" (exclusions handle denial upstream).
  Contract matches README. No change proposed.
- [scoring/scorer.js + explainScore.js] [none] 13 categories, weights from
  config, normalized 0–100, deterministic; tier thresholds read from
  scoring.tiers; gate downgrades Apply/Priority → Queue and records
  sponsorshipGated. Matches README. Tests green (140 incl. guards).
- [dashboard/data.js isSponsorshipGated] [minor] Gate re-derivation hardcodes
  `score >= 75` (with a comment saying it deliberately mirrors gradeFromScore
  to cover historical rows without a migration) instead of reading
  scoring.tiers.apply. If tiers.apply is ever changed in config, the dashboard
  flag drifts. [fix status: flagged-for-human — proposed change: thread
  `scoring.tiers.apply` into data.js (default 75) or persist sponsorshipGated
  at scoring time; both touch the sponsorship-adjacent surface, so left to you]
- [resume/tailor.py] [none] Master opened read-only, saved only to a new path
  with an explicit refuse-to-overwrite-master check; fail-closed truth
  invariants (text multiset, node identity, protected order, styles,
  duplicates); gaps reported, never inserted; rewrites hard-disabled; focus
  line opt-in (off by default, matches README). Exemplary. Validated by the
  end-of-session pytest run.
- [apply/coverLetter.js] [minor] Word-count enforcement trims to `max` only;
  the config `wordCount.min` (180) is never enforced, so a sparse
  profile/template could emit a shorter letter than the README's documented
  180–260 range. [fix status: deferred — budget; low harm, letter is always
  human-reviewed in the packet]
- [apply/applicationPacket.js] [none] `submitReady: false` and
  `stopBeforeSubmit: true` set on creation (lines 110–111); formPrefill also
  always returns submitReady: false. Matches README.
- [apply/approvalQueue.js] [none] Single choke point; idempotent re-prepare
  resets to pending_review (re-approval required); approve/reject fail loudly
  on unknown ids; isClearedForAssist requires explicit human approval. No
  defects.
- [automation/applyRunner.js + guards.js] [none] SAFETY-CRITICAL (review-only).
  Verified: `options.autoSubmit === true` per-run opt-in with short-circuit
  (lines 246–249); clean-form preconditions (zero blockers, truthful
  sponsorship, required fields, confident unique submit selector, daily cap);
  write-ahead SUBMITTING checkpoint prevents double-click on crash;
  verifySubmission required before recording submitted, else
  submit_unverified (never silently counted). guards.js: strong blocking
  phrases always block; weak widget tokens block only on thin dedicated
  challenge pages; login URL hints boundary-matched; never evades.
  scripts/verifyRepoHealth.js asserts the gate patterns exist. No change
  proposed. (README's name `applyRunner.tryAutoSubmit` refers to the inner
  closure at line 248 — accurate.)
- [dashboard server + frontend] [blocker→fixed] See Finding A. Also reviewed
  deriveAppStatus precedence (submitted only via applied=1; truthfulness rule
  upheld), buildNextActions ordering (submit_unverified first), fitBucket
  gated-Queue→strong rationale. No further defects.
- [reports/reportGenerator.js] [none] Pure summarize/renderCsv/renderHtml,
  atomic writes, tolerant keyword parsing. Covered by reportGenerator tests.

## Step 3 UI/UX + docs (batched)

- [dashboard/frontend] [minor] Header "found/posted in last 24h" (rolling
  window) sits beside "Daily progress" (calendar days) with no distinction —
  reads as a bug. CONFIRMED intentional: header uses discoveredLast24h /
  postedLast24h rolling counters; daily strip buckets by dayOf(created_at).
  [fix status: FIXED — tooltips added to both header stats; daily card retitled
  "Daily progress (last 7 calendar days)" with explanatory tooltip.]
- [README] [minor] Letter-grade badge undocumented. Bands confirmed in
  gradeFromScore (src/dashboard/data.js:124): A ≥85, B ≥75, C ≥65, D ≥50,
  F <50; recommend=true for C and up. [fix status: FIXED — documented in
  README's Score row. Whether the grade should exist at all remains a product
  call; it is consistent with tier thresholds at the A/B boundaries (85/75).]
- [README] [minor] Finding B "Unclassified" bucket documented (see above).

## Not reviewed (out of budget-priority, no findings implicating them)

- src/cli/* (guided flow, doctor, watch), src/apply/platforms/*,
  src/automation/{browser,domScanner,fieldFiller,fieldResolver,navigator,
  uploadRunner}.js internals beyond the submit path, src/logging/*,
  src/utils/* beyond those read, scripts/* except verifyRepoHealth. All are
  covered by the passing full suites below.

## Flagged for human decision (no unilateral changes made)

1. src/dashboard/data.js:91 `isSponsorshipGated` — hardcoded 75 vs
   scoring.tiers.apply (proposed: read config with 75 fallback, or persist the
   flag at scoring time).
2. src/apply/coverLetter.js — enforce wordCount.min (proposed: pad by NOT
   dropping optional paragraphs below min, or log a warning blocker on the
   packet when under min).
3. Whether the batch "▶ Auto-apply" header button should also exclude
   sponsorship-gated jobs from its "actionable" set server-side (the per-job
   CTA and confirm-guard are fixed; the batch path still relies on the
   server-side auto-submit eligibility check only for the submit variant).
   → RESOLVED in Round 2 (frontend batch filter; see below).

## Round 2 (2026-07-13, same session)

- [README / test baseline] [minor] Test-count discrepancy resolved: verdict
  **(a) — the 563 JS / 40 Python baseline in README was already stale before
  this audit started.** Evidence: the audit made zero commits; `git diff
  --stat` (working tree vs HEAD) shows only README.md (+8/-2),
  src/dashboard/public/index.html (+17/-3), and a 1-line assertion update in
  tests/node/workbenchUi.test.js; `git diff --stat -- '*.test.js'
  '*test*.py'` shows that single line as the ONLY test change and zero Python
  changes. All 68 JS test files (706 tests) and 7 Python test files (52
  tests) already existed at HEAD — the counts drifted across the recent
  feature commits (da89889 workbench/application-safety overhaul, 12696dd
  opt-in auto-submit, 4309c91 discovery acceleration) whose tests were added
  without updating the Build status line.
  [fix status: FIXED — README Build status line now reads 706 JS + 52 Python.]
- [dashboard/frontend + approvalQueue] [none] Item 2 — confirm-approval
  persistence for the gated per-job auto-apply: the `confirm()` in
  `autoApplyOne()` is a client-side gate on whether the POST fires, but the
  action it authorizes IS persisted through the compliance choke point: the
  server's auto-apply orchestration calls `approveJobPacket(db, jobId)`
  (src/dashboard/server.js:558) → `approvalQueue.approve()`
  (src/dashboard/data.js:869-874), which writes `approved_by_user = 1` and
  `approved_at` to the approval_queue table — the same audit trail as every
  other approval. A cancelled confirm fires no action and correctly leaves no
  record. [fix status: no fix required — verified persisted;
  apply/dashboardServer suites green]
- [dashboard/frontend] [major] Item 3 — batch Auto-apply gate bypass (same
  class as Finding A, batch surface): `batchAutoApply()` built its
  `actionable` set from appStatus alone, so sponsorship-gated undecided jobs
  selected via checkboxes rode into the batch prepare→approve→fill chain.
  [fix status: FIXED — gated jobs with no explicit user decision
  (`sponsorshipGated && !userDecision`, mirroring the per-job fix) are now
  excluded from `actionable`, reported in the confirm dialog's skip note, and
  produce a "verify sponsorship first" toast when nothing else is actionable.
  Shortlisting after verification re-enables them, consistent with the
  documented flow.]
- Round 2 scoped validation: workbenchUi, dashboardServer, dashboardData,
  apply (approvalQueue coverage), autoApplyEligibility,
  workbenchReconciliation — 6 files, 145/145 passed.

## Round 3 (2026-07-13, same session) — decided fixes + regression tests

- [dashboard/data.js] [minor→fixed] Flagged item 1 implemented as proposed:
  `isSponsorshipGated` no longer hardcodes 75. New `setApplyTierThreshold()`
  (validated, fail-safe) is synced from `config.scoring.tiers.apply` at
  dashboard startup (src/dashboard/server.js createDashboardServer). Default
  remains 75, so historical behavior is unchanged until config is retuned.
- [apply/coverLetter.js] [minor→fixed] Flagged item 2 implemented as proposed:
  a letter under `wordCount.min` is FLAGGED, never padded (padding would
  fabricate filler claims). `generateCoverLetter` now returns
  `belowMinWordCount` + a human-readable `warnings` entry; content untouched.
- [tests] Added tests/node/round3Regressions.test.js (8 tests): threshold
  default/retune/fail-safe behavior; under-min letter flagging; and markup
  regression pins for the Round 1 per-job gate CTA, the confirm-guard, and
  the Round 2 batch-set exclusion.
- Validation: round3Regressions + dashboardData + dashboardServer +
  coverLetter + workbenchUi — 114/114 passed. (One transient all-files
  "no tests" vitest startup flake immediately after the test file was
  written; identical re-run passed. Not reproducible, not a code issue.)

## Phase 2 / Track A — coverage-gap reviews (2026-07-13)

- [cli/guided.js + commands.js + applyOneByOne.js + watch.js + preflight.js +
  doctor.js + ui.js + app.js] [none] Approval selections parsed defensively
  (dedup, range-clamp); non-TTY runs stop at the approval gate with guidance;
  runRescore protects human-acted rows; recordAssistResult has a defensive
  truthfulness guard (a `submitted` claim without positive verification is
  downgraded to submit_unverified, and a failed submitted-write throws loudly);
  watch mode clamps intervals to ≥5 min, warns about per-cycle Apify billing,
  and offers --free-only; doctor never auto-fills profile gaps. Scoped tests:
  65/65 green.
- [apply/platforms/*] [none] SAFETY-ADJACENT (reviewed flag-only, nothing to
  flag): every descriptor's prepare() hard-codes `submitReady: false` +
  `stopBeforeSubmit: true`; Workday deliberately declines a submitSelector
  because its bottom-nav control is reused across steps (the live runner
  identifies the final control by text instead). Selector accuracy against
  live tenants is untestable offline by design — fixture suites pass (14/14).
- [automation/browser,domScanner,fieldFiller,fieldResolver,navigator,
  uploadRunner] [none] domScanner is read-only and skips
  hidden/submit/password inputs; fieldFiller matches select/radio/combobox
  options with whole-word rules (a 2-letter "No" can never match inside
  "acknowledge") and caps combobox auto-pick at short values; navigator never
  clicks controls matching SUBMIT_RE and only accepts "Apply now" on fieldless
  landing pages; uploadRunner re-reads the live FileList to verify attachments
  persist; fieldResolver verifies filled values survive React re-renders.
  46/46 green.
- [logging/db.js + jobLogger.js] [none] upsertJob is column-whitelisted with
  named parameters (no SQL injection surface); migrations are additive and
  idempotent; WAL + busy_timeout + checkpoint-on-open; listJobsSummary
  excludes jd_text for board queries; indexes already present on
  status/tier/score/source/posted_at/created_at/applied (Track B input).
  Logger redacts secrets before both sinks. 17/17 green.
- [utils/*] [none except below] dates are UTC-deterministic and never
  fabricate; textNormalize whole-word matching escapes regex meta; retryHandler
  honors Retry-After and records attempts on the thrown error; fsSafe writes
  temp+rename atomic; httpClient composes caller AbortSignals with its timer;
  hostGate keys politeness by host/Workday-pod with a non-retryable circuit
  breaker; failureRca prefers hard status evidence over prose heuristics.
  88/88 green.
- [utils/outputPaths.js] [minor] `DEFAULT_CANDIDATE_NAME = 'Atresh Somayajula'`
  is hardcoded as a fallback for when config is unreadable — bends the
  "profile values are never hardcoded in source" README principle. Harmless
  (used only for artifact filename prefixes when candidate.json is missing)
  but worth aligning: fall back to 'Candidate' instead.
  [fix status: flagged-for-human — cosmetic vs. principle call]
- [scripts/*] [minor] cleanup/migrate/cleanJobDescriptions/regenerateResumes
  are dry-run by default with an explicit --apply; dbMaintenance is
  read-mostly. `repair-applied-status.mjs` is the exception: it UPDATEs
  immediately with no dry-run flag (narrow, truth-restoring repair —
  applied=1 rows whose status was clobbered get status='submitted' back — and
  it prints before/after rows). Inconsistent with the house convention.
  [fix status: deferred — add a --apply gate to match the other scripts]
- Out-of-scope note: src/apply/{atsDetector,fileUpload,formPrefill,humanizer,
  screeningQA,applicationState}.js were not in this track's listed scope and
  remain unreviewed (they are exercised by the passing apply/applicationState/
  applicationResume suites).
- Track A close: full suites 714/714 JS + 52/52 Python, green.

## Phase 2 / Track B — performance baseline (2026-07-13)

Full numbers in PERF_BASELINE.md. Summary:
- [dashboard/data.js] [major] At 27,343 jobs (238 MB DB), initial dashboard
  load cost ≈19 s of server compute: dashboardStats ~14 s + boardPage ~4.8 s,
  recomputed every 30 s cache bucket; stats and board each ran the same ~8 s
  listJobsSummary query independently. [fix status: partially fixed —
  listSummaryRows memoized through the existing cached() layer (allowed
  class: memoizing a repeated computation; no query/data-model change).
  Measured: initial load ≈19 s → ≈9.7 s, within-bucket repeats ~0 ms.
  105/105 dashboard tests green.]
- [dashboard/data.js] [flagged-for-human] Remaining bottleneck proposals P1
  (slim stats SELECT, est. → ~2-3 s), P2 (invalidate-on-write cache instead
  of 30 s TTL), P3 (archive closed rows) — all in the needs-approval class
  (query/data-model/cache-policy restructuring). Written up in
  PERF_BASELINE.md; NOT implemented.
- [logging/db.js] [minor] No index on jobs.sponsorship (SQL filter would full
  scan). Currently a non-bottleneck (dashboard filters in JS). Index changes
  are in the needs-approval class — noted, not added.
- Discovery per-source timing: not measured live (an Apify discovery run
  bills real money; logs held no durations). perSource durationMs is captured
  at runtime — harvest from the next organic run.
- Resume tailoring: ~0.4-0.6 s/job measured with the real master resume —
  not a bottleneck.

## Round 5 — approved perf work P3→P1→P2 built (2026-07-13)

Full numbers + design in PERF_BASELINE.md ("Round 5" section). Summary:
- [logging/db.js] [fixed] P3 as a STATUS FLAG (`archived_at`, NULL = hot) on
  the jobs table — no row moves, so the Round-1-verified dedupe guarantee
  holds structurally: every "already known" check still sees archived rows
  (pinned by test). Flag derived from the exact closed-set the board already
  hides; applied rows never archive; re-activation clears it. Sponsorship +
  archived indexes added in the same idempotent migration with a one-time
  backfill (26,417 of 27,343 rows archived).
- [dashboard/data.js + db.js] [fixed] P1: stats read a slim 14-column
  all-rows projection (totals stay truthful at 27,343); board/exports/
  documents route hot vs archived explicitly.
- [dashboard/data.js] [fixed] P2: cache key is now
  `data_version:total_changes` — pure invalidate-on-write, no 30 s TTL.
  Cross-connection writes (repair-applied-status.mjs, which still mutates by
  default on its own connection; watch CLI) invalidate via PRAGMA
  data_version — verified by a real two-connection test, plus upsert/
  decision/approval write-path tests and a cache-hit reference-equality test.
- Measured: stats cold 14.4 s → 1.56 s; board cold 4.8 s → 27 ms; warm reads
  0 ms with no TTL; initial dashboard load ≈19 s → ≈1.6 s.
- [dashboard] [fixed] Track C items built on request: #7 board search now
  matches private notes; #4 sponsorship-gated undecided rows show a
  "⚠ verify" chip in the table (carries Finding A into the board). Items
  #1/#6 (tile tooltips, submit_unverified tile) remain proposals — the tile
  renderer doesn't use the assumed labels, and editing it blind wasn't
  justified.
- [tooling note] Twice this session the FIRST vitest run immediately after
  creating a new test file failed at import ("no tests", all files) and the
  identical re-run passed — environment flake (Windows file-lock/transform
  cache race), not a code issue.
- Validation: full suites 727/727 JS + 52/52 Python.

## Final audit closure (2026-07-14)

- [search/normalize.js] [major→fixed] The deferred JSON-LD identifier cleanup
  called a missing `jsonLdIdentifier` helper, breaking manual URL ingestion and
  all generic/LinkedIn/Indeed/Dice JSON-LD readers. Added a conservative union
  parser for scalar, PropertyValue, array, `@value`, and `@id` shapes; object
  identifiers without a usable value now become an empty id, never
  `[object Object]`. The 14 failing tests are restored and union shapes are
  regression-tested.
- [apply/atsDetector.js] [minor→fixed] ATS host detection used substring
  matching, so hosts such as `fakegreenhouse.io` could be misrouted to the
  Greenhouse adapter. Matching now requires an exact host or real subdomain
  boundary and ignores URL ports.
- [apply/fileUpload.js] [minor→fixed] A directory named `*.pdf` could enter the
  upload plan, and a race/permission error from `statSync` escaped as an
  exception. Upload planning now requires a regular file and reports inspection
  failures as blockers.
- [apply/screeningQA.js + humanizer.js] [minor→fixed] Public helpers could throw
  when optional screening configuration or text was omitted. Both now fail
  closed (`ask_user` / no banned content) without guessing or crashing.
- [apply/applicationState.js] [major→fixed] The runner correctly refused to
  reopen `submitting`/`verifying` checkpoints, but the low-level transition API
  still allowed backward transitions. The invariant is now enforced at the
  state-machine boundary while forward verification transitions remain legal.
- [utils/outputPaths.js] [minor→fixed] Removed the hardcoded personal-name
  fallback. Missing candidate configuration now yields the privacy-safe
  `Candidate` filename prefix; configured names are unchanged.
- [search/sources.js] [minor→fixed] Added and regression-pinned provenance
  mappings for `generic-public-pages` (`url-reader`) and `manual-url`
  (`manual`).
- [scripts/repair-applied-status.mjs] [minor→fixed] Confirmed the maintenance
  repair is dry-run by default and only mutates with `--apply`; added a real
  temporary-SQLite subprocess test for both modes.
- Final validation: repository health verifier passed against 28,010 jobs;
  115 JavaScript modules passed syntax checks; 732/732 JavaScript tests and
  52/52 Python tests passed; production `npm audit` found 0 vulnerabilities;
  live dashboard HTML/stats/jobs/reports/learn endpoints returned HTTP 200 with
  CSP headers, while forged Host and cross-site Origin requests returned 403.
