# Source / ATS support matrix

Honest, evidence-backed capability statement. **Fixture-tested** means a vitest
suite drives the capability against local fixtures (never a live site, never a
real application). **Manually verified** means a human confirmed it against a
live site at least once — absence of that mark means NOT VERIFIED live.
Anything not listed is unsupported: the agent stops safely and reports RCA
rather than guessing.

Legend: ✅ supported · ◐ partial/limited · ❌ unsupported by design · — n/a

## Discovery sources

Sources divide into two kinds, and the distinction decides what they can find:

- **Company-first** (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, careers
  pages) enumerate one configured board at a time. Deep on the boards you list,
  blind to every employer you have not listed.
- **Query-first** (atsSearch, Adzuna, Apify) search *across* employers for a
  title. This is the only way to find a company you have never heard of, and
  `scripts/harvestSources.mjs` feeds what they find back into the company-first
  board lists so the coverage compounds.

| Source | Kind | On by default | Discovery | Detail extraction | Limitations | Fixture-tested |
| --- | --- | --- | --- | --- | --- | --- |
| Greenhouse | company-first | yes | ✅ public board API | ✅ JD + `first_published` posted date | board token must be configured | ✅ `searchAdapters`, `dataQualityRegressions` |
| Lever | company-first | yes | ✅ public postings API | ✅ | company slug must be configured | ✅ `searchAdapters` |
| Ashby | company-first | yes | ✅ public posting API | ✅ | org slug must be configured | ✅ `ashbySmartrecruiters` |
| SmartRecruiters | company-first | yes | ✅ public company API, paged via `offset` | ✅ | company id must be configured | ✅ `ashbySmartrecruiters` |
| **Workable — all companies** | query-first | yes | ✅ public search API (`jobs.workable.com/api/v1/jobs`) | ✅ full JD inline, no detail fetch needed | OR-matches query terms → phrase-quoted + title-gated client-side; ranks by RELEVANCE and honors no sort param → `day_range` (default 7) is the only recency lever | ✅ `atsSearch` |
| **SmartRecruiters — all companies** | query-first | yes | ◐ public search API, newest 100 per query | ◐ optional budgeted fetch via public Posting API | server ignores `offset` (no pagination) **and ignores every country param** → country enforced client-side; newest-first ≠ fresh on niche titles (89% of rows measured over a year old) → `maxAgeDays` enforced client-side | ✅ `atsSearch` |
| **Adzuna** | query-first | no (needs a free key) | ✅ official aggregator API, free key — **verified live 2026-08-01** | ✅ `full_description` when present | `what_phrase` matches anywhere in the posting body, not just the title (a bare "Data Engineer" query returned 31,148 hits) → same client-side title gate atsSearch uses; ~1,000 calls/month; apply URL must stay `redirect_url` per their terms | ✅ `adzuna` |
| Workday | company-first | yes | ◐ public CXS job feeds, searched with phrases derived from `candidate.targetTitles` | ✅ | tenant/site must be configured; some tenants block unauthenticated feeds → per-source RCA; `limit` >20 and any offset past `total` return nothing | ✅ `searchAdapters`, `workdaySearchTerms`, `workdayJobUrl` |
| iCIMS | company-first | yes | ✅ server-rendered portals, 54 configured | ✅ | portal markup varies by tenant; some tenants login-wall the portal itself | ◐ covered by `searchAdapters` |
| Rippling | company-first | yes | ✅ public board API, 29 configured | ✅ | board slug must be configured | ◐ covered by `searchAdapters` |
| Amazon Jobs | company-first | yes | ✅ public `search.json`, covers the whole amazon.jobs family | ✅ employer read per posting | single employer family; no board configuration needed | ◐ covered by `searchAdapters` |
| Oracle Recruiting | company-first | yes | ◐ public candidate REST API, 41 tenants configured | ◐ | Producing: 7,984 rows in a live store between 2026-09-22 and 2026-11-10 (this line said 0 rows until 2026-11-10). Still no dedicated fixture, so a parser regression would not be caught by tests | ❌ no dedicated fixture |
| The Muse | query-first | yes | ◐ cross-company board | ◐ aggregator URLs, tagged so the UI asks for a direct link | low yield (117 rows); listings link onward rather than to the employer ATS | ◐ covered by `searchAdapters` |
| Company career pages | company-first | yes | ◐ JSON-LD (`JobPosting`) + sitemaps | ✅ where JSON-LD present | no JSON-LD → no extraction (reported, not guessed) | ✅ `discoveryCoverage`, `careersPageHardening` |
| LinkedIn — direct | — | no (paste URLs) | ◐ public `/jobs/view/` URLs you provide | ✅ JSON-LD | ❌ query/feed search — login-walled, and the unauthenticated `jobs-guest` endpoint third-party scrapers use answers **404** (probed 2026-08-01). Reaching it needs evasion, which is refused with an explanatory error | ✅ `directSourceAdapters` |
| Indeed — direct | — | no (paste URLs) | ◐ public posting URLs you provide | ✅ JSON-LD | ❌ query search — `/jobs?q=` returns **403** (Cloudflare) and the Publisher API host no longer resolves (both probed 2026-08-01) | ✅ `directSourceAdapters` |
| Dice — direct | — | no (paste URLs) | ◐ public posting URLs you provide | ✅ JSON-LD | ❌ query search — `job-search-api.svc.dhigroupinc.com` returns **403**, legacy `api.dice.com` **404** (probed 2026-08-01) | ✅ `directSourceAdapters` |
| LinkedIn / Indeed / Dice / Glassdoor — via Apify provider | query-first | no (needs your Apify token) | ✅ query-based through YOUR Apify account + actors | ✅ actor output mapped to normalized jobs | **billed per run** — a free-plan monthly cap silently stops every actor until the cycle resets (surfaced as `quota_exhausted`); actor schema changes surface as RCA (`schema_changed`) | ✅ `searchAdapters` provider mappings, `apifyBilling` |
| Manual CSV / Add-by-URL | — | yes | ✅ | ✅ | you supply the data | ✅ `cliCommands`, `dashboardServer` |
| Staffing/recruiting portals | — | — | ◐ reachable via atsSearch, Apify actors, or public URLs | ✅ where JSON-LD/API exists | no dedicated adapters | ◐ covered by the paths above |

