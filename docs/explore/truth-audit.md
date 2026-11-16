# Explore truth audit (branch `explore-product-film`, commit 8bc42f8)

Read-only pass. `CO` = `src/dashboard/public/assets/explore/js/content-overview.js`, `CD` = `.../content-deep.js`. Verdicts: TRUE / STALE / OVERSTATED / UNBACKED / MISSING-FROM-PAGE. Paths are repo-relative.

Note on config: `config/scoring.json` in the working tree is the owner's live, modified file. Numbers below come from the committed version (`git show HEAD:config/scoring.json`) and the code defaults. The committed file itself still carries data-engineer category names in `weights` (`azureFabricStack`, `dataEngineeringStack`, `biSemanticDepth`, `pythonSqlPyspark`); the page's Score Lab uses the generated-profile shape (title 18, core skills 30, industry 6) from `score-model.js:20-37`, which the content test checks against the real scorer.

## 1. Claims the page makes today

### 1a. Overview (`content-overview.js`)

| Claim | Where shown | Backing | Verdict | Fix |
|---|---|---|---|---|
| "18 source adapters" | CO:89 (JOURNEY.discover.fact), CO:36 | `src/search/index.js:38-57` (ADAPTERS has 18 keys); test `tests/node/exploreContent.test.js:62` | TRUE | For a newcomer say what it means: 12 are on in the shipped config, 2 need your key, 4 only read links you paste (`config/jobboards.json`) |
| "Serves itself on 127.0.0.1" | CO:36, CO:252 | `src/dashboard/server.js:11`, `:2272`; `SECURITY.md:14` | TRUE | none |
| "Nothing is submitted without you" | CO:36 | `src/cli/commands.js:593-594` (CLI forces `autoSubmit: false`); `src/apply/autoApplyEligibility.js:124-128`; `config/verified_live_ats.json` (empty) | TRUE | none |
| Hero lede "all on your own computer" | CO:32 | `SECURITY.md:11-12`; discovery makes outbound read-only requests (`src/utils/safeFetch.js`) | TRUE (with nuance) | Keep; the FAQ should say postings are fetched from public sites and nothing personal is uploaded |
| Every hero / discover / score / tailor / fill example is a data engineer | CO:22-55, 175-216 | illustrative data | TRUE but one profession | Replace per brief (content, not truth) |
| Score beat: "Title, skills, seniority, location, freshness and sponsorship each earn points" | CO:111 | `src/scoring/scorer.js` categories; `score-model.js:22-34` | TRUE | none |
| Tiers "Priority, Apply, Queue, Near miss or Discard" | CO:112 | `HEAD:config/scoring.json` tiers 85/75/60/50; `src/scoring/explainScore.js` | TRUE | none |
| "A rank by meaning ... never changes it" (optional) | CO:113, 329 | `src/scoring/semanticRerank.js`; `src/llm/embeddings.js:2-3` (RERANK=on) | TRUE | none |
| Tailor: "a bullet left out to fit two pages is listed, so Compare with master shows it" | CO:124 | default `max_pages` 2: `src/resume/tailor_cli.py:122`; Compare: `src/dashboard/public/assets/js/detail.js:1422`; `src/resume/resumeDiff.js` | TRUE | Add that the page count is measured by rendering when LibreOffice is installed (`src/resume/tailor_cli.py:47-53`, `src/resume/pagefit.py`) |
| "Wording changes only where you accepted a rewording checked against your own lines" | CO:124 | `src/resume/rewrites.js`, `src/resume/claimVerifier.js` | TRUE | none |
| "The master resume is opened read-only and never modified" | CO:131 | `src/resume/tailor.py` (works on a copy); `docs/USER_GUIDE.md:149` | TRUE | none |
| Emphasize: "set in bold, only where you already wrote them" | CO:128 | `src/resume/tailor.py`; CHANGELOG v0.2.3 fix (bold only on summary, skills, bullets) | TRUE | Could add "summary, skills and bullets only" |
| Fill "Stop ... at once for a CAPTCHA, a login, a verification code or a bot check" | CO:145 | `src/automation/guards.js`; `docs/SUPPORT_MATRIX.md:287` | TRUE by default | Optional wait exists (`ASSIST_WAIT_FOR_WALL_SECONDS`, off): mention as Optional, never as solving the wall |
| Track "history that is only ever added to" | CO:158 | `src/logging/db.js:116` (application_events); `src/domain/applicationOutcome.js` | TRUE | none |
| Track "Connect an inbox and replies are read, never changed" (optional) | CO:159 | `src/inbox/imapClient.js` (read-only), `src/inbox/sync.js` | TRUE | none |
| GATES: approval withdrawn if resume, letter or saved answers change | CO:170 | `src/apply/approvalDigest.js:15`, `:55`, `:109` | TRUE | none |
| GATES: "Auto-fill ends at a filled form. The final click is yours." | CO:171 | `src/automation/navigator.js`; `src/cli/commands.js:594` | TRUE | none |
| DISCOVER_DEMO "Excluded: requires a security clearance" | CO:179 | `src/scoring/exclusionFilter.js`; CD:232 | TRUE | none |
| HOOD "A dependency-free local server, bound to 127.0.0.1" | CO:241 | `src/dashboard/server.js` (node:http) | TRUE | none |
| HOOD "One SQLite file per profile ... with daily snapshots" | CO:242 | `src/profile/workspace.js`; `src/logging/backup.js` | TRUE | none |
| HOOD "A visible Chromium window" | CO:243 | `src/automation/browser.js` | TRUE | none |
| HOOD "python-docx edits your Word file and keeps its formatting" | CO:244 | `src/resume/tailor.py`; `requirements.txt` | OVERSTATED (wording) | It edits a per-job copy, never "your Word file". Say "edits a copy of your Word file" |
| BOUNDARIES.does "Keeps your jobs, resume, answers and history in local files and a local SQLite database" | CO:253 | `SECURITY.md:57-67` | TRUE, incomplete | MISSING-FROM-PAGE: these files are unencrypted; say so plainly (SECURITY.md:59-61, CHANGELOG v0.2.3 P5) |
| NEVER "Submits an application without you. No command and no dashboard button does it." | CO:259 | `src/cli/commands.js:593-594`; no `auto-submit-batch` call in `src/dashboard/public/assets/js/` (grep: only Explore content mentions it); route exists `src/dashboard/routes/batchRoutes.js:37`; refused per ATS `src/apply/autoApplyEligibility.js:124-128` | TRUE | none; keep the experimental route disclosed |
| NEVER "Solves, bypasses or works around a CAPTCHA, login, verification code or bot check" | CO:260 | `src/automation/guards.js`; wait helper only re-inspects (`src/automation/assistSupport.js:454-461`) | TRUE | none |
| NEVER "Guesses an answer to a screening question it has no saved answer for" | CO:261 | `src/apply/screeningQA.js`; suggestions need a confirmation (`src/apply/questionSimilarity.js`, `src/apply/skillYears.js`); drafts need per-job approval (`src/apply/approvedAnswers.js`, `src/apply/draftGuard.js`) | TRUE | Optionally add "it may suggest one for you to confirm" |
| NEVER "States that you do not need sponsorship when your profile says you do" | CO:262 | `src/config/screeningAnswerRules.js`, `src/automation/fieldFiller.js` | TRUE | none |
| NEVER "Adds a skill, number or title to your resume that is not already yours" | CO:263 | `src/resume/tailor.py:36` (focus line removed), `src/resume/claimVerifier.js` | TRUE | none |
| NEVER "Logs in to a job board or scrapes behind a login" | CO:264 | `docs/SUPPORT_MATRIX.md:231-246`; adapters read public endpoints | TRUE | none |
| SOURCES ids = adapter registry | CO:281-300 | test `exploreContent.test.js:62` | TRUE | none |
| SOURCES mode `on` for 9 ATS feeds, atsSearch, careers, manualUrls | CO:282-295 | `config/jobboards.json` (all 12 `enabled: true`) | TRUE | none |
| SOURCES mode `key` for Adzuna, Apify | CO:293-294 | `config/jobboards.json` (`enabled: false`); README:300 | TRUE | Add: Apify is billed per use on your own account (`docs/SUPPORT_MATRIX.md:43`) |
| SOURCES mode `urls` for genericPublicPage, LinkedIn, Indeed, Dice | CO:296-299 | `config/jobboards.json` (`enabled: false` as discovery sources); `POST /api/add-url` (`src/dashboard/server.js:58`); `src/search/sources.js:81-86` | TRUE | none (they never search or log in) |
| "Nine public feeds read directly" | CO:313 | 9 `group: 'ats'` rows, all enabled | TRUE | none |
| Capability "Hacker News source" Planned | CO:321 | no adapter in `src/search/` | TRUE (still planned) | none |
| Capability "Auto-fill coverage probe" Experimental | CO:343 | `src/automation/coverageProbe.js:41-47` (refuses non-local URLs); results shown in System health | TRUE | Label fits loosely: results ARE shown in the dashboard; the probe is run from `npm run coverage:probe`. Keep Experimental, keep "saved pages only" |
| Capability "Template cover letters: assembled from your profile and letter settings" | CO:335 | since v0.2.1 letters come from your master cover letter (`src/apply/masterLetter.js:128`, `src/apply/letterTailor.js`); CHANGELOG:120,134 | STALE | Rename "Cover letters from your master letter"; add versions and the PDF copy (`src/apply/letterPdf.js`) |
| Capability "Browser extension ... Loaded manually" Optional | CO:345 | `extension/manifest.json`; pairing by code `src/extension/pairing.js:35` | TRUE, incomplete | Add "pairs with a short code" |
| Capability "Final auto-submit ... refused on every ATS until one is verified live" Experimental | CO:346 | `config/verified_live_ats.json` (`"verified": []`); `src/apply/liveVerification.js:24`; `docs/SUPPORT_MATRIX.md:281-285` | TRUE | none |
| Capability "MCP server: Read access ... cannot approve, fill or submit" | CO:356 | `src/mcp/server.js:48-125`: 7 tools incl. `add_note`, `record_outcome` | OVERSTATED | "Read access, plus adding a note and recording an outcome" (CD:51 already says this) |
| Capability "Live run progress stream" Planned | CO:357 | no `text/event-stream` or `EventSource` anywhere in `src/` | TRUE (still planned) | none |
| Capability "Dropped-field report on resume import" Planned | CO:358 | Resume check shipped (`src/resume/readiness.py:46`, `src/dashboard/routes/masterResumeRoutes.js:52`) covers the master resume; profile-from-resume import still has no dropped-field list | STALE (overlaps a shipped row) | Remove, or narrow to "what the profile import could not place" |
| Capability "Google Calendar sync" Planned | CO:352 | only `.ics` export (`src/reports/calendar.js`) | TRUE | none |
| Capability "Applications board ... conversion numbers" | CO:348 | `src/dashboard/public/assets/js/workspace.js:239-244` | TRUE | Add role family / tailored-vs-master groups and offer rate (F9) |
| Capability register lacks every v0.2.1 to v0.2.3 feature in section 2 marked "no" | CO:312-359 | see section 2 | MISSING-FROM-PAGE | Add rows |

