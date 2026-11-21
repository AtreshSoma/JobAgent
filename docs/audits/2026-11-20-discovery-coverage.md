# Discovery coverage audit: why Microsoft and other major employers are missing

Date: 2026-11-20. Branch `main` at `f75a16d` plus the uncommitted working tree.
Nothing in `src/` or `config/` was changed. Evidence comes from three places:

- the live store `data/profiles/<active profile>/applied_jobs.db` (opened read-only, 82,850 rows);
- the last two full runs in `logs/run-80689714-….log` (2026-11-16) and `data/source_timings.json`;
- live requests made today with the agent's own User-Agent (`DISCOVERY_USER_AGENT`), one request at a time, public endpoints only, robots.txt checked.

## 1. Short answer

There are three causes, in order of impact:

1. **Most major employers are not configured at all.** Microsoft, Apple, Google, IBM, Cisco, Netflix,
   Qualcomm, Morgan Stanley, Fidelity, UnitedHealth, Boeing, Disney and about 25 others have zero rows in the
   store. A note in `config/jobboards.json` (dated 2026-08-05) and the Eightfold entry in
   `src/search/platforms.js:191` record Microsoft and others as having "no public static feed". **That is no longer
   true.** Microsoft, Apple, Netflix, Qualcomm, Morgan Stanley and UnitedHealth all publish job sitemaps
   that robots.txt allows. 19 more are on Workday and answer the same endpoint the agent already uses.
2. **The discovery window throws away jobs at companies that are configured.** A posting the agent has not seen
   before is admitted only if it was posted inside the window (3 days in the recorded runs). Anything first seen
   on day 4 or later is written as `stale` and is never judged again. In the last run that dropped **56,330 of
   60,532 jobs (93%)**. Of **1,839** data-engineering/BI-titled postings in the store, **1,715 were discarded as
   stale** and **33** reached the board. Examples: Accenture "Lead Data Engineer", "Microsoft Fabric Data
   Engineer", "Senior Data Engineer".
3. **The sitemap adapter barely reads the sites it is pointed at.** It keeps the first 50 URLs in sitemap
   order, with no title, location or date filter (`careersPage.js:36,205`). Four of its seven companies
   (Capgemini, EY, KPMG, Wipro) have never produced a dated job, so every row was dropped as
   "unknown posting date".

## 2. Company coverage, verified

### 2.1 Missing employers, with a working route confirmed today