Measured baseline (2026-08-01, 492 configured boards, Apify excluded because its
quota was spent): **71,827 unique jobs, 20,574 cross-source duplicates removed,
0 errors, 14.2 minutes**. Of those, 1,062 were posted in the last 24h and 11,824
within a week. Workday accounts for ~60% of the wall clock.

### Run time and cancellation

**Skipping unchanged boards (audit D1, Workday only so far).** Each Workday tenant search records its total and first page. When both match the last run, only the first page is read. A full sweep reads every page every 3 days. A run that skipped pages is recorded as not a full listing, so the expiry pass (which retires rows a source stopped listing) never counts it; a board whose walk had an error is not remembered. Other adapters read everything as before. Tested in `boardFingerprints` with a fake board; the speed-up has not been measured on a live sweep.

Two things dominated a discovery run's wall clock and its responsiveness, both
fixed by measurement rather than guesswork.

**Pod-gate spacing was the bottleneck, not concurrency.** `hostKeyFor`
deliberately collapses every Workday tenant onto its shared pod, and the gate
applied BOTH a concurrency ceiling and a 500ms minimum between request starts.
Because the gate serializes starts, the spacing won outright: all tenants on a
pod shared **2 requests/second** regardless of how high concurrency went, which
made `boardConcurrency` inert. 87 of the configured tenants sit on `wd1` alone,
at ~14 requests each — a ~609-second floor. A measured run spent **602s in
Workday out of 629s total (96%)**. The knob was tuned when 14 tenants were
configured, where it never bound; it did not scale with the board list.