### 1b. Under the hood (`content-deep.js`)

| Claim | Where shown | Backing | Verdict | Fix |
|---|---|---|---|---|
| Resume node: "Node spawns a Python process and exchanges one JSON message each way" | CD:102 | `src/resume/tailorRunner.js:383-414`: a pool of long-lived workers (default 2, `JOB_AGENT_PYTHON_WORKERS` 1-4); one-shot only with `JOB_AGENT_PYTHON_WORKER=off`; `src/resume/pythonWorker.js` | STALE | "Node keeps two Python workers ready and sends each job as one JSON message"; add `src/resume/pythonWorker.js` to files |
| Tailoring step "Cross the process boundary: Node spawns Python ... one JSON request on stdin. A timeout kills the whole process tree." | CD:351 | same as above | STALE | Same fix |
| Tailoring step "Emphasize: ... An optional line lists terms that are both requested and already present; it is the only new sentence, and it passes through the humanizer." | CD:353 | Removed: `src/resume/tailor.py:36`; CHANGELOG:41; `grep humanizer src/resume/tailor.py` returns nothing | STALE (contradicts "nothing is added") | Delete the sentence; drop `src/resume/humanizer.py` and `config/humanizer_patterns.json` from that step's files |
| Tailoring trace has no step for page fit, left-out bullets or per-step rollback | CD:344-362 | `src/resume/pagefit.py`, `src/resume/tailor_cli.py:47-53,161-165`, `src/resume/keepBullets.js`, `src/resume/tailor.py:2851,2970-2985` (`skipped_steps`) | MISSING-FROM-PAGE | Add "Fit the page" and "Undo a failed step" steps |
| Tailoring "Export a PDF: LibreOffice first ... then Word ... then Chromium" | CD:356 | `src/resume/pdfExport.py:5-10`; `src/resume/chromiumPdf.js` | TRUE | none |
| Scoring step "Two factors can only subtract" (pay 6, stated floor 8) | CD:312 | Three: `DEFAULT_PAY_PENALTY = 6` (`src/scoring/scorer.js:584`), `DEFAULT_ELIGIBILITY_PENALTY = 8` (`src/scoring/eligibility.js:44`), `DEFAULT_TRACK_PENALTY = 20` (`src/scoring/scorer.js:587`); `score-model.js:36` already has all three | STALE | "Three factors can only subtract": add the people-manager / individual-contributor track penalty, up to 20 |
| Scoring note "How the board is ordered: tier first, then postings from the last 24 hours ..." | CD:318 | `src/scoring/jobRanking.js:47-49`: apply-window bands (under 24 h, 1-3 d, 4-7 d, 8-21 d, older); CHANGELOG:90 | STALE | "then how recently it was posted, in bands" |
| Scoring: preferred skill earns 30% | CD:311 | `src/scoring/scorer.js:68` | TRUE | none |
| Scoring: thresholds 85 / 75 / 60 / 50 | CD:313 | `HEAD:config/scoring.json` tiers | TRUE | none |
| Scoring: evidence comes from one shared rule | not on page | `src/resume/evidence.js:5-18`, `src/resume/evidence.py:6-29`, `src/resume/evidence_rules.json`, `src/resume/evidenceMap.js:36` | MISSING-FROM-PAGE | Add as a step or note |
| Scoring: hidden conditions and "Also asked for" | not on page | `src/scoring/hiddenClauses.js:67`, `src/scoring/requirementPhrases.js:98`, `src/dashboard/routes/profileRoutes.js:320` | MISSING-FROM-PAGE | Add |
| Calibration: 30 outcomes, 5 each side, 20% cap | CD:320 | `src/scoring/calibration.js:20-22` | TRUE | none |
| Run step Freshness: window "24 hours, 3 days, 7 days, or no limit" | CD:227 | `src/utils/credentialManager.js:204-206`: also 14 and 30 days | STALE (incomplete) | "from 24 hours to 30 days, or no limit" |
| Run step Search: "up to six sources at once and four requests in flight per host" | CD:217 | `src/search/index.js:74,82`; `src/utils/hostGate.js:136` | TRUE | none |
| Pipeline: "transactions of 500 rows" | CD:74 | `src/pipeline/index.js:1064` | TRUE | none |
| Persist: "stopped listing for three complete runs are expired" | CD:242 | `src/pipeline/index.js:1061` | TRUE | Add: an unchanged Workday board that was skipped is never counted as a missed run (`src/search/adapters/workday.js:418`) |
| Discovery trace: no mention of the unchanged-board skip | CD:265-283 | `src/search/boardFingerprints.js`, `src/search/adapters/workday.js:501-502` | MISSING-FROM-PAGE | Add to "Fetch politely" or "Keep it current" (Workday only) |
| "Eighteen source adapters" / "Eighteen adapters, three kinds of source" | CD:80, 267 | `src/search/index.js:38-57`; `src/search/sources.js:81-86` | TRUE | none |
| AI trace note "The six tasks" | CD:338 | Seven task names: `jd-requirements` (`src/llm/jdRequirements.js:69`), `rewrite-bullets`, `refine` (`src/resume/rewrites.js:65,271`), `cover-letter` (`src/apply/groundedLetter.js:51`), `classify-reply` (`src/inbox/classify.js:68`), `draft-reply` (`src/inbox/draftReply.js:22`), `free-text-answer` (`src/apply/groundedAnswer.js:42`) | STALE | "The seven tasks"; add `free-text-answer` |
| AI "Cost and privacy" note omits identity redaction | CD:340 | `src/llm/identityUnits.js:77,88`; call sites `src/apply/groundedLetter.js`, `src/apply/groundedAnswer.js`, `src/resume/rewrites.js`, `src/inbox/draftReply.js`, `src/scoring/semanticRerank.js`; `SECURITY.md:43-47` | MISSING-FROM-PAGE | Add "lines carrying your name, email, phone or profile link are dropped before any model call" |
| Model node: "Nothing is sent unless LLM assist is on." | CD:181 | `src/llm/embeddings.js:15` forces `LLM_ASSIST: 'on'` for embeddings when `RERANK=on`; `INBOX_LLM=on` has its own switch (`SECURITY.md:41-42`) | OVERSTATED | "Nothing is sent unless you turn a model feature on" |
| AI "see: Nothing, until you set `LLM_ASSIST=on`" | CD:327 | `src/llm/client.js:47,63,78` (off by default, needs a key) | TRUE | none |
| Autofill "Guard: ... Any of them ends the run as blocked" | CD:391 | default true (`src/automation/guards.js`); optional bounded wait `src/automation/assistSupport.js:454-461`, `src/utils/credentialManager.js:166` | TRUE by default | Add the optional wait |
| Autofill note "Fixture-tested fill contracts: Greenhouse, Lever, Ashby, Workday, SmartRecruiters. Selector hints plus the generic resolver: iCIMS, Taleo, Jobvite." | CD:398 | `src/apply/autoApplyEligibility.js:24-26`; `docs/SUPPORT_MATRIX.md:256-258` (hand-written fixtures in `atsMoreFixtures`, not captured live) | TRUE, slightly behind | Add "with hand-written test pages, not captured from a live site" |
| Autofill trace lacks readiness, work history / education, question-reveals-question, shadow roots, dry run | CD:383-403 | `src/apply/autofillReadiness.js:29-83`; `src/automation/repeatedSections.js:163`; `src/automation/assistStages.js:416`; `src/automation/fieldFiller.js:603,651` | MISSING-FROM-PAGE | Add |
| Auto-submit note: conditions and "daily cap (15 by default)" | CD:399 | `src/automation/applyRunner.js:189` (`maxApplicationsPerDay`, default 15: `src/utils/credentialManager.js:150`); `src/apply/autoApplyEligibility.js:118-128` | TRUE | none |
| "for up to 45 minutes the runner watches for a confirmation page" | CD:395 | `src/automation/assistSupport.js:21-22` | TRUE | none |
| Server node: "runs one pipeline run and one auto-fill at a time" | CD:66 | `src/dashboard/server.js:726,1928`; `docs/SUPPORT_MATRIX.md:269` (parallel tabs are CLI batch only) | TRUE | none |
| Extension: "authenticated with a key" | CD:58 | `src/extension/pairing.js:11-12,35,71` (pairing code hands over the key) | TRUE, behind | Add pairing by code and the shared field mapping (`src/shared/fieldLabels.js`) |
| DB node: "Four tables" | CD:145 | `src/logging/db.js:43,89,116,125` | TRUE | none |
| MCP: "exactly seven tools" | CD:51, 527 | `src/mcp/server.js:48-125` | TRUE | none |
| STACK: Node 22.13+, Python 3.12+ | CD:197, 204 | `package.json` engines; `requirements.txt:1`; `scripts/prepareLaunch.mjs:114` | TRUE | none |
| QUALITY: "more than 200 test files ... 88% of lines and 76% of branches" | CD:530 | 288 files in `tests/node/*.test.js`; `vitest.config.js:24` | TRUE | none |
| QUALITY: pytest covers the tailor etc. | CD:533 | `tests/python/` (25 files) | TRUE | none |
| Tracking: outcomes list and forward-only moves | CD:413 | `src/domain/applicationOutcome.js:25-27` | TRUE | Add role-family and resume groups, offer rate, prep pack |
| SECURITY "Secrets: keychain / DPAPI / Secret Service, encrypted file fallback" | CD:501 | `src/utils/secretStore.js:7-12` | TRUE, incomplete | Keys placed in `.env` are plain text (`SECURITY.md:63`); say so |
| CLI_GROUPS, LIFECYCLE, API routes, cited files | CD:431-525 | enforced by `tests/node/exploreContent.test.js` (18 tests) | TRUE | CLI list has no `schedule` (it is an npm script, `package.json:62`) |

