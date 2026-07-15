# AUDIT_PLAN — job-agent end-to-end audit (2026-07-13)

Trigger: "Find jobs" / discover action. Budget: 40 tool calls. Review order below;
one pass per module, findings appended to AUDIT_LOG.md.

## Pre-verified findings (Step 0.5, done before this plan was finalized)

- **Finding A (blocker, confirmed):** `nextBestAction()` in
  `src/dashboard/public/index.html` (~line 671) never consults
  `j.sponsorshipGated` / `j.sponsorship`. Strong-fit gated jobs (e.g. 82/B,
  Queue-by-gate) get "⚡ Auto-apply" as the featured CTA. The gate is enforced
  only server-side for the *auto-submit* variant (`autoApplyEligibility.js:84`);
  a plain auto-apply (fill) proceeds regardless. UX-level gate bypass → fix:
  gated jobs surface "Verify sponsorship" as the primary action.
- **Finding B (confirmed, category (a) — intentional but undocumented):**
  "Unclassified" originates at `src/dashboard/data.js:573`
  (`job.sponsorship ?? 'Unclassified'`). `classifySponsorship()` only runs in
  the score path (`src/pipeline/index.js:212`, `src/cli/commands.js`), so jobs
  that were discovered-only, or discarded by exclusions before classification,
  legitimately have no sponsorship value. The classifier itself always returns
  Confirmed/Likely/Unconfirmed. Fix: document the fourth dashboard bucket in
  README; no code bug.

## Modules in scope, in review order

Search/discover path first (trigger is "Find jobs"):

1. `src/search/index.js` + `sources.js` — risk: source orchestration swallowing
   per-source failures too broadly; concurrency/cancellation bugs.
2. `src/search/adapters/*` (greenhouse, lever, ashby, workday, smartrecruiters,
   apify, manualUrls CSV, genericPublicPage JSON-LD) — risk: field-mapping
   drift, JSON-LD parse edge cases, CSV quoting, Apify billing (memory: Apify
   bills per discovery run — keep disabled in test configs).
3. `src/search/normalize.js` — risk: unstable job IDs → dedupe collisions;
   date parsing producing wrong postedAt.
4. `src/search/deduplicator.js` — risk: ID collision keeping the poorer JD;
   EXCLUDE_ALREADY_APPLIED toggle inverted.
5. `src/search/freshnessFilter.js` — risk: window math off-by-one; undated
   jobs leaking into fresh results (README says never mixed); default must be
   LAST_7_DAYS (memory: freshness default 7d).
6. `src/search/discoveryFilter.js` — risk: over-filtering before scoring.
7. `src/scoring/exclusionFilter.js` — risk: substring false positives ("us"
   markers), clearanceAllowance not honored.
8. `src/scoring/sponsorshipClassifier.js` — reviewed in Step 0.5; risk:
   affirmative-phrase false positives. SAFETY-CRITICAL: flag-only.
9. `src/scoring/scorer.js` + `explainScore.js` — risk: weight normalization
   ≠ 0–100; tier thresholds (85/75/60/50) drift; gate derivation must track
   `tiers.apply` (memory).
10. `src/resume/tailor.py` — risk: writing to master resume; fabricating
    content; focus line on when config off.
11. `src/apply/coverLetter.js` + `applicationPacket.js` + `approvalQueue.js` —
    risk: word-count bounds, `submitReady` not false, queue status drift.
12. `src/automation/applyRunner.js` + `guards.js` — SAFETY-CRITICAL
    (auto-submit eligibility, CAPTCHA/MFA/login guards, verified-submission
    check): review + flag only, no auto-fix.
13. Dashboard (`src/dashboard/server.js`, `data.js`, `public/index.html`) —
    Finding A lives here; risk: CTA/tile logic diverging from tier gate;
    rolling-24h vs calendar-day window confusion (Step 3 item).
14. `src/reports/reportGenerator.js` — risk: empty-run report crashes.

## Step 3 (UI/UX pass, batched)

- Fix Finding A CTA.
- Label "rolling 24h" vs "calendar day" windows.
- Document letter-grade bands + "Unclassified" bucket in README (single edit).

## Test policy

Scoped test run once per module after its fixes; full `npm test` +
`npm run test:py` exactly once at the end.