Probed directly against `wd1` (24 distinct tenants, escalating concurrency, no
added spacing, aborting on the first throttle):

| concurrency | throughput | p50 | p95 | throttles |
| --- | --- | --- | --- | --- |
| 4 | 3.7 req/s | 914ms | 2946ms | 0 |
| 8 | 6.6 req/s | 801ms | 1843ms | 0 |
| 16 | 9.6 req/s | 849ms | 1866ms | 0 |

Latency did not degrade as concurrency rose, so the gate was ~5x more
conservative than the pod tolerates. `maxConcurrent` alone is the honest bound —
it caps simultaneous load, which is what a server experiences — and Retry-After
handling plus the circuit breaker remain the safety net, reacting to real
throttling instead of guessing. Settings are now 8 in flight, no added spacing.
**Measured on the same 30 tenants: 498s → 97s, a 5.1x speedup, 0 errors, same
job count.** Source-level `hostConcurrency`/`hostSpacingMs` were also previously
unreachable (the global default was read first), so tuning them did nothing.

**Do not raise these further.** Two later experiments settled it. Narrower
search phrases were tested as a way to fetch less: they are *worse*, costing
more requests per on-target job on three of four large tenants (Citi 1.07
on-target/request with the current two phrases vs 0.57 with eight narrow ones),
so the existing phrase strategy is already near-optimal. And after several
heavy load experiments in quick succession, `wd1` began throttling: the same
30-tenant run that had returned 11,563 jobs with 0 errors on a rested pod
returned 1,063 jobs with 293 errors and 23 throttle responses. The circuit
breaker and Retry-After handling absorbed it correctly and the pod answered
normally again after a pause — but it is direct evidence that these hosts do
enforce limits, and that 8 in flight with no added spacing is at a sensible
edge rather than comfortably below one. A single ordinary run measures ~0.3%
request errors. Further speed has to come from `maxPagesPerTerm` (an explicit
coverage trade), not from more concurrency.

**Cancelling took ~30 seconds.** Cancel was cooperative polling only
(`shouldCancel`, checked between operations), so a request already on the wire
ran to completion or to its `requestTimeoutMs` (30s), and every request already
queued behind a pod gate was still dialled — hundreds of them. There is now a
per-run `AbortSignal`: in-flight fetches abort and gate-queued work is dropped
(`RunCancelledError`). A cancellation is labelled, non-retryable, not counted as
a host fault, and not reported as a per-request failure — stopping a run is not
an error, and it used to emit one RCA line per dropped request.
**Measured stop latency against live network work: 123ms (was ~29,000ms)**, with
results already found kept.

Discovery-wide guarantees (tested): cross-source dedup by company+title and
normalized URL (`deduplicator`), incremental skip-unchanged
(`incrementalDiscovery`), truthful last-24h (`dates`,
`workbenchReconciliation`), per-source failure isolation + partial-run RCA
(`runRca`), retry/backoff + rate limiting (`retryHandler`, `rateLimiter`),
cancellation (`jobs_cancelled`), and an identifying (never browser-imitating)
`User-Agent` on outbound discovery requests (`httpClient`).

### Source harvesting

`scripts/harvestSources.mjs` mines every job URL already in the database for the
ATS board it came from, validates each against that vendor's public API, and
merges the live ones into `config/jobboards.json` (dry run by default; `--apply`
writes, after taking a timestamped backup). Extraction and merging are pure and
fixture-tested (`sourceHarvest`); only the liveness probe touches the network.

This is what stops discovery from resetting every month: a board found once via
a metered query-first source becomes permanent, free, unmetered coverage.

### Freshness on cross-company search (measured)

A cross-company search index is not a live board. Nothing obliges an employer to
close a filled requisition, so dead ones accumulate and still match on title —
they are indistinguishable from live postings by title alone, and each one that
reaches the pipeline costs a tailored resume and an application. Two controls,
because the two providers fail differently:

| | Workable | SmartRecruiters |
| --- | --- | --- |
| Ranking | relevance (no sort param exists — `sort`, `sort_by`, `sortBy` all probed, all ignored) | newest-first |
| Recency control | `dayRange` → server-side `day_range` | none offered → client-side only |
| Unbounded result | postings up to 192 days old | 89% over a year old, oldest from 2014 |

`dayRange` (default 7) is not just a filter — widening it *displaces* fresh jobs,
because relevance ranking spends the fixed page budget on a larger corpus.
Measured over 17 real target titles at 5 pages each: `dayRange=7` returned 145
jobs of which 137 were under a week old, while `dayRange=30` returned 197 of
which only 76 were. Fewer total, nearly twice the recent ones.

`maxAgeDays` (default 180) is a separate hard ceiling applied to both providers.
It is deliberately loose — a zombie guard, not a freshness filter, since genuine
requisitions stay open for months and deciding what counts as "recent" belongs to
the pipeline's freshness stage, which can see every source at once. Undated rows
are kept and routed to the undated-review bucket.

Combined effect on a live run: median posting age fell from 3,482 days to 5.5,
and rows over a year old from 189 to 0.

### Reaching LinkedIn / Indeed / Dice without Apify

Asked and answered with live probes on 2026-08-01 — **you cannot**, and the
blocker is the vendors, not this codebase:

| Endpoint | Result |
| --- | --- |
| `linkedin.com/jobs-guest/jobs/api/seeMoreJobResults` | 404 |
| `indeed.com/jobs?q=` | 403 (Cloudflare) |
| `api.indeed.com` (Publisher API) | host no longer resolves |
| `job-search-api.svc.dhigroupinc.com` (Dice) | 403 |
| `api.dice.com` (legacy Dice) | 404 |

All three are reachable only by defeating a login wall or bot protection. That
is the one thing this project will not do, so Apify — which runs actors under
your own account and accepts the terms on your behalf — stays the only route to
their *search*. Individual posting URLs you paste in are always fine.

Keyless aggregators were measured as substitutes and rejected on yield, not
principle: Arbeitnow returned 3 on-target rows of 175 (predominantly Germany),
and Remotive 0 of 34. Adding them would cost requests and add noise.

The Muse also returned nothing on target in that first probe. It was added to
cross-company search later, with its categories taken from the active profile's
role families, and it is enabled by default; it remains low-yield (see its row
in the discovery table).

**Adzuna** is the one keyed aggregator worth enabling — it supports
`max_days_old=1`, which is exactly the last-24h question. It ships disabled,
because without `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` it can return nothing: add
a free key to `.env` and set `enabled: true` on `adzuna-aggregator` in
`config/jobboards.json` (verified live, see above).

Worth keeping in perspective: of the employers Apify ever surfaced, 96% had
never been seen by any free source, so this is genuine lost breadth rather than
duplicate coverage. `harvestSources` is the mitigation — every employer Apify
finds once can be promoted to a permanent free board.

### Workday: derived search phrases

Company-first sources normally need no query — you enumerate the board. Workday
is the exception: its public CXS feed is a search endpoint, so *something* must
be typed into it, and that something used to be the literal string
`"data engineer"` copy-pasted onto every tenant. Adding a target title to
`candidate.json` changed nothing.

Phrases are now derived from `candidate.targetTitles` by `deriveSearchTerms`, so
the profile is the single source of truth. Two measured properties of the
endpoint shape the algorithm:

- **It narrows as tokens are added** — fuzzy-AND, not OR. On one tenant: `data`
  115 hits, `engineer` 57, `data engineer` 51, `data engineer bi` 27, and a
  nine-word "cover everything" phrase **0**. So each derived phrase is capped at
  the trailing two significant tokens of a title, and a long phrase is the worst
  possible query.