## 2. The brief's "shipped" lists

### v0.2.3 (CHANGELOG.md:6-66)

| Feature | Code | Changelog | On Explore today? |
|---|---|---|---|
| Resume check on upload | `src/resume/readiness.py:46`; `src/dashboard/routes/masterResumeRoutes.js:49-53`; `src/dashboard/public/assets/js/master.js` | :40 | Yes, CO:333 (register row only) |
| Page fit measured by rendering | `src/resume/tailor_cli.py:47-53,142,161-165`; `src/resume/pagefit.py`; `RESUME_MEASURE_PAGES` default true `src/utils/credentialManager.js:174` | :39 | Partly: CD:356 mentions it under PDF; not in Overview |
| PDF made from your own Word file | `src/resume/pdfExport.py:5-10`; fallback `src/resume/chromiumPdf.js` | :38 | CD:356 only |
| Hand-typed bullets, links, headers, tables, text boxes | `src/resume/tailor.py:1707-1711`; CHANGELOG :51, :55, :59, :60 | :51-:61 | No |
| Plurals match; everyday words not skills | `src/resume/evidence.py:10-17`; `src/resume/evidence_rules.json` | :57, :58 | No |
| One evidence rule (score, packet, gap list) | `src/resume/evidence.js:5-18`; `src/resume/evidence.py:6-29`; `src/resume/evidenceMap.js:36` | :52 | No |
| "Also asked for" + "Look for this skill" | `src/scoring/requirementPhrases.js:98`; `src/dashboard/routes/profileRoutes.js:320-332`; `src/dashboard/public/assets/js/detail.js:939-954` | :13 | Yes, CO:326 (register row only) |
| Failed tailoring step undone alone | `src/resume/tailor.py:2851,2970-2985`; `src/resume/tailor_cli.py:204` | :53 | No |
| One-line setup card | `src/config/setupProgress.js:24,112`; `src/dashboard/public/assets/js/setup.js:89` | :42-:43 | Yes, CO:327 |
| Name and contact details never sent to an AI provider | `src/llm/identityUnits.js:77,88` and five call sites; `SECURITY.md:43-47` | :62 | No |
| Dry run changes nothing | `src/automation/fieldFiller.js:603,651`; `src/automation/assistStages.js:116,404,416` | :50 | No |