| Company | Store rows | Route (verified live 2026-11-20) | Notes |
| --- | --- | --- | --- |
| **Microsoft** | 0 | `https://apply.careers.microsoft.com/careers/sitemap.xml` → 2,446 job URLs (1,368 US). Job pages carry `JobPosting` JSON-LD with `datePosted`. | robots.txt: `Allow: /careers`. API (`/api/apply`, `/api/pcsx`) still 403/429, so we don't use it. Matching US roles include "Senior Data Engineer – Redmond", "Principal Data Engineering Architect", Fabric/data-platform architect roles. |
| **Apple** | 0 | `https://jobs.apple.com/sitemap/sitemap-jobs-en-us.xml` → 4,537 US job URLs; details from `https://jobs.apple.com/api/v1/jobDetails/{jobNumber}` (JSON: title, locations, `postDateInGMT`, qualifications). | No JSON-LD on the HTML page, so it needs a small detail reader. robots.txt redirects to a 404 page, so there are no rules. Matching roles: "Sr Data Engineer – iCloud Insights", "Sr Analytics Engineer – Retail Data Products", "Data Engineering Manager – Finance Data". |
| **Netflix** | 0 | `https://explore.jobs.netflix.net/careers/sitemap.xml` → 443 URLs | Eightfold, same layout as Microsoft. |
| **Qualcomm** | 0 | `https://careers.qualcomm.com/careers/sitemap.xml` → 2,069 URLs, JSON-LD with `datePosted` | robots.txt: `Allow: /careers`. |
| **Morgan Stanley** | 0 | `https://morganstanley.eightfold.ai/careers/sitemap.xml` → 1,138 URLs; also Workday `ms.wd5.myworkdayjobs.com / External` (193 hits for "data engineer") | Workday is simpler. |
| **UnitedHealth / Optum** | 0 | `https://careers.unitedhealthgroup.com/sitemap.xml` → 6,546 `/job/` URLs, JSON-LD with `datePosted` | robots.txt disallows only `/search-jobs/`. The registry note says TalentBrew has no sitemap, which is wrong for this site. |
| **Starbucks** | 0 | `https://apply.starbucks.com/careers/sitemap.xml` → 21,994 URLs | Mostly retail; add only with the slug filter (§3, D3). |
| **Snowflake** | 0 | Ashby board `snowflake` (`api.ashbyhq.com/posting-api/job-board/snowflake` → 200) | One-line config add. |
| Cisco | 0 | Workday `cisco.wd5.myworkdayjobs.com / Cisco_Careers` (1,242) | The 42 "Cisco" rows in the store are UCSF ("San Francisco"), not Cisco. |
| HP Inc | 0 | Workday `hp.wd5 / ExternalCareerSite` (371) | |
| Broadcom (incl. VMware) | 0 | Workday `broadcom.wd1 / External_Career` (205) | |
| Boeing | 0 | Workday `boeing.wd1 / EXTERNAL_CAREERS` (719) | |
| Disney | 0 | Workday `disney.wd5 / disneycareer` (5) | Low hit count: check the site name. |
| Fidelity | 0 | Workday `fmr.wd1 / FidelityCareers` (186) | |
| Cigna | 0 | Workday `cigna.wd5 / cignacareers` (115) | |
| Elevance Health | 0 | Workday `elevancehealth.wd1 / ANT` (36) | |
| Vanguard | 0 | Workday `vanguard.wd5 / vanguard_external` (139) | |
| Home Depot | 0 | Workday `homedepot.wd5 / CareerDepot` (150) | |
| Lowe's | 0 | Workday `lowes.wd5 / LWS_External_CS` (70) | |
| Nike | 0 | Workday `nike.wd1 / nke` (117) | |
| Micron | 0 | Workday `micron.wd1 / External` (2,388) | |
| Applied Materials | 0 | Workday `amat.wd1 / External` (1,157) | |
| KLA | 0 | Workday `kla.wd1 / Search` (1,110) | |
| Analog Devices | 0 | Workday `analogdevices.wd1 / External` (685) | |
| eBay | 0 | Workday `ebay.wd5 / apply` (201) | |
| 3M | 0 | Workday `3m.wd1 / Search` (266) | |

Workday counts are the endpoint's `total` for `searchText: "data engineer"`. Workday search is fuzzy, so this is
how many results it returned, not how many match.

### 2.2 Missing, route not confirmed yet