- **It is fuzzy enough to reach sibling titles** — `data engineer` surfaced
  `Senior Business Intelligence Engineer`. Across 12 tenants a single phrase
  recovered every on-target title but three, all `ETL Developer` /
  `Analytics Engineer` variants sharing `developer`/`analytics` rather than
  `data`/`engineer`.

So the problem is a small set cover: the fewest phrases such that every target
title shares a token with one of them. For the 17 real titles that is
`["data engineer", "bi developer"]` — the second phrase closing exactly the gap
the hardcoded string left. Results from all phrases are merged and de-duplicated
before detail enrichment, so the per-tenant detail budget is spent once per job.

Override with `searchTexts` (source or tenant) or cap with `maxSearchTerms`. A
tenant that sets `searchText: ""` still means "enumerate everything".

### Compliance notes on the query-first sources

- Every endpoint is the unauthenticated JSON its vendor's own public job-search
  site calls. No login, no CAPTCHA solving, no bot-protection bypass, and the
  `User-Agent` names this tool rather than imitating a browser.
- `jobs.workable.com/robots.txt` permits `/api/` (it disallows only `/search*?*`,
  `/profile*` and company-login paths) and advertises
  `Content-Signal: search=yes, ai-input=yes`.
- `jobs.smartrecruiters.com` serves no robots directives.
- `api.smartrecruiters.com/robots.txt` is a blanket `Disallow: /` aimed at
  search-engine indexing. It is the officially documented public Posting API and
  the company-first SmartRecruiters adapter already depends on it; the optional
  full-JD enrichment in atsSearch is opt-out via `fetchDetails: false`.
- Adzuna's terms require sending the user to the advertiser through
  `redirect_url`; the adapter uses it verbatim and never resolves past it.

## ATS application filling

| ATS | Auto-fill | Multi-step nav | Uploads (verified attached) | Verified submission | Known limitations | Fixture-tested |
| --- | --- | --- | --- | --- | --- | --- |
| Greenhouse | ✅ adapter + semantic resolver; detected by host **or** a `gh_jid=` query on an employer's own careers page | ✅ | ✅ `input-file-list` check; documents matched to inputs **by label** on both classic and current `job-boards.greenhouse.io` markup | ✅ confirmation-evidence gate | embedded-iframe boards handled | ✅ `atsApplicationFixtures`, `embeddedFormAutomation`, `uploadInputSelection` |
| Lever | ✅ | ✅ | ✅ | ✅ | — | ✅ `atsApplicationFixtures` |
| Ashby | ✅ | ✅ | ✅ | ✅ | — | ✅ `atsApplicationFixtures` |
| Workday | ✅ (`data-automation-id` selectors); ◐ work history and education entries ("Add" per job and degree, read back) on a hand-written fixture | ✅ | ✅ | ✅ | account-creation/login walls stop the run (by design); the repeated-section filler has not run on a live Workday tenant | ✅ `atsApplicationFixtures`, `workdayFormFill`; ◐ `repeatedSections` (hand-written, **not captured from a live site**) |
| SmartRecruiters | ✅ | ✅ | ✅ | ✅ | — | ✅ `atsApplicationFixtures` |
| iCIMS | ◐ generic resolver + selector hints | ◐ | ◐ | ◐ | frequently login-walled → blocked with RCA. **This row is about AUTO-FILL only.** iCIMS is a working, enabled DISCOVERY source — 2,431 rows in the live store across 54 portals — but it was absent from the discovery table above, so this document read as “iCIMS is unsupported” | ◐ `atsMoreFixtures`: an iframe-embedded, two-step form written by hand, **not captured from a live site** |
| Taleo | ◐ generic resolver + selector hints; fills ids full of dots and link-styled buttons (hand-written fixture) | ◐ link-style Next | ◐ | ◐ | legacy multi-frame flows often blocked | ◐ `atsMoreFixtures`: a hand-written form, **not captured from a live site** |
| Jobvite | ◐ generic resolver + selector hints; name-based fields and a file input hidden behind an "Attach" label (hand-written fixture) | ◐ | ◐ | ◐ | — | ◐ `atsMoreFixtures`: a hand-written form, **not captured from a live site** |
| Generic accessible forms | ✅ semantic field resolver (labels/ARIA/question text; selects, comboboxes, radios, checkboxes, dates, files, conditionals) | ✅ safe Next/Continue only | ✅ | ✅ | unknown required questions block (never guessed). **Assisted fill only — never eligible for auto-submit**, since an unrecognised site is by definition not fixture-verified | ✅ `atsApplicationFixtures` generic case, `validationDetection`, `fieldFiller` |