### v0.2.1 and v0.2.2

| Feature | Code | Changelog | On Explore today? |
|---|---|---|---|
| Hidden conditions as tags, each with its sentence | `src/scoring/hiddenClauses.js:22-42,67`; `src/dashboard/data.js:1869` | :76 | No |
| Evidence from the master resume per skill | `src/resume/evidenceMap.js:36,62` | :79 | No |
| Auto-fill readiness | `src/apply/autofillReadiness.js:29,83`; `detail.js:358` | :77 | No |
| Sign in once, retry all | `src/apply/autofillReadiness.js:59`; `src/dashboard/public/assets/js/signin.js:2,31` | :78 | No |
| Answers kept per person | `src/config/profileStore.js:97,272` | :102-:103 | No |
| Master cover letter with versions | `src/apply/masterLetter.js:90,128` | :120-:121 | No (CO:335 is stale) |
| Compare with master | `src/resume/resumeDiff.js`; `detail.js:1422` | :122 | Yes, CO:124 |
| Employer history from saved postings | `src/dashboard/employerHistory.js:33,72,87` | :80 | No |
| Today queue | `src/dashboard/public/assets/js/today.js`; `GET /api/today` | :89 | CD:408, 419 only |
| Command palette | `src/dashboard/public/assets/js/palette.js` | :74 | No |
| Keyboard triage | `src/dashboard/public/assets/js/main.js:81` | :75 | No |

