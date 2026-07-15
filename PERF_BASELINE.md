# PERF_BASELINE — job-agent (2026-07-13, Phase 2 / Track B)

Environment: Windows 11, Node v25.7.0, local SQLite via node:sqlite.
Volume: **27,343 jobs** (238 MB DB file; ~124 MB of that is `jd_text`,
avg ~4.8 KB/job), 155,696 application_events.

## Step 1 — measured baseline (before any change)

### Dashboard load / render (server-side query cost at 27k jobs)

| Operation | Time |
| --- | --- |
| `listJobsSummary()` raw (27k rows × ~40 cols, ORDER BY score) | **8,209 ms** |
| `dashboardStats()` COLD (compute) | **14,426 ms** |
| `dashboardStats()` "WARM" | **12,922 ms** (cache miss — 30 s bucket expired mid-test) |
| `boardPage()` default filters, cold | **4,768 ms** |
| `boardPage()` warm (rows cache hit) | 2 ms |
| `boardPage(q='engineer')` warm | 20 ms |
| `jobDetail()` one job | 17 ms |

Initial dashboard load therefore paid ≈ **19 s** of server compute
(stats + board), and every expiry of the 30-second cache bucket re-paid
≈ 13–14 s for stats. Frontend render itself is not the constraint — the
board renders only 200 rows.

### SQLite indexes / query plans

Indexes present: status, tier, score, source, posted_at, created_at, applied
(+ events.job_id, approval_queue.job_id). Plans confirm they are used
(`ORDER BY score` → idx_jobs_score; `tier=?` → covering index).
**No index on `sponsorship`** (`WHERE sponsorship=?` → full scan) — but the
dashboard filters sponsorship in JS over the summary rows, not in SQL, so
this is currently a non-bottleneck.

### Discovery / search pipeline

Not re-measured live: a real discovery run bills the Apify account per run
(known billing gotcha), and existing logs contain no per-source durations to
mine. Per-source `durationMs` IS recorded at runtime (perSource in the run
status/RCA panel); capture it from the next organic "Find New Jobs" run
instead of paying for a synthetic one.

### Resume tailoring (python-docx, real master + 4.9 KB JD)

runs: 638 ms / 378 ms / 413 ms → **~0.4–0.6 s per job**. Only strong matches
are tailored (a handful per run) — not a bottleneck.

## Step 2 — actual bottlenecks (ranked) and proposals

1. **`dashboardStats` recompute (~13–14 s) on a 30 s cache bucket** —
   dominates perceived dashboard latency; at 27k jobs the server can spend
   ~45% of its time recomputing stats.
2. **`listJobsSummary()` (~8 s) executed independently by the stats AND
   board-rows computations** — same rows, paid twice per bucket.
3. **Full-table decoration passes** — `boardRow()` + per-view predicates over
   all 27k rows on every recompute (~5–6 s of the stats cost).

### Implemented now (low-risk, allowed class: memoizing a repeated computation)

- Memoized `listSummaryRows()` through the existing `cached()` layer so
  stats + board rows share ONE summary query per cache bucket (any DB write
  invalidates via `total_changes()`, same as the existing caches).
  **Measured after:** stats cold 9.3 s, boardPage-after-stats 0.4 s (was
  4.8 s), stats warm-in-bucket 0 ms. Initial load ≈ 19 s → **≈ 9.7 s**;
  within-bucket repeat loads effectively free. 105/105 dashboard tests green.

### Proposed, NEEDS YOUR APPROVAL (data-model / query / cache-policy changes)

- **P1 — trim the stats query (biggest remaining win, est. 9.3 s → ~2-3 s):**
  `computeDashboardStats` needs ~15 of the ~40 summary columns; the heavy
  ones (`explanation`, `matched_keywords`, `missing_keywords`,
  `assist_blockers`) are never read by stats. A dedicated slim SELECT (or
  dropping those columns from `listJobsSummary` and lazy-loading them in
  `jobDetail`) restructures queries → your call.
- **P2 — lengthen or version the cache bucket:** 30 s TTL forces a full
  recompute twice a minute even when nothing changed; keying on
  `total_changes()` alone (invalidate-on-write, no time bucket) would make
  idle dashboards free. Changes cache semantics (a second PROCESS writing the
  DB wouldn't bump this connection's total_changes) → your call.
- **P3 — archive closed rows out of the hot table** (discarded/rejected jobs
  are the bulk of 27k; board default hides them anyway). Data-model change →
  your call.
- Smaller/deferred: sponsorship index (only useful if SQL-level filtering is
  ever adopted); SQL-level pagination + list virtualization (large change,
  flagged not built); events-table pruning (155k rows, only queried per-job
  and indexed — fine today).

**Stopping here per Track B rules — nothing in the proposal list is
implemented without an explicit pick.**

## Round 5 — P1 + P2 + P3 approved and built (measured, same methodology)

Design decisions:
- **P3 = status flag, not a table move.** `jobs.archived_at TEXT` (NULL = hot),
  derived from the same closed-set the board already hides (user
  archived/rejected, or pipeline-discarded with no human decision; applied
  rows never archive), synced on every job write and cleared when a row
  becomes active again. Rows never leave the `jobs` table, so
  existsInDb/getKnownJobIds/getAppliedJobIds/getActiveJobUrls see archived
  jobs unchanged — the dedupe guarantee holds with zero search-path changes
  (regression-tested). Sponsorship + archived indexes added in the same
  migration; one-time backfill archived 26,417 of 27,343 rows.
- **P1 = `listJobsStats()`**: slim 14-column, all-rows projection for stats
  (tile totals stay truthful); board rows use the hot-only summary, with
  closed-status views/exports/documents explicitly opting into the archived
  set.
- **P2 = invalidate-on-write cache**: key = `PRAGMA data_version` (other
  connections' commits — watch CLI, repair-applied-status.mjs, any second
  process) + `total_changes()` (this connection). No time bucket. Verified by
  tests for upsertJob, setUserDecision (incl. archival sync), approval-queue
  writes, and a genuine cross-connection write; unchanged data is served from
  cache indefinitely (reference-equality asserted 10 simulated minutes later).

| Operation | Baseline | After Track B memo | After Round 5 |
| --- | --- | --- | --- |
| dashboardStats COLD | 14,426 ms | 9,250 ms | **1,556 ms** |
| boardPage default COLD | 4,768 ms | 403 ms | **27 ms** |
| warm reads (no writes) | 12,922 ms / 2 ms | 0 ms (30 s TTL) | **0 ms, no TTL** |
| hot summary query | 8,209 ms | 8,209 ms | **198 ms** (926 hot rows) |
| slim stats query (27,343 rows) | — | — | **334 ms** |
| closed-view fetch (explicit, rare) | — | — | 715 ms |
| one-time migration on open | — | — | 20.9 s (once) |

Initial dashboard load: **~19 s → ~1.6 s**. Validation: 727/727 JS
(incl. tests/node/round5PerfModel.test.js: archival semantics, dedupe
hard-constraint, cross-connection invalidation) + 52/52 Python.