**Interview prep pack.** At Interviewing, a job's page links to one printable sheet: each requirement beside the master-resume line that shows it, the gaps (requirements no line shows, and phrases the posting names that the resume does not), the posting's buried conditions with their sentences, and the submitted (frozen) document version. Quoted only; no model. Tested in `prepPack`.

**Vocabulary coverage.** System health measures, over up to 1,500 recent postings with a full description, the share that mention five or more of the skills the profile looks for. Below 40% (with at least 50 postings) it warns that jobs may score alike and lists what the postings keep asking for; the fix is the existing Also asked for / Look for this skill on a job. It does not change any score.

**Pay.** The pay a posting states is parsed to annual figures (US dollars only) with the period it was stated in and where it was read (compensation field, or a strict read of the description), stored on the job, and shown as "Not stated" when there is none. Sorting by pay is available through the board API (`sort=pay`, highest first, unstated last); there is no pay column or filter on the board yet. Existing jobs get their pay read by the next re-score. Tested in `payFields`.

**Browser extension.** The extension uses the same label-to-field mapping as auto-fill (one module, `src/shared/fieldLabels.js`, copied into `extension/fieldLabels.js` by `npm run sync:extension`; a test fails when the copy is stale), so it no longer fills "Reference email" or an emergency-contact phone with your details. It reads up to 400 controls (was 160). It pairs with a code from System health instead of a pasted key. It still never answers work-authorization, demographic, attestation or skill-years questions. Tested on local pages with a fake `chrome`; not loaded into a real browser here.