## 3. The brief's "Not shipped, Planned only" list: what the code says

| Brief item | Code | Default / switch | In the dashboard? | Caveat | Honest label |
|---|---|---|---|---|---|
| Pause and continue at sign-ins | `src/automation/assistSupport.js:454-461`; `src/utils/credentialManager.js:166` | Off. `ASSIST_WAIT_FOR_WALL_SECONDS` (headed only, capped 15 min) | No control; env var only | Local fixture only (`waitForWall`); never solves a wall | **Optional** |
| Filling work history and education | `src/automation/repeatedSections.js:163`; called at `src/automation/assistStages.js:416` | On, part of every fill | Yes (runs inside Auto-fill) | Workday-shaped hand-written fixture only; never run on a live tenant (`docs/SUPPORT_MATRIX.md:254,273`) | **Implemented**, with "tested on a test page only" in the row (the changelog's own wording, :30) |
| Drafted free-text answers | `src/apply/groundedAnswer.js:42`; `src/apply/draftGuard.js`; `src/apply/approvedAnswers.js:20-23`; UI `detail.js:416,561` | Off: needs the optional model (`LLM_ASSIST=on`) | Yes, "Answers for this job" | Stubbed model in tests; per-job approval; refuses fact questions | **Optional** |
| Filling several jobs at once | `src/cli/commands.js:643`; `src/utils/credentialManager.js:169` | Off: `ASSIST_CONCURRENCY` 1-3, default 1 | No: dashboard batch is still one at a time (`src/dashboard/server.js:1928`) | CLI batch only; fake-browser tests | **Optional** (command line only) |
| Incremental discovery | `src/search/boardFingerprints.js`; `src/search/adapters/workday.js:416-418,501-502,544` | On | Automatic | Workday only; full sweep every 3 days | **Implemented** (Workday only) |
| Live results | no SSE, no streaming scorer (grep `event-stream`: none); audit D2 deferred | n/a | n/a | not built | **Planned** |
| Outcome analytics | `src/dashboard/public/assets/js/workspace.js:236-244`; `src/dashboard/data.js:2427`; `conversionText.js` | On | Yes, "What gets interviews" | Small groups show counts only | **Implemented** |
| Interview prep pack | `src/dashboard/prepPack.js`; `src/dashboard/routes/jobRoutes.js:77` | On at Interviewing | Yes, link on the job | Quoted only, no model | **Implemented** |
| Scheduled runs | `src/cli/schedule.js`; `scripts/schedule.mjs`; `package.json:62` | Off until you run `npm run schedule -- --install` | No | Searches and scores only; not installed by default | **Optional** |
| Installer | `scripts/prepareLaunch.mjs:114-117`; `package.json:61` (`setup:all`); launchers | Launcher offers Python setup on first launch | n/a | No packaged installer (no .dmg / .msi / .exe) | **Planned** as an installer; the launcher setup is **Implemented** and should be described as that |

Verified live: only the Adzuna adapter (`docs/SUPPORT_MATRIX.md:325-329`). No ATS has a recorded supervised live fill (`docs/SUPPORT_MATRIX.md:281-285`, `:331-333`).

Auto-submit refusal: `src/apply/autoApplyEligibility.js:124-128` adds a failing `ats_live` check unless the ATS is in `config/verified_live_ats.json`, which ships `"verified": []`; loader `src/apply/liveVerification.js:24`. The CLI can never submit (`src/cli/commands.js:593-594`), a dry run never submits (`src/automation/applyRunner.js:192`), and no dashboard script calls `POST /api/auto-submit-batch` (`src/dashboard/routes/batchRoutes.js:37`).

Outside scope, noted: `docs/SUPPORT_MATRIX.md:329` still says Adzuna is "Enabled by default going forward", which contradicts `config/jobboards.json` (`enabled: false`) and CHANGELOG.md:209.

## 4. Real numbers

| Fact | Value | Source |
|---|---|---|
| Role families | 26 | `config/role_families.json` (`families`, labels at lines 18-1620); loader `src/profile/roleFamilies.js:44,203-228` |
| Source adapters | 18 | `src/search/index.js:38-57` |
| Adapters on in the shipped config | 12: manualUrls, atsSearch, greenhouse, lever, workday, careers, ashby, smartrecruiters, rippling, oracleRecruiting, amazonJobs, icims | `config/jobboards.json` |
| Adapters off until you act | 6: apify (2 entries), adzuna (keys); dice, linkedin, indeed, genericPublicPage (URL readers) | `config/jobboards.json` |
| Employer boards listed in the shipped config | Greenhouse 88, Lever 51, Ashby 49, SmartRecruiters 123, Rippling 29, iCIMS 54 | `config/jobboards.json` |
| Score scale | 0 to 100, whole number | `src/scoring/explainScore.js`; `score-model.js:259` |
| Tier thresholds | Priority 85, Apply 75, Queue 60, Near miss 50, below that Discard | `HEAD:config/scoring.json` `tiers`; `score-model.js:37` |
| Generated-profile categories | Title fit 18, Core skills 30 (full at 6 skills), Industry 6 | `score-model.js:22-24` (checked by the content test) |
| Structural weights | Seniority 8, Sponsorship stated 10, Employer sponsors 5, Location 6, Freshness 4, Direct employer link 3, Profile overlap 10 | `HEAD:config/scoring.json` `weights`; `score-model.js:26-34` |
| Penalties (subtract only) | Stated requirement up to 8; posted pay up to 6; track (manager vs individual contributor) up to 20 | `src/scoring/eligibility.js:44`; `src/scoring/scorer.js:584,587` |
| Preferred-only skill credit | 30% | `src/scoring/scorer.js:68` |
| Sponsorship gate | Apply or better stays only when Confirmed or Likely (config also lists "Approved") | `HEAD:config/scoring.json` `sponsorshipGate` |
| Resume page budget | 2 pages by default; 0 means never leave anything out | `src/resume/tailor_cli.py:122`; `src/resume/tailorRunner.js:238-239` |
| Page fit | Measured by LibreOffice when installed (`RESUME_MEASURE_PAGES`, default true), else an estimate | `src/resume/tailor_cli.py:47-53`; `src/utils/credentialManager.js:174` |
| Freshness windows | 24 hours, 3, 7, 14, 30 days, or all | `src/utils/credentialManager.js:204-206` |
| Hidden-condition kinds | 11: clearance, onsite for the first N days, fully onsite, travel %, on-call, shifts, W2 only, contract length, relocation, US citizenship, application deadline | `src/scoring/hiddenClauses.js:22-42` |
| Licences the eligibility reader knows | nurse practitioner, CPA, PE, pharmacist, DEA, RN, bar admission, CFA | `src/scoring/eligibility.js:546-553` |
| Run mode default | `DRY_RUN`; valid modes DRY_RUN, PREPARE, LIVE_ASSIST (no submit mode exists) | `src/utils/credentialManager.js:144-149,201` |
| Auto-submit daily cap | 15 | `src/utils/credentialManager.js:150`; `src/automation/applyRunner.js:189` |
| Model use out of the box | None. `LLM_ASSIST` defaults off and needs a key | `src/llm/client.js:47,63,78` |
| What is removed before a model call | Lines carrying a name, email, phone number or profile link | `src/llm/identityUnits.js:77,88`; `SECURITY.md:43-47` |
| What each model switch sends | `LLM_ASSIST=on`: public posting text and title only. `RESUME_REWRITE=suggest`: bullets with role lines. `COVER_LETTER_MODE=grounded`: summary, headline, bullets, master letter paragraphs. `INBOX_LLM=on`: up to 6,000 characters of an email. `RERANK=on`: bullets and top postings to an embeddings model | `SECURITY.md:34-47` |
| Storage | Ordinary unencrypted files in the JobAgent folder: `config/`, `.env`, `resumes/`, `applications/`, `data/`, `logs/`, one browser profile folder per person. Only the export bundle can be encrypted (AES-256-GCM) | `SECURITY.md:57-78`; CD:491 |
| Licence and cost | MIT, no paid dependency. Optional costs are yours: Apify is billed per use, Adzuna has a free key, a hosted model bills your own key; a local model costs nothing | `LICENSE:1`; `package.json:87`; `README.md:294-300`; `docs/SUPPORT_MATRIX.md:43` |
| Requirements | Node 22.13+, Python 3.12+ (tailoring; without it the master resume is used), Playwright Chromium (form filling), LibreOffice recommended | `README.md:120-128`; `package.json` engines |
| Real onboarding in the dashboard | (1) Add profile from your resume: `POST /api/search-profiles/from-resume`, dialog `src/dashboard/public/index.html:1088`. (2) Confirm the "Job titles to search for" it proposes (`index.html:1117`; `src/dashboard/public/assets/js/profiles.js:511`). There is no "choose your field" picker: the role family is matched from your titles (`src/profile/roleFamilies.js`). (3) "Run your first search" (`src/dashboard/data.js:1294-1300`). The setup card (Contact, Work authorization and sponsorship, Experience, Screening answers: `src/config/setupProgress.js:24`) is needed only before applying |
| Explore tests today | 18 in `exploreContent.test.js`, 20 in `explorePage.test.js` | grep `it(` |

### The 26 role families (`config/role_families.json`)

data-analytics: Data & Analytics · software-engineering: Software Engineering · infrastructure-devops: Infrastructure, Cloud & DevOps · security: Security & Risk · product-management: Product Management · project-program-management: Project & Program Management · design-ux: Design & User Experience · marketing-growth: Marketing & Growth · sales-business-development: Sales & Business Development · finance-accounting: Finance & Accounting · legal-compliance: Legal & Compliance · regulatory-quality: Regulatory Affairs & Quality · healthcare-clinical: Healthcare & Clinical · human-resources: People & Human Resources · operations-supply-chain: Operations & Supply Chain · customer-support: Customer Support & Service · education-training: Education & Training · science-research: Science & Research · manufacturing-hard-engineering: Manufacturing & Physical Engineering · skilled-trades: Skilled Trades & Facilities · transportation-logistics: Transportation & Delivery · hospitality-retail-food: Hospitality, Retail & Food Service · public-safety-government: Public Safety & Government · media-content: Media, Content & Communications · administrative-office: Administrative & Office Support · personal-care-fitness: Personal Care & Fitness

## 5. FAQ answers, each backed

| Question | Answer | Backing |
|---|---|---|
| Does it apply for me automatically? | No. It fills the form in a browser window you can see and stops before Submit; you read it and click. An experimental submit route exists, no dashboard button calls it, and it is refused on every application system until a supervised live run is recorded, which none is. | `src/cli/commands.js:593-594`; `src/apply/autoApplyEligibility.js:124-128`; `config/verified_live_ats.json`; `docs/LIVE_VERIFICATION.md:8-11` |
| Where does my data go? Is any of it sent to an AI? | It stays in the JobAgent folder on your computer, as ordinary unencrypted files, so turn on your disk encryption. No AI model is used unless you switch one on; when you do, lines carrying your name, email, phone or profile link are removed first, and a local model keeps everything on your machine. | `SECURITY.md:11-12,34-47,57-72`; `src/llm/client.js:47`; `src/llm/identityUnits.js:77,88` |
| Is it only for tech jobs? | No. Search profiles are built from your resume against 26 role families, from Healthcare & Clinical to Skilled Trades, and every family runs through the same code. | `config/role_families.json`; `src/profile/roleFamilies.js:2,24`; CD:293 |
| What do I need to start? | A computer with Node.js 22.13 or newer and your resume as a Word file. Python 3.12 adds resume tailoring and a Chromium download adds form filling; the launcher offers to set both up. | `README.md:120-128,142`; `scripts/prepareLaunch.mjs:114-117`; `package.json:61` |
| Does it cost anything? | No. It is MIT-licensed and the default sources need no key. Optional extras use your own accounts: Apify is billed per use, Adzuna has a free key, and a hosted AI model bills your own key. | `LICENSE:1`; `README.md:294-300`; `docs/SUPPORT_MATRIX.md:43` |
| What if it gets something wrong? | You see it before it matters. Every score lists its reasons, Compare with master shows every resume line that moved or was left out, a question with no saved answer is asked, not guessed, and nothing is filled until you approve. Changing the resume, letter or answers afterwards withdraws the approval. | `src/scoring/explainScore.js`; `src/resume/resumeDiff.js`; `src/apply/screeningQA.js`; `src/apply/approvalDigest.js:15,109` |
| Which job sites does it cover? | Out of the box: nine employer application systems (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Rippling, Oracle Recruiting, iCIMS, Amazon Jobs), a cross-company title search, company careers pages and any links you paste. Adzuna and Apify work with your own key. LinkedIn, Indeed and Dice are read only from public links you give it; it never searches them or logs in. | `src/search/index.js:38-57`; `config/jobboards.json`; `README.md:292-300`; CD:279 |