| Company | What was tried | Next step |
| --- | --- | --- |
| Dell, Comcast, Lam Research, Expedia, Charles Schwab, Kaiser Permanente, American Express, John Deere | Guessed Workday site names returned HTTP 422 (tenant probably exists, site name wrong) | Resolve the real site name from each careers page with `extractCoordinate()` (plan task 3.2). |
| IBM | `POST https://www-api.ibm.com/search/api/v2` (the careers site's own search) returned 3,520 hits | New adapter; check robots.txt for `www-api.ibm.com` first. |
| Uber | Old `loadSearchJobsResults` endpoint now answers "Missing RPC handler" | Investigate. |
| Goldman Sachs | No sitemap at `higher.gs.com` | Manual URLs for now. |

### 2.3 Not reachable within policy

| Company | Reason |
| --- | --- |
| Google | robots.txt disallows `/about/careers/applications/jobs/results` (listing and every job page under it). |
| Tesla | 403 on the careers sitemap. |
| LinkedIn-hosted roles | By design, LinkedIn is a URL reader only (`sources.js`). |

For these, the compliant routes are `manualUrls` / CSV import, or a licensed aggregator. `adzuna-aggregator`
is disabled (it needs an API key). Both Apify sources are disabled because the token has expired (HTTP 401).

### 2.4 Configured employers, for comparison

Configured companies do show up in volume (NVIDIA 1,030 rows, Citi 1,215, JPMorgan 959, Salesforce 834) but
almost none survive. NVIDIA, Salesforce, Oracle and Citi each have **0** rows kept, mostly because of D1 below.

## 3. Findings

Severity: **P0** loses relevant jobs in bulk · **P1** loses a whole company or source · **P2** smaller or latent.
**C** = confirmed with data or a live request · **L** = likely, from reading the code, not reproduced.

| ID | Sev | | Finding | Evidence | Where |
| --- | --- | --- | --- | --- | --- |
| D1 | P0 | C | **The discovery window is based on posting age, not on whether the agent has seen the job.** A posting not already stored is admitted only if `postedAt` is within the window. If a job was missed during its first N days (no run that day, a source error, a new company added, a skipped page), it is stored as `stale` and never judged again. Only `scored`/`needs_description` rows are retained. | Run 2026-11-16: `LAST_3_DAYS`, kept 4,202, dropped 56,330. Store: 1,715 of 1,839 relevant titles discarded as stale; 346 of them only 4–14 days old. Runs on Nov 15–16, then Nov 20, so a 4-day gap. | `pipeline/index.js:303-315`, `RETAINED_STATUSES` `:1055`, `freshnessFilter.js` |
| D2 | P0 | C | **Major employers are missing from config, and the notes explaining why are out of date.** | §2.1. The `company-careers` note (`jobboards.json` ~line 2408) lists Microsoft, Amazon, Google, Apple and others as "rejected". `platforms.js:191` marks Eightfold as not enumerable "by policy". | `config/jobboards.json`, `src/search/platforms.js` |
| D3 | P0 | C | **The sitemap strategy reads the first 50 URLs in file order** (hard ceiling 200), with no title, location or `<lastmod>` filter. Meta lists thousands of jobs; the store holds 125 Meta rows, mostly non-US or unrelated. Without this fix, adding Microsoft (2,446 URLs) or UnitedHealth (6,546) would yield almost nothing. | Meta 125 rows / 0 kept; Capgemini sitemap has about 7,000 job URLs and the store holds 145 Capgemini rows. | `careersPage.js:36-37,205` |
| D4 | P1 | C | **Sitemap jobs with no posting date are always dropped.** SuccessFactors/RMK and some other pages carry no JSON-LD date; `includeUnknownDateJobs` defaults to false, so these go nowhere. `<lastmod>` is not a posting date (EY shows one crawl date for everything, `changefreq daily`). | Capgemini 145, EY 119, Wipro 70, KPMG 19 rows: 100% without `posted_at`. | `careersPage.js`, `freshnessFilter.js`, `credentialManager.js:192` |
| D5 | P1 | C | **The platform registry is wrong for Eightfold and TalentBrew.** Eightfold tenants expose `/careers/sitemap.xml` and robots.txt allows `/careers`. TalentBrew (UnitedHealth) has a job sitemap. The harvester and detection therefore never suggest these employers. | §2.1 probes | `platforms.js:191-213` |
| D6 | P2 | L | **Board-fingerprint skipping can hide a new posting until it is outside the window.** If a board's total and first page are unchanged (one job closed, one opened), later pages are skipped until the next full sweep (`FULL_SWEEP_DAYS = 3`). By then a 3-day window has passed and D1 discards the job. | Code reading. Fixing D1 removes most of the effect. | `boardFingerprints.js:22`, Workday/other adapters |
| D7 | P2 | C | Workday "Posted 30+ Days Ago" is stored as exactly 30 days. 17,914 rows read "posted 30 day(s) ago" when the real age is unknown and 30 or more. With a 30-day window they would be wrongly admitted. | Store discard reasons | `workday.js:830-870` |
| D8 | P2 | C | **Nothing reports coverage.** A source that returns 0 jobs for a company still counts as `ok`. Nothing compares coverage against the employers you care about. The careers source returning 282 jobs from 7 large employers raised no warning. | `source_timings.json` | `search/index.js`, dashboard health |
| D9 | P2 | C | 2,183 rows are stuck in `needs_description` ("not judged: description never fetched"). Workday reads 20 full descriptions per tenant per run. 26 of these rows have relevant titles. | Store | `workday.js:89`, enrichment |
| D10 | P2 | C | No scheduled run is configured, so with a narrow window, missed days lose jobs (see D1). | Runs on 11-15, 11-16 and 11-20 only | `src/cli/schedule.js` exists but is unused |

Window setting: the recorded runs used `LAST_3_DAYS`. Neither `data/settings.json` nor `.env` exists now, so the
code default (`LAST_7_DAYS`) would apply to the next run. D1 still applies at any window size, and rows already
written as stale stay that way.

## 4. Implementation plan

Order: fix the gate first (D1), because every coverage gain after that is otherwise mostly thrown away. Each
phase ends with tests and a measured before/after on the live store.

### Phase 0: Measurement harness (½ day)

- 0.1 Add `config/coverage_targets.json`: about 100 employers you care about, each with `name`, `aliases`, and
  the expected route (`workday`, `sitemap`, `ashby`, …) or `unreachable` plus a reason.
- 0.2 Add `scripts/coverageAudit.mjs`, read-only. For each target it reports: configured (yes/no), rows in the
  last complete run, rows kept, the dominant discard reason, and when it was last seen. It also prints the
  relevant-title funnel shown in §1 (found → stale → undated → excluded → surfaced).
- 0.3 Save today's output as the baseline in `docs/audits/2026-11-20-discovery-coverage/baseline.json`.

Acceptance: running the script against the current store reproduces the numbers in this document.

### Phase 1: Discovery window based on first sighting (D1, D6, D10), 1–2 days, P0

- 1.1 **Per-source effective window.** For each source:
  `effectiveWindow = max(configuredWindow, daysSince(lastCompleteRun(source)) + 1)`.
  `data/source_timings.json` already records each run's time and `ok` flag; use the last entry with
  `ok && !cached`. A source with **no** complete run yet (a newly added company) uses the retention window
  (`exclusions.staleness.skipOlderThanDays`, 45). Pass `effectiveWindowBySource` into `applyFreshnessFilter`
  (`freshnessFilter.js`) and log it in the `freshness_filtered` event.
- 1.2 **Never-seen check before the age check.** In `pipeline/index.js:303-315`, a job with no stored row is new
  to the agent. Apply 1.1 to it. A job whose stored row is a `stale:` discard and whose `posted_at` is still
  inside retention is re-admitted when its source's effective window covers it, instead of skipping it as
  "unchanged".
- 1.3 **One-time re-judging.** Add `npm run rejudge-stale`, which re-scores stored rows with
  `discard_reason LIKE 'stale:%'` whose posting date is within retention and whose title fits the profile
  (`titleFitPriority`). Batch it, make it resumable, and dry-run by default.
- 1.4 **Fingerprint sweep shorter than the window.** Set `FULL_SWEEP_DAYS` to at most `min(window, 2)`, or force a
  full walk when `effectiveWindow > configuredWindow`.
- 1.5 **Schedule.** Document and default `npm run schedule` to a daily run. After 1.1 this becomes a
  convenience; jobs are no longer lost when a day is skipped.
- Tests: `tests/node/freshnessFilter.test.js` covering a 6-day gap with a job posted 5 days ago (admitted) and a
  job posted 9 days ago (dropped). A new source with a job posted 30 days ago (admitted under 45-day retention).
  Pipeline test: a stale row is re-admitted once the window covers it.
- Acceptance: on the live store, `rejudge-stale` (dry run) lists the Accenture data-engineering roles above as
  eligible. The share of relevant titles surfaced rises from 33 / 1,839.
- Cost check: 1.1 widens the window only by the gap since the last complete run, so the 92%-drop performance
  benefit holds for daily runs.

### Phase 2: Sitemap discovery that scales (D3, D4), 2–3 days, P0

- 2.1 **Filter on the slug before fetching.** In `careersPage.js` `fromSitemap`, turn each URL slug into a
  title-like string (`/job/1970…-senior-data-engineer-united-states-washington-redmond` → "senior data engineer
  united states washington redmond"). Keep it only if `titleFitPriority(slug, profileVocab) ≥ 1` and, when
  `usOnly`, if it contains a US signal (`utils/usGeography.js`) or no country at all.
- 2.2 **Order and skip what's known.** Sort the remaining URLs by `<lastmod>` descending. Skip URLs whose job id
  is already stored and unchanged. Apply `maxLinksPerCompany` to the *filtered* list; raise the default to 150
  and the ceiling to 500.
- 2.3 **Undated jobs: use "new since the last complete crawl".** Record the set of job URLs per sitemap in
  `board_fingerprints.json`. On later crawls, a URL that was not there last time is new by definition. Give it
  `postedAt = firstSeenAt` with `postedAtSource: 'first_seen'` (shown as "date unknown, first seen …") so it is
  scored instead of dropped. On a sitemap's first crawl, undated jobs go to the existing unknown-date review
  bucket, not the board.
- 2.4 **Eightfold support** (Microsoft, Netflix, Qualcomm, Morgan Stanley, Starbucks). Take the job id from
  `/careers/job/{id}-{slug}`. JSON-LD parsing already works. Keep the `?domain=` parameter.
- 2.5 **Apple.** Add a small `jobDetails` strategy (or `adapters/appleJobs.js`): sitemap `sitemap-jobs-en-us.xml`
  → filter slug (2.1) → `GET /api/v1/jobDetails/{jobNumber}` → normalize `postingTitle`, `locations`,
  `postDateInGMT`, `description` + qualifications. Use the shared rate limiter and host gate.
- Tests: fixtures for an Eightfold sitemap, an Apple sitemap with a detail JSON, and a SuccessFactors sitemap
  without dates (use fictional companies, as in the existing fixtures). Unit tests for slug→title, the US filter,
  `<lastmod>` ordering and first-seen dating.
- Acceptance: a Microsoft entry yields the US data/BI roles listed in §2.1 within the per-company budget.
  Capgemini, EY, KPMG and Wipro stop being 100% undated after their second crawl.

### Phase 3: Configuration and registry (D2, D5), ½–1 day, P1

- 3.1 Add the 19 verified Workday sites from §2.1 to `workday-public.tenants`, plus Snowflake to `ashby-boards`.
  Add Microsoft, Apple, Netflix, Qualcomm and UnitedHealth to `company-careers` once Phase 2 lands. Starbucks
  is optional (mostly retail).
- 3.2 Add `scripts/resolveCareersSite.mjs`: given a careers URL, fetch it once, find the ATS link or body marker
  with `detectPlatform()` / `extractCoordinate()` (`platforms.js`), and print a ready-to-paste config entry. Use
  it for Dell, Comcast, Lam Research, Expedia, Schwab, Kaiser, AmEx and Deere.
- 3.3 Correct the out-of-date notes: the `company-careers` note in `jobboards.json`, the `eightfold` entry
  (`enumerable: true` via sitemap, keeping the note that the JSON API is off-limits) and the `phenom`/TalentBrew
  entry in `platforms.js`. Add `/careers/sitemap.xml` as the Eightfold enumeration hint so the harvester suggests it.
- 3.4 Add a validation test so every `coverage_targets.json` entry with a route is configured or explicitly waived.

### Phase 4: New routes for the remaining majors, 1–2 days, P1/P2

- 4.1 IBM: check robots.txt for `www-api.ibm.com`. If allowed, add `adapters/ibmCareers.js` on the public search
  API (query-first, like `amazonJobs`).
- 4.2 Uber, Goldman Sachs: investigate their current public surfaces. Until then, list them as `manualUrls`
  targets in `coverage_targets.json`.
- 4.3 Google and Tesla: record them as `unreachable` with the reason; document the manual/CSV route in
  `docs/USER_GUIDE.md`.
- 4.4 Optional: re-enable `adzuna-aggregator` with a key for cross-employer breadth, and refresh `APIFY_TOKEN`
  or remove those sources.

### Phase 5: Monitoring and smaller fixes (D7, D8, D9), 1 day, P2

- 5.1 Report a zero-yield **company** (not just a zero-yield source) as a warning in the run summary and the
  dashboard health panel. The `coverageAudit` funnel becomes a dashboard card.
- 5.2 Workday "30+ Days Ago": store `postedAtApprox: 'lowerBound'` and show "30+ days". The age gate treats it as
  older than any window under 30 days, and as unknown for wider windows.
- 5.3 `needs_description` backlog: let enrichment carry the remaining budget across runs and order by title fit,
  so relevant rows are read first.

### Effort and order

| Phase | Effort | Unblocks |
| --- | --- | --- |
| 0 | ½ d | Measured before/after for everything else |
| 1 | 1–2 d | Jobs at already-configured employers (largest single gain) |
| 2 | 2–3 d | Microsoft, Apple, Netflix, Qualcomm, UnitedHealth; fixes the existing sitemap companies |
| 3 | ½–1 d | 20 more major employers on existing adapters |
| 4 | 1–2 d | IBM and the rest |
| 5 | 1 d | Keeps coverage from silently decaying again |

## 5. Limits of this audit

- I did not start a discovery run. A dashboard run was in progress (`data/.run.lock`, phase `discover`) while
  this was written.
- Store numbers come from rows written by the 2026-11-15/16 runs. Stale counts include some non-US postings,
  because the age gate runs before the location check and the location verdict isn't stored for those rows.
- The Workday `total` values are fuzzy search counts, not exact matches.
- Sites can change quickly. Re-run the probes (Phase 0 script) before implementing Phase 3.

## 6. Implementation status (2026-11-20)

All five phases are implemented in the working tree, uncommitted. Baseline before any fix:
[`2026-11-20-discovery-coverage/baseline.json`](2026-11-20-discovery-coverage/baseline.json)
(`npm run coverage:audit -- --json`).

| Finding | Change | Where |
| --- | --- | --- |
| D1 | Per-source catch-up window: widened to the time since that source's last **complete** listing; an employer the source has never listed gets the retention window for stated/adjacent titles (`BACKFILL_MIN_TITLE_FIT = 3`). Kept per profile. | `src/search/sourceCoverage.js`, `freshnessFilter.js` (`windowFor`), `pipeline/index.js`, `search/index.js` (tags `rawMetadata.sourceId`) |
| D1 | One-time repair `npm run rejudge-stale` (dry run by default). On a copy of the live store: **444** stale rows re-admitted, **396** relabelled with their real reason (374 non-US, 22 role mismatch). | `src/pipeline/rejudgeStale.js`, `scripts/rejudgeStale.mjs` |
| D2 | Added 19 Workday sites, Snowflake (Ashby), Dell (Oracle on its own domain, `CX_1001`), Charles Schwab (iCIMS), and sitemaps for Microsoft, Apple, Netflix, Qualcomm, UnitedHealth Group, Comcast, Kaiser Permanente, John Deere. Out-of-date notes rewritten. | `config/jobboards.json` |
| D3 | Sitemap strategy filters URLs by slug (title fit ≥ 2, US-only gate) before fetching; ranks by fit, then `<lastmod>`; reuses or skips pages already stored; budget 150 per employer per run after filtering. | `src/search/adapters/careersPage.js` (`planSitemapUrls`, `slugText`) |
| D3 (new) | **Id collisions on pages without JSON-LD**: every Wipro posting had the id `careers:job details wipro limited` and overwrote the last; same-title Costco postings merged. The id now uses the URL's posting number; page-title suffixes are stripped. | `careersPage.js` (`ensureCareersIdentity`) |
| D4 | Undated sitemap postings that are new since the previous crawl are dated `first_seen`. | `src/search/sitemapSeen.js` |
| D5 | Registry: Eightfold and TalentBrew notes corrected with sitemap hints (`sitemapFor`); Oracle Recruiting is recognized on employer domains (`vanityPath`). | `src/search/platforms.js` |
| D6 | Covered by D1: a run that skipped pages is not "complete", so the window spans the time since the last full sweep. | `boardFingerprints.js` (comment) |
| D7 | Workday "30+ Days Ago" is marked `postedAtLowerBound`; the reason reads "30+ day(s)"; catch-up/backfill never admit it. | `workday.js`, `freshnessFilter.js` |
| D8 | Zero-yield employers (complete source run, no postings) are logged, stored per profile and shown in *Discovery and data quality*. `config/coverage_targets.json` (100 employers) + test that each routed one is configured + `npm run coverage:audit`. | `src/search/coverageTargets.js`, `dataQuality.js` (server + client), `scripts/coverageAudit.mjs` |
| D9 | No change needed in enrichment (already ordered by status, title fit and date, with attempts tracked). Fixed the gap in the new sitemap planner: an active careers row with no stored description is re-read instead of skipped. | `careersPage.js` |
| New | **Uncaught crash in `safeFetch` on redirects with a body** ("Controller is already closed", reproduced on jobs.dell.com and careers.lamresearch.com). `safeFetch` carries every Workday request and every careers page. Redirect bodies are now drained, not cancelled. | `src/utils/safeFetch.js` |
| Tools | `npm run resolve-careers -- <url> [--verify]` prints a config entry for an employer's board or job sitemap. | `scripts/resolveCareersSite.mjs` |

Live check (2026-11-20, 8 pages per employer): Microsoft returned "Principal Data Engineering Architect" and
"Senior Data Engineer" (Redmond) first; Apple returned eight dated data-engineering roles (Cupertino/Sunnyvale);
UnitedHealth Group returned "Senior Data Engineer" ×3 and "Principal Data Engineer – Remote". The new Workday,
Oracle and iCIMS entries were verified with one request each; they first appear after the next discovery run.

Re-checked and moved to `manual`: IBM (`careers.ibm.com` answers HTTP 202 with an empty body to every page,
including its robots-listed sitemap), Lam Research and Expedia (no board or sitemap found by the resolver),
American Express (careers page unreadable). Phase 4.1's IBM adapter was therefore not built.

Not done, by design: no scheduler was installed (`npm run schedule -- --install` is yours to run); the
changelog is generated at release from `changelog-data.js`; `rejudge-stale --apply` was not run against your
store.