**Several tabs at once.** `ASSIST_CONCURRENCY` (1 to 3, default 1) lets the command-line batch fill that many approved applications together, each in its own tab of one persistent browser, never two on the same site (an ATS's tenants count as one site), and still stopping before every Submit. The dashboard's own Auto-fill batch is still one job at a time: it prepares, approves and fills each job in turn and shares one progress and cancel state, so it needs its own design. Tested with fake runners and a fake browser (`parallelTabs`); not run against live sites.

**Draft answers to open questions.** With the optional model on, a job's detail page can draft an answer to an open question ("Why do you want to work here?") from your master resume, showing the resume lines it used. The draft goes through the same claim verifier as a grounded cover letter (numbers, named things and ownership must come from the cited lines), is never typed until you edit and approve it, is kept for that one job only, and is never reused for another employer. Nothing is drafted for eligibility, sponsorship, pay, skill-years, history, health, age or demographic questions, and the model never receives your name or contact lines. Tested with a stubbed model in `groundedAnswer`, `approvedAnswersRoutes` and `answerDraftBrowser`; not run against a real model here.

**Work history and education.** On a page with an "Add" per job or degree, auto-fill adds one entry per role and degree from your profile and reads each value back. It uses only your profile's words (the role description is your own highlights, unedited), presses only an "Add" that names work experience or education, skips an entry already on the page, and presses nothing in a dry run. Fixture-tested on a Workday-shaped page; not yet run on a live tenant. iCIMS and Taleo use the same label rules but have no fixture of their own.

**Walls.** A sign-in, CAPTCHA or verification page stops the run by default. With `ASSIST_WAIT_FOR_WALL_SECONDS` set (headed runs only, capped at 15 minutes) the run instead stays on the page, looks again, and continues once you have cleared it; a wall that stays ends the run blocked and says how long it waited. Tested on a local fixture whose wall clears mid-run (`waitForWall`).

**Questions.** A question that matches no saved answer goes to the Questions list. Two helpers there only ever *suggest*: "same answer" for a close rewording of one you already answered (strict match; sensitive, pay, skill-years, other-country and employer-specific questions are excluded), and a years-with-a-skill number worked out from your work history. Both wait for one confirmation. Tested in `questionSimilarity` and `skillYears`.

**Coverage probe.** `npm run coverage:probe` reads the saved form fixtures with the no-side-effects dry run and records, per platform, how many fields auto-fill finds and would answer (System health → Auto-fill coverage). It is measured on local fixtures, first page of each form, and refuses any non-local URL. It says nothing about a real employer's current form.

**Live verification.** None of the ATS rows above has a recorded supervised
live run yet, so final Auto-submit is refused on every ATS. Auto-submit on an
ATS requires an entry in `config/verified_live_ats.json`; see
[LIVE_VERIFICATION.md](LIVE_VERIFICATION.md). Assisted fill, which never
submits, is unaffected.

Filling-wide guarantees (tested): CAPTCHA/login/MFA/bot walls always stop the
run (`guards`); validation-error detection after fill and after advancing
(`validationDetection`); `applied=1` only after positive confirmation evidence,
otherwise `submit_unverified` (`hardening`, `dashboardServer`); Auto-Apply
requires per-run explicit opt-in + eligibility precheck
(`autoApplyEligibility`); resumable persisted application state
(`applicationState`, `applicationResume`); duplicate-application prevention
(`dashboardServer` idempotency guard); sensitive choice widgets (sponsorship,
visa, authorization, EEO, consent) never auto-pick and are read back after
commit (`sponsorshipChoiceCommit`); walls judged on visible text, not script
contents (`guards`); landing pages with a search box or cookie banner still
open the application (`landingPageIncidentalInputs`); packets refused unless
they belong to the active candidate (`packetOwnershipChokepoints`); a human
submit in the handed-over window is detected and recorded as unverified
(`humanSubmitDetection`); auto-submit withheld on empty live required fields or
unreviewed sensitive answers (`autoSubmitTightening`).

The Chrome/Edge extension never answers work-authorization, sponsorship, visa
or citizenship questions, fills only the top frame and job/ATS frames, and
never exposes its shared key to page scripts (`extensionE2E`,
`extensionCompanion`).

Discovery detail reuse: Workday, SmartRecruiters, Oracle Recruiting, iCIMS and
Rippling all hydrate stored descriptions before spending their per-board detail
budget, so each run's budget goes to postings never read before
(`detailCacheReuse`).

## Known-bad data written by past bugs

Adapter fixes correct new rows only. Where a bug corrupted rows already stored,
a repair script exists, is idempotent, dry-runs by default, and backs up first.

| Symptom | Cause | Repair | Status |
| --- | --- | --- | --- |
| Every Workday job link 404s | `mapJob` resolved the root-relative `externalPath` against the bare origin, discarding `/{locale}/{site}` | `node scripts/repairJobUrls.mjs --apply --verify=10` | fixed in adapter (`workdayJobUrl`); 15,733 stored rows repaired, verified 10/10 live |

## Manually verified (live)

- **Adzuna** (2026-08-01) — real `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`, ran the actual
  adapter (not a hand-rolled call) via `scripts/adzuna-check.mjs`. Confirmed
  correct field mapping (company/title/location/postedAt/url/jdText) and found
  the `what_phrase` full-text-match issue documented above, which is now fixed
  and covered by tests. Enabled by default going forward.

Everything else below is fixture-tested only unless your own runs have
exercised it. Treat live-site behavior as **NOT VERIFIED** until you have
completed at least one supervised run per ATS.