## Phase 2 / Track A — close the coverage gap (budget: 30 calls)

Excluded per cross-track rules: applyRunner.js, guards.js, all modules marked
[none] in AUDIT_LOG. Fix tiers as in Round 1; apply/platforms/* field-mapping
or submission-adjacent logic is flag-only.

1. src/cli/* (app, applyOneByOne, commands, doctor, guided, preflight, ui,
   watch) — risk: interactive approval prompts mis-parsing selections
   (approve-all vs approve-none), doctor false-positives, watch loops.
2. src/apply/platforms/* (_base, ashby, generic, greenhouse, icims, jobvite,
   lever, smartrecruiters, taleo, workday, index) — risk: stale CSS selectors,
   wrong field→value mapping (esp. sponsorship/work-auth questions),
   platform detection misrouting. FLAG-ONLY for mapping/submission-adjacent.
3. src/automation/{browser,domScanner,fieldFiller,fieldResolver,navigator,
   uploadRunner} — risk: navigator clicking unsafe controls it thinks are
   safe; fieldFiller writing to wrong inputs; upload verification gaps.
4. src/logging/{db,jobLogger} — risk: schema/migration drift, SQL injection
   via string-built queries, event-log loss on crash.
5. src/utils/* not yet read (concurrency, dates, failureRca, fsSafe,
   hostGate, httpClient, json, notifier, outputPaths, rateLimiter,
   retryHandler, textNormalize) — risk: date parsing (postedAt formats),
   retry/backoff unbounded, atomic-write gaps.
6. scripts/* except verifyRepoHealth — risk: destructive maintenance scripts
   (cleanup/migrate/repair) lacking dry-run guards.

Note: src/apply/{atsDetector,fileUpload,formPrefill,humanizer,screeningQA,
applicationState}.js are NOT in this track's listed scope and stay unreviewed
unless a finding implicates them.

## Phase 2 / Track B — performance (see PERF_BASELINE.md)

Baseline measured; summary-query memoization implemented (19 s → 9.7 s initial
load). Proposals P1/P2/P3 await human approval — no query/data-model/cache
policy changes made.

## Phase 2 / Track C — dashboard enhancement candidates (PROPOSAL ONLY)

Each item is grounded in the current src/dashboard/public/index.html +
data.js; none are implemented. Awaiting an explicit pick.

1. (S) Window-labeling completeness — extend the Round 1 rolling-vs-calendar
   tooltips to the remaining mixed-convention stats: "submitted this week" is
   a rolling 7×24h window (data.js), "prepared/submitted/discovered today"
   are calendar-day, "new qualified" is rolling-24h-posted. One tooltip each.
2. (M) Batch decision endpoint — batchDecide() fires one sequential POST per
   selected job (index.html ~1124); 50 selected jobs = 50 round-trips, no
   progress. Mirror the existing /api/approve-batch as /api/decision-batch.
3. (S-M) Narrow-viewport audit of the detail panel + compare view — the grid
   collapses at 1180/900px, but the keyword-chip lists, 7-step stepper, and
   3-job compare table have no overflow containment below 900px; wrap wide
   content in overflow-x:auto and spot-check at ~380px.
4. (S) Row-level sponsorship-gate chip — gated jobs read "strong fit" in the
   table with only the generic sponsorship chip; carry Finding A's fix into
   the board by showing a "⚠ verify" chip on gated undecided rows.
5. (S/M) Stats-loading skeleton — a cold /api/stats still costs ~9 s at 27k
   jobs; the header/tiles render nothing meanwhile. S: loading state. M:
   stale-while-revalidate serving of the previous stats bucket (overlaps
   Track B P2 — needs that approval).
6. (S) Promote submit_unverified to a tile — it is the top-priority next
   action and safety-relevant (never silently counted as applied), but check
   it has no dedicated always-visible tile the way blocked/ready/pending do;
   add one with hot styling when count > 0.
7. (S) Search private notes — notes are saved per job and exported to CSV,
   but verify whether the board's q= search matches them; if not, include
   notes in the search predicate so users can find their own reminders.
8. (S) Consolidate duplicate CSV exports — the header "Reports ▾" menu and
   the reports drawer offer the same two exports with different labels;
   unify the wording or keep one entry point.
