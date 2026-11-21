# Verification of the 2026-11-14 audit

Checked against branch `JobAgent-Nov14`, created from `main` at `eca8322` (the
audited commit). `git log eca8322..HEAD` is empty, so no later commit touched any
finding. The working folder (`../JobAgent`, branch `feat/explore-launch-film`)
carries the same product code plus an uncommitted Explore rebuild; where that
changes a verdict (X1, X4, X5) it is noted.

Nothing in `src/`, `tests/` or the docs has been changed. The reproduction scripts
used below are in [`2026-11-audit-verification/`](2026-11-audit-verification/)
(fictional data only) and become the first corpus fixtures in Phase 0.

## 1. Baseline

Environment: macOS, Node 25.9.0, Python 3.12.4 venv, Playwright Chromium 1254,
Microsoft Word present (but see R6), no LibreOffice. `npm ci`, `npx playwright
install chromium`, venv + `pip install -r requirements.txt`, `npm run setup` all
succeeded. `npm run doctor`: 14 passed, 2 warnings, 1 failure. The failure is the
expected one on a fresh clone (the profile still holds template values).

| Command | Result | Time |
| --- | --- | --- |
| `npm test` | 247 files passed; **3,136 passed, 3 skipped** (3,139) | 108 s |
| `npm run test:py` | **106 passed** | 7 s |
| `npm run lint` | 0 errors, 13 warnings. **ruff is not installed, so Python lint was skipped** | 4 s |
| `npm run typecheck` | clean | 1 s |
| `npm run verify` | **6/6 PASS** | 1 s |

The audit's "2,971 pass / 14 browser files fail" is the same suite with Chromium
missing (reproduced under P3).

## 2. Verdicts

Legend: **C** confirmed · **P** partly · **NR** not reproduced · **AF** already fixed · **D** disagree.
"Harness" means `2026-11-audit-verification/r1_r5_harness.py` unless named otherwise.

### Resume tailoring

| ID | Verdict | Evidence | Notes / corrected description |
| --- | --- | --- | --- |
| R1 | **C** | Harness: `docx_to_html` output lacks `jordan@example.com` while its `texts` contains it. `r1_pdf.mjs` → `{"exported":false,"reason":"the PDF would leave out 1 paragraph(s); not written"}`. Cause `tailor.py:2075` iterates `paragraph.runs` (python-docx 1.2 excludes hyperlink runs; `paragraph.text` includes them). No test in `tests/` mentions hyperlinks. | Affects the master too, not only tailored copies. |
| R2 | **C** | Harness: `present = go, r, excel, airflow`; all three bolded inside the summary; focus line "Most relevant to this role: go, r, excel, and airflow." Cause `_phrase_pattern` (`tailor.py:116-121`): `-` and `&` count as boundaries. | |
| R3 | **C** | Harness: `missing = ["data pipeline", …]` against "Built data pipelines…". | |
| R4 | **C (worse than described)** | `master_units` marks "B.S. Computer Science, …, 2012 - 2016" as `role`. Forcing the fit (`_fit_to_pages`, max 0.35 pages) reports `roles_kept: 4`: education is role 0, so the never-drop protection for the current role's required evidence (`tailor.py:1275-1277`) protects an education line with no bullets. The real current role's bullets matching a *required* term were omitted. | Root cause: `_is_role_heading` (`tailor.py:825-834`) and `_fit_to_pages` scan every paragraph, not the experience section. |
| R5 | **C** | Harness: "- Led the March 2021 migration to Airflow." is `kind: role`, and the 8 bullets after it are attributed to it, so the fit labels omissions as coming from role "- Led the March 2021…". `_is_bullet` (`tailor.py:1469-1476`) knows only `• · ▪ ◦` and list styles. | Compounds with R4. |
| R6 | **C (code), measurement blocked** | `r6_corpus.py`: the estimate is 1.27 pages for both single spacing and 1.15 spacing + 6 pt after (both set on the Normal style); Georgia 12 ≈ Calibri 11 (1.29 vs 1.27). `_paragraph_height` reads only direct paragraph formatting and the paragraph's own style size. The shipped `MASTER_RESUME.example.docx` is estimated at **1.82 pages (no trimming) but its Chromium PDF is 3 pages** (`r7_chromium.mjs`). | Word automation timed out (90 s), probably a macOS automation-permission prompt a non-interactive session cannot answer. No true DOCX page count was obtained. See open question Q2. |
| R7 | **C** | `docx_to_html` uses a fixed stylesheet (`tailor.py:2106-2112`: 10.5 pt, 0.55 in margins) and emits only bold. The uploaded file is the DOCX (`pipeline/index.js:806`); the PDF is a preview. The shipped example: estimate 1.82 vs Chromium 3 pages. | |
| R8 | **C** | Mini fixture: "Airflow" bolded in the role line "Airflow Platform Engineer \| Example Corp \| …" (first occurrence wins, `tailor.py:341-376`). A bullet stored as runs "Tuned Sp" + "ark jobs…" counts Spark as `present` (text audit) but it is never bolded. | |
| R9 | **C** | Harness focus line uses config spelling ("go, r, excel"). Off by default: `pipeline/index.js:792` (`runtime.resumeFocusLine === true`). | Low impact while off; recommend removing the option (Q6). |
| R10 | **P** | Two-space join, no tab stop: flattened row `'Data Engineer \| Sample LLC  2016 - 2018'`. **A cell holding only a link survives** (`_copy_cell_content` falls back to `paragraph.text`, link lost). **A cell mixing text and a link** ("Portfolio: " + link) raises `RuntimeError: ATS table normalization changed or duplicated resume text`, and the whole tailoring is abandoned. | Same root cause as R1 (run iteration skips hyperlinks). |
| R11 | **C** | Any `RuntimeError` in `tailor_resume` → `tailorRunner.js:244-251` returns the untailored master with a warning. | |
| R12 | **C** | Keywords come from the score and `scoring` vocabulary (`tailorRunner.js:213-216`); the tailor states the limit itself (`tailor.py:2322-2326`). The optional LLM path widens it. | Design gap, not a bug. |
| R13 | **C** | `scorer.js:806-823`: `profileText.includes(term)` over terms from **`candidate.json`**; the tailor uses word boundaries over the **resume file**. Two different sources as well as two different matchers. | |
| R14 | **C** | `_SECTION_HEADINGS` (`tailor.py:445-459`) has no "career history", "professional background", "technical proficiencies". Nothing reports it. | |
| R15 | **P** | `71105a6` (2026-11-13) reads headers, footers and text boxes for the **contact check only**; `atsLint.py:140-155` flags header/footer content. Still true: tailoring ignores them, and `docx_to_html` reads body paragraphs only. See N4: with contact details in the page header, the Chromium PDF contains none and reports "ok". | |
| R16 | **C (worse)** | `_apply_accepted_rewrites` (`tailor.py:2181-2188`) writes the rewrite into run 0 and blanks the other runs, but never touches hyperlink runs. See N3: the output gets the link text glued on. | |
| R17 | **C** | `invokePython` spawns a fresh interpreter per call (`tailorRunner.js:385`): tailor, `html` for the Chromium PDF, `letter_docx` (`:363`), `units` for rewrites/letters (`:346`). | |

### Auto-fill and browser assist

| ID | Verdict | Evidence | Notes / corrected description |
| --- | --- | --- | --- |
| A1 | **C, but the proposed fix rests on a false premise** | `config/verified_live_ats.json` has `"verified": []`; SUPPORT_MATRIX says no live run. **`dryRun` is not dry** (N2): it gates only the static plan (`applyRunner.js:554`) and uploads (`:640`). The dynamic fill (`:568`), the conditional fill (`:580`) and Next/Continue clicks ignore it. | A "dry-run probe" built on today's `dryRun` would type into and advance live applications. The probe must be built (or `dryRun` made honest) before any live use. |
| A2 | **P** | 15 `assist_blocked` exits in `assistApply`; e.g. a guard wall returns at `applyRunner.js:512-525`. Mitigations already shipped: the window is left open (`sessionLeftOpen`), state is checkpointed so a retry resumes from the saved URL (`applicationState`, `applicationResume`), and v0.2.2's "Sign in once, retry all". | "Starts a new session and fills again" overstates it; the missing piece is waiting in-run. |
| A3 | **C** | Checked the adapters, as asked: `platforms/workday.js` maps first name, last name, email, phone and a resume input only; the other adapters are 16-23 lines of the same kind. `formPrefill.js:74,86` deliberately refuses school/degree/employer labels. No repeated-section ("Add another") code exists in `src/apply/` or `src/automation/`. | |
| A4 | **C** | By design: free-text questions are never answered. | Feature, not defect. |
| A5 | **C** | No similarity or fingerprint matching in `screeningQA.js` or `questionQueue.js`. | |
| A6 | **C** | `screeningQA.js:185-196`: subject-specific "years of X" needs its own saved answer. | |
| A7 | **C** | Exactly one re-scan per step (`applyRunner.js:576-582`). | |
| A8 | **C** | `domScanner.js:503-532` counts open-shadow controls only to report an unreadable form. | |
| A9 | **D** | The waits are already condition waits with caps: `waitForFormOrWayIn` returns on the first 400 ms poll that finds a form (`applyRunner.js:1509-1519`); typeahead uses `waitForSelector(…, {timeout: 1500})`, which returns on the first option (`fieldFiller.js:163`); `waitForSettledPage` is the "quiet DOM" wait the audit proposes (`navigator.js:291-311`). | Only residue: about 1 s minimum settle (three 350 ms polls). Drop from the plan. |
| A10 | **C** | Letter written as `.txt` (`pipeline/index.js:892`), resume as the DOCX (`:806`); alternates chosen by `accept` (`uploadRunner.js:312-315`). | |
| A11 | **P** | With a persistent profile the context is reused and each job gets a tab (`browser.js:36-60`). Runs are sequential. | Only the parallelism part stands. |
| A12 | **C** | `extension/content.js` (341 lines) has its own matching and reads at most 160 controls (`:63`); keyed by hand. | |
| A13 | **C** | Packet `formFields` is `job.formFields ?? []` (`pipeline/index.js:942`), rarely populated at prepare time. | |
| A14 | **C** | `assistApply` spans `applyRunner.js:75-1087` (~1,013 lines). | |
| A15 | **C** | No iCIMS, Taleo or Jobvite markup in `tests/node/fixtures/`. | |

### Discovery, scoring and speed

| ID | Verdict | Evidence | Notes / corrected description |
| --- | --- | --- | --- |
| D1 | **P** | No conditional requests or board fingerprints anywhere in `src/search` (the only ETag code is the dashboard's static assets). But detail fetches are skipped for stored postings (`detailBudget.js` `hydrateFromDetailCache`, test `detailCacheReuse`), and scoring skips unchanged jobs (`incrementalDiscovery.test.js`). | What repeats is the **listing** requests. Per SUPPORT_MATRIX, Workday search pages are ~96% of wall clock, so the speed claim holds; the fix is narrower than "incremental discovery". |
| D2 | **C** | `searchFn` returns the full list at the end; `onSource` hooks report counts only (`search/index.js:164-194`). | |
| D3 | **C** | Same as R13. | |
| D4 | **C** | Score vocabulary is config-only; no coverage measure. | Design gap. |
| D5 | **P** | Measured (`d5_measure.mjs`, 50,000 synthetic jobs with ~8 KB JDs): summary projection 290 ms, RSS 432 MB; `SELECT *` 661 ms, RSS 826 MB; `count(*)` 0 ms. The dashboard **already** uses the summary projection (`data.js:600-603`). `SELECT *` remains in CLI paths: `jobTracker.js:101`, `index.js:593,636`, `commands.js:265`. The dashboard still loads all summary rows and pages in JS (`data.js:1697`): 290 ms blocking per uncached list at 50k rows. | Worth SQL paging on the board; an FTS5 index and worker thread are not justified by this measurement. |
| D6 | **P** | `parseAnnualSalary` exists (`searchConstraints.js:142`) and is used for constraints; nothing is stored, so the list cannot sort or filter by pay. | |
| D7 | **C** | `utils/usGeography.js`, `targetAnnualUSD`. | Low. |

### Platform, code health, tests, security

| ID | Verdict | Evidence | Notes |
| --- | --- | --- | --- |
| P1 | **C (counts) / D (remedy)** | `data.js` 3,397, `tailor.py` 2,520, `server.js` 2,473, `db.js` 1,687, `pipeline/index.js` 1,472; front-end JS 12,104 lines. | A wholesale split carries risk without a behaviour gain. Split only where a planned change needs it: `assistApply` (A14), and a structure module out of `tailor.py` (R4, R5, R14). |
| P2 | **C** | `grep -ri hyperlink tests/` finds nothing; R1-R5 pass the current suite. | |
| P3 | **C** | `PLAYWRIGHT_BROWSERS_PATH=<empty dir> npm test`: **14 files failed, 2,971 passed, 168 skipped**. The same 14 the audit names (autoSubmitTightening, dashboardAutoApplyE2E, dashboardAutofillJourney, dashboardEditableAnswers, extensionAriaRequired, extensionE2E, humanSubmitDetection, landingPageIncidentalInputs, landingPageNavigation, postSubmitDestination, seeWhatStoppedIt, settleUnverifiedSubmission, sponsorshipChoiceCommit, uploadInputSelection). 24 files already use `browserUnavailable`. | |
| P4 | **C (judgment)** | R3 and R13 show the drift. | Share only what has drifted: phrase normalization and the bullet/heading tables. |
| P5 | **C** | No plain statement that resumes, answers and the DB are unencrypted; only the export can be encrypted (`USER_GUIDE.md:882`). | |
| P6 | **P** | Launchers already run `npm ci` and `npx playwright install chromium` and seed config (`prepareLaunch.mjs:15-123`). They do not create the Python venv. | |

### README, docs and Explore

| ID | Verdict | Evidence | Notes |
| --- | --- | --- | --- |
| X1 | **C** | `content-overview.js:124` (public) and `:657` (working folder): "Nothing is added, removed or reworded." Page fit omits bullets by default (`max_pages` 2) and accepted rewrites reword. | Still present in the uncommitted rebuild. |
| X2 | **C** | `README.md:244` lists five fixture-verified ATSs. The `ats_live` check (`autoApplyEligibility.js:121-128`) is enforced by the batch route (`server.js:1790`), so every ATS is refused today. | |
| X3 | **C (worse)** | `README.md:416`. Grounded letters and rewrites send resume text. Worse: see N1, which shows grounded letters also send contact details, contradicting `.env.example:184-185`. | |
| X4 | **C in public; partly addressed in working folder** | Public register (37 rows) has no palette, hidden conditions, evidence map, sign-in batching, master cover letter or Compare with master. The working-folder rebuild adds palette, evidence and sign-in-once; not the others. | |
| X5 | **C in public; partly addressed in working folder** | Public examples are data-engineering titles. The working-folder rebuild adds personas (regulatory, SOC analyst, clinical trial associate). | |
| X6 | **C** | `package.json` `0.2.0`; `changelog-data.js:22` `v0.2.2`. | |
| X7 | **C** | `README.md:290` names Workable and SmartRecruiters; `config/jobboards.json` `ats-search.providers` = workable, smartrecruiters, themuse. Also, SUPPORT_MATRIX contradicts itself (N6). | |

Totals: **43 confirmed, 8 partly, 1 disagree (A9), 0 already fixed** (R15 was
partly fixed by `71105a6`). Of the confirmed, R4, R16 and X3 are worse than
described, and A1's proposed fix rests on a false premise (N2). One sub-claim was
not reproduced (a link-only table cell in R10). P1 and P4 are confirmed as facts,
with narrower remedies.

## 3. New findings

| ID | Severity | Finding | Evidence |
| --- | --- | --- | --- |
| N1 | **High** | **Grounded cover letters send the person's name, phone, email and city to the model provider.** `groundedLetter.js:109` sends every unit of kind `bullet` **or `paragraph`**, and `master_units` classifies the name line and the contact line as `paragraph`. Contradicts `.env.example:184-185` ("Contact details … are never sent") and the README. Rewrites (`rewrites.js:154`) and reply drafts (`inbox/draftReply.js:70`) send bullets only and are fine. | `x3_letter_payload.mjs` prints `u0: Jordan Example`, `u1: Springfield, IL \| 555-010-0000 \| jordan@example.com` under "RESUME UNITS". |
| N2 | **High (safety of the plan)** | **`assistApply({dryRun:true})` types into the form and clicks Next.** Only the static plan and uploads honour it. The JSDoc (`applyRunner.js:69`) says "resolve-only (no typing/attaching)". | `applyRunner.js:319, 554, 568, 580, 640`; `grep dryRun` shows no other gate. |
| N3 | Medium | **An accepted rewrite on a bullet containing a link writes text nobody accepted.** The link text survives after the rewrite, and the truth invariant passes because it re-reads `paragraph.text`. | Output: `'Published the Airflow pipeline design on the team blog.example.com/post'` (rewrite + leftover link). |
| N4 | Medium | **A resume whose contact details sit in the page header gets a Chromium PDF with no contact details, reported "ok".** The completeness check compares against body paragraphs only. | `r1_pdf.mjs` on a header-contact DOCX → `{"exported":true,"pages":1,"reason":"ok (Chromium)"}`; email absent from the HTML. |
| N5 | ~~Low~~ **Withdrawn (Phase 0)** | ~~`npm run doctor` counts jobs with `listJobs({}).length`.~~ Wrong: `doctor.js:320-322` runs `SELECT count(*)` whenever the database exposes `prepare`, which the real one always does; `listJobs().length` is only the fallback for test stubs. | Re-read during Phase 0; nothing to fix. |
| N6 | Low | SUPPORT_MATRIX says keyless aggregators including The Muse were "rejected on yield", while The Muse is an enabled provider and listed in the same file's table. | `docs/SUPPORT_MATRIX.md` ("Reaching LinkedIn…" section) vs the discovery table and `config/jobboards.json`. |
| N7 | Low | `npm run lint` silently skips Python lint when ruff is absent, and ruff is not in `requirements.txt`, so a fresh setup never lints Python locally. | Baseline lint output; `scripts/lint.mjs:39-40`. |
| N8 | Medium | **A DOCX that still has tables prints a PDF without the table rows, reported "ok".** `docx_to_html` reads body paragraphs only and its completeness list has the same blind spot. Reachable whenever tailoring falls back to the master (R10/R11) and the preview route converts `resume_path`. | Found in Phase 0 by the corpus; `r1_pdf.mjs` on a master with a table → `exported: true`, table rows absent. |
| N9 | Medium | **A resume with typed "•" bullets never gets a Chromium PDF.** `docx_to_html` turns the glyph into a list marker, but the completeness list keeps "• …", so Chromium refuses ("would leave out 5 paragraph(s)"). | Found in Phase 0 by the corpus (`pdf_written[supported_typed_glyph]`). |

Not covered: `data.js` and the dashboard front end were read only where a finding
led there (D5); no line-by-line pass was made. `extension/` was checked for A12
only.

## 4. Revised plan

Changes from the original, and why:

| Phase | Scope | Change and reason |
| --- | --- | --- |
| 0 | X1, X2, X3 **+ N1**, X6, X7 **+ N6**, P3, N5, N7 (add ruff to a dev requirements file), resume corpus | **N1 moves to Phase 0**: it is a privacy defect in code, not only a doc gap, and the fix (send only `bullet` units, or strip a contact-shaped unit) is small and testable. X4/X5 stay in Phase 6 but should be reconciled with the uncommitted working-folder rebuild (Q5). The corpus starts from the scripts in this folder, plus header-contact, link-in-table and link-in-bullet cases. |
| 1 | R1 + R10 + R16/N3 + N4 together (one "hyperlink- and header-aware text" change), R2, R3, R4, R5, R8, R9, R11 (per-step rollback), evidence service (R13/D3), F4 | **R1, R10, R16, N3 and N4 share one root cause**: run iteration skips hyperlinks and the header. Fix it once. **R11 moves up from Phase 2**: today one of these defects throws away the whole tailoring. R4 and R5 are one change (section-scoped structure detection). |
| 2 | R6/R7 (pending Q2), R17, then R12, R14, R15 | R10, R11 and R16 move to Phase 1. R6/R7 cannot be "measured" without a renderer that matches the uploaded file (Q2). |
| 3 | A14, **N2 (honest dry run)**, A7, A8, A10, A15, coverage probe (A1, A13) | **A9 dropped** (already condition-based). **N2 must land before any probe** touches a live page; the probe is new code, not a reuse of `dryRun`. |
| 4 | A2 (in-run waiting), A3, A5, A6, A4, A11 (parallel tabs only), A12, first supervised live run | A11 narrowed: context reuse already exists. |
| 5 | D1 (listing fingerprints, Workday first), D2, D4, D5 (SQL paging for the board; CLI `SELECT *` call sites), D6 (store parsed range) | D5 narrowed by measurement; no worker thread or FTS5 without a further measurement. D6 narrowed: the parser exists. **P1/P4 removed as standalone work**; splits happen inside A14 and the R4/R5 structure module. |
| 6 | F6, F9, F10, F11, F12, D7, P5, P6 (venv step), Explore (X4, X5) | P6 narrowed to the missing Python step. |

## 5. Open questions for you

1. **Where does this work live?** I created `JobAgent-Nov14` in `JobAgent-public` (the audited repo). Your earlier rule keeps `docs/audits/` out of the public repo, so this report and its scripts are **untracked** there. Should Phase 0+ also be replayed into the working folder, and should the report be committed anywhere?
2. **Page measurement (R6/R7).** Word automation timed out from this session and LibreOffice is not installed. Options: (a) you approve Word automation once, or install LibreOffice, so I can measure the corpus; (b) make the Chromium PDF the uploaded resume when it exists, and fit pages against that render, so the measured file *is* the uploaded file; (c) keep the estimate but fix its inherited-style blind spots. I recommend (b) plus (c), with (a) for calibration.
3. **N1 fix.** Send only `bullet` units to the letter model (simplest, may weaken letters that cite summary paragraphs), or keep summary paragraphs and drop the name and contact lines by position and shape? I recommend the second, with a test that no email, phone or name reaches the payload.
4. **N2.** Make `dryRun` truly side-effect free (gate the dynamic fill, conditional fill and every navigation click), or rename it to what it does? I recommend making it honest; existing tests that use it will show what depends on today's behaviour.
5. **Explore (X1, X4, X5).** The working folder has an uncommitted rebuild on `feat/explore-launch-film`. Should Phase 0's X1 wording fix go into that rebuild, the public copy, or both?
6. **Focus line (R9).** Remove the option, or keep it off by default with the resume's own spelling and an "added" label in review?
7. **Live runs.** Phase 3's probe and Phase 4's supervised run touch real employer sites. Per your rules I will not run either without your explicit go-ahead, even after N2 is fixed.

## 6. Phase 0 results (2026-11-15)

Branch `JobAgent-Nov14`, 8 commits on `eca8322`. Report and scripts remain local and uncommitted.

| Commit | IDs | Change |
| --- | --- | --- |
| `fa4e93a` | P3 | `launchOrSkip` / `skipWithoutBrowser` helpers; the 14 browser files skip without Chromium |
| `043ecb2` | N1, X3 | `src/llm/identityUnits.js`; letters, rewrites, reply drafts and Rank by meaning never send name/contact lines; README, .env.example, User Guide, SECURITY.md list what each feature sends |
| `9d75a4f` | X2 | README and User Guide gate lists include the live-run record |
| `ae12bd2` | X7, N6 | README names The Muse; SUPPORT_MATRIX no longer lists it as rejected |
| `f2fe326` | X1 | Explore Tailor chapter says what is true |
| `0e6813c` | X6 | package.json 0.2.3 is the one source; MCP reads it; `npm run verify` checks lockfile and changelog |
| `b28f2df` | N7 | ruff 0.17.5 pinned; CI and `npm run lint` use it; LICENSE_REVIEW Python pins updated |
| `7e5c71b` | P2 | 22-layout resume corpus, 30 strict xfails for open bugs |

N5 was withdrawn (doctor already counts with SQL). Suite: Node 3,169 passed / 3 skipped (baseline 3,136 / 3); without Chromium 0 failures; pytest 197 passed / 30 xfailed (baseline 106); lint 0 errors and ruff runs; verify 7/7.

## 7. Phase 1 results (2026-11-15)

Branch `JobAgent-Nov14`, 13 commits on `7e5c71b`, not pushed. Report and scripts remain local and uncommitted.

| Commit | IDs | Change |
| --- | --- | --- |
| `3ce961f` | S1 | One-line setup card replaces the 19-line template notice; grouped from the detector (20 entries → 13 items); Next says "Run your first search"; no CLI on setup surfaces |
| `6f032bc` | R1, R10, R16/N3, N4, N8, N9 | `_inline_items` reads linked runs; PDF prints links, page headers, tables, typed bullets; right tab stop for dated two-cell rows; rewrite notes a dropped link |
| `a304055` | R2, R3 | `evidence.py` + `evidence_rules.json`: everyday terms need a list, a neighbouring technology or an anchor; plurals count; posting side uses it too |
| `0b13f90` | R4, R5 | Roles only outside non-employment sections; wider typed-bullet glyph set |
| `2071dac` | R8 | Bold only on summary, skills and bullets; identical runs merged first |
| `5baa791` | R9 | Focus line removed (option, CLI field, runner, pipeline, regenerate script) |
| `516ea04` | R11 | Optional steps rolled back alone and listed; per-step checks only when the final check fails; invariant crash on a lost paragraph fixed |
| `65ef970` | R13, D3 | `evidence.js` twin, shared cases; scorer judges gaps on the master's lines, body and title; tailor gets the same lines, vocabulary and gap terms; fingerprint includes rules version and resume digest |
| `cfc8436` | F4 | Resume check on upload (`readiness.py`), route cached by mtime, Master resume dialog section |
| `4c512fd` | R16 (rest) | Skills lines and cells with a link: link-aware offsets; cells with links left alone |
| `18cf5f3` | S1 (rest) | System health fixes without CLI (`healthFixes.js`); Export everything button and download route |
| `07c1392` | R2, R13 | Rust is a skill; Spring needs context ("Colorado Springs", "Spring, Texas") |
| `d783bf4` | — | Capability register: setup card, resume check |

Suite: Node 3,277 passed / 3 skipped (baseline 3,169 / 3); pytest 320 passed / 4 xfailed (baseline 197 / 30); lint 0 errors, 12 warnings (baseline 13); typecheck clean; verify 7/7.

Rescore impact, measured on copies (old code `516ea04` vs new, same rows, fingerprints cleared in both):

| Profile | Rows | Score changed | Tier | Status | Gap list changed |
| --- | --- | --- | --- | --- | --- |
| Profile A (owner) | 2,891 (81 scored, 2,810 needs description) | 120, all needs-description, +1 or +2 ("pharmaceuticals" now matches "pharmaceutical") | 0 | 0 | 24 (16 scored): Tableau, Data Lake, SSIS removed (in the resume, not the profile); R added on 3 (asked, not in the resume) |
| Profile B (no own master resume) | 917 needs description | 0 | 0 | 0 | 3: llm added (posting says "LLMs"); spring removed on 2 HPE postings ("Spring, Texas") |

Not applied to real data: waiting for approval, then packet regeneration and approval reset.

Deferred: per-person bold switch (R8); bullets marked only by indentation (R5); "Go, R and Excel for reporting" counts Excel only with an unambiguous neighbour; R14, R15, R6/R7 in Phase 2; Python setup has no screen until P6.

## 8. Design findings for a later design pass (DS series)

Reported by the impeccable design hook on `src/dashboard/public/index.html` (2026-11-15), attribution unknown: they cover the whole page and predate this branch (its only edit to that file is one line of banner text). Numbered DS because D1-D7 are discovery items. Left as they are, by decision.

| ID | Finding | Notes |
| --- | --- | --- |
| DS1 | Cramped padding: text too close to a bordered or coloured container's edge | The hook names no element; needs a page pass. |
| DS2 | Cramped padding (second instance) | As DS1. |
| DS3 | Flat type hierarchy: heading and body sizes within 1.25x at every step | Page-wide type scale. |
| DS4 | Nested cards | Likely the Next panel and the detail panel inside the right rail, and setup or notice cards inside panels. |
| DS5 | Auto-scrolling marquee | The run line along the top edge: `#runline` (`index.html:217`), whose bar `#runlineFill` slides on an infinite loop while a run has no total (`.runline.indeterminate i`, `@keyframes slide`, `app.css:838-850`). The only other horizontal loops are loading indicators on a pseudo-element (`boardsweep`, the 2 px sweep on a slow board query, `app.css:1665-1676`) and the skeleton shimmer (`sk`, `app.css:3255-3261`). All stop after one pass under `prefers-reduced-motion`. Loading feedback, not scrolling content; not changed. |

## 9. Decisions log

Format: date · ID · decision · why. Rule set by the owner (2026-11-15): take the option this report recommends, else the safest reasonable one; anything that writes real data, touches a live site, pushes or merges is Pending, never done.

| Date | ID | Decision | Why |
| --- | --- | --- | --- |
| 2026-11-15 | S1 | Setup items counted as 13 things to fill in, not 20 stored copies | The owner's grouping; the detector's `ok` is unchanged, so the hold on applying is identical |
| 2026-11-15 | R9 | Remove the focus line entirely, with its regenerate script | Owner decision (Q6) |
| 2026-11-15 | R11 | Table flattening stays non-optional; a failure there still falls back to the master | Skipping it would need a relaxed ATS-structure check |
| 2026-11-15 | R13 | Evidence = the master resume's lines; profile terms only without a resume; title counts as asking | One source for score and packet; the title-only regression (Snowflake) found on copies |
| 2026-11-15 | R2 | Rust is not an everyday term; Spring is | Measured on copies: a Rust GPU posting lost its Rust gap; "Colorado Springs" and "Spring, Texas" read as Spring |
| 2026-11-15 | DS1-5 | Design findings left for a design pass, numbered DS (D1-D7 are discovery) | Owner decision |
| 2026-11-15 | Rescore | Real-data rescore deferred to merge time (end of plan) | Owner decision; the working folder still runs old scoring and would rescore back |
| 2026-11-15 | R6 | LibreOffice 26.8.3 installed with Homebrew; page fit measured by it when present (`RESUME_MEASURE_PAGES`, default on), estimate as fallback | Audit Q2 recommendation (b)+(c), with LibreOffice for calibration; Word automation timed out in Phase 0 |
| 2026-11-15 | R6 | Estimate calibrated against LibreOffice, not Word; Georgia and Times widths set to published ratios | The fit drove them to implausible values (the variants could not pin width); measured error unchanged |
| 2026-11-15 | R6 | Two tailor tests and one corpus check re-based on the render | They pinned the old estimate ("40 bullets = 1-2 pages"; LibreOffice says 3.07) |
| 2026-11-15 | R7 | PDF export order LibreOffice, Word, Chromium | Audit R7 "prefer LibreOffice when installed"; Word automation hangs headless |
| 2026-11-15 | R14 | Synonyms in config/ats_resume.json (shipped config), not the person's profile | The audit's "a synonyms list in config"; empty by default, built-in list widened |
| 2026-11-15 | R12 | Approved phrases go to the profile's new `searchIntent.watchSkills` (feeds market vocabulary), not scoring.json | scoring.json is regenerated on activation; the profile is the source of truth |
| 2026-11-15 | R17 | Pool of 2 workers by default (JOB_AGENT_PYTHON_WORKERS 1-4; JOB_AGENT_PYTHON_WORKER=off for one-shot) | Audit "two to four workers"; 2 keeps memory modest |
| 2026-11-15 | N2 | Dry run also skips opening dropdowns and saving state, and stops on page one | Owner: "dry run must have no side effects"; the verify gate line kept verbatim, dry-run gate added beside it |
| 2026-11-16 | A14 | Submit gate and its two verify-checked lines stay in applyRunner.js; stages module cannot submit (test-enforced) | `npm run verify` must stay unchanged; the gate is the one place a click can submit |
| 2026-11-16 | A7 | MAX_RESCANS = 4 (five levels per page) | More than any real form asks; the cap stops an endless one |
| 2026-11-16 | A8 | Shadow-aware required-field check changed in the same commit as shadow reading | Otherwise shadow forms would reach the gate with blank required fields looking complete |
| 2026-11-16 | A10 | Letter PDF rendered only from a freshly written DOCX; stale PDF always deleted first; JOB_AGENT_LETTER_PDF=off in tests | A PDF of replaced text would be uploaded to an employer |
| 2026-11-16 | A15 | Fixtures hand-written and labelled "not captured"; matrix says live run none | Live capture needs owner approval; honesty over coverage claims |
| 2026-11-16 | A1 | Probe refuses non-local URLs in code; live probe stays Pending | Hard limit: no live-site actions without asking |
| 2026-11-16 | A2 | Wait is a bounded helper at the three guard sites, not a new state in TRANSITIONS; off by default; headed-only from config; capped 15 min | The helper re-inspects and the existing guard check decides, so waiting cannot skip a guard; no change to the transition table or the submit gate |
| 2026-11-16 | A5 | Suggest-and-confirm only; threshold 0.75; sensitive, pay, skill-years, other-country, employer questions excluded; pattern added to the existing entry, so its answer and checks are unchanged | A wrong 'same question' types a wrong answer on an application |
| 2026-11-16 | A6 | Years suggested from role text (title + highlights, whole word) because roles carry no skill tags; floored; year-only dates conservative; saved in the profile's background.skillExperience | candidate.json is regenerated on activation, so a value only there would vanish |
| 2026-11-16 | A3 | Adapters verified first (workday.js maps 4 fields + resume; none handle repeated sections). Built generic label-driven filler, Workday-shaped fixture only; runs before the generic pass; 'Add' pressed only when it names work/education | The safe-controls rule never covered 'Add'; this is a new click category, so it is narrow and tested for not pressing other Add buttons |
| 2026-11-16 | A4 | Draft shown, never saved; approval is per answer and per job (data/approved_answers.json); refuses fact questions (eligibility, pay, history, health, skill-years) via draftGuard; approved text injected as exact-question screening entries for that job only | A fact answer from a model, or a 'why us' answer reused at another employer, would be untrue on an application |
| 2026-11-16 | A11 | Parallelism only on the runAssist batch (default 1, max 3, never two on one registrable host); first persistent launch single-flight. Dashboard batch loop left sequential: PARTIAL | The dashboard loop mixes prepare/approve/fill with shared runState; racing it risks wrong progress and cancel behaviour |
| 2026-11-16 | A12 | Shared module is generated into the extension (classic script) with a drift test, because an MV3 content script cannot import the repo's ES module; pairing code gives the existing key, kept in data/extension_key (0600) when the env key is unset; manual key paste kept | Avoids a bundler/runtime dependency; keeps the key's strength and the extension's trust boundary unchanged |
| 2026-11-16 | env | tests/node/gapAgreement.test.js fails in the user's working tree when config/scoring.json holds another profile's marketSkills (their dashboard switched the active profile to another person at 17:56). Passes on a clean HEAD worktree. NOT changed: the user's live config is off limits. Gates for A12 were run in a clean worktree (scratchpad/cleangate.sh) | Hard limit: never write the user's real config |
| 2026-11-16 | D6 | Pay stored as annual USD + period + source; backfill runs in re-score (so the real-data backfill happens at merge-time rescore, which is already Pending); API sort only, no board column/filter yet | Schema 5 migration is additive; no write to real data was made here |
| 2026-11-16 | D5 | Board SQL paging already existed (listJobsSummaryPage); fixed the two report SELECT * sites. FTS5, worker-thread bulk reads, Node upper-bound pin DEFERRED | FTS5 changes the store (real data) and the tested upper Node bound is unknown (running Node 25.9); no evidence to pin |
| 2026-11-16 | D4 | Threshold 40% of postings with >=5 vocabulary terms, min sample 50, sample 1,500; warn only, no score change | A warning with named phrases is actionable; auto-adding terms would change every score |
| 2026-11-16 | F10 | Server-rendered printable page (escaped, script-free) rather than an in-dialog print, so it prints as one page; shown only at Interviewing; quoted content only | No model and no invented text; the CSP forbids inline script, so no print button script |
| 2026-11-16 | F9 | Most of F9 already existed (P2-9 conversion + calibration reading outcomes); added role family, resume (tailored/master) and offer rate. 'Resume version' read as tailored vs master, not version number | Version numbers are per-job, so they cannot be compared across jobs |
| 2026-11-16 | P5 | Sign-out removes only the active profile's .browser-profile-<id>[-channel] folders, after confirm, refusing when open or a run is active; encrypted workspace not built (audit says 'later') | Deleting the wrong person's sign-ins, or a folder a live browser holds, would be worse than none |
| 2026-11-16 | DS1-DS5 | DEFERRED: the hook names no elements for DS1-DS4, and the owner earlier chose to leave them for a design pass; DS5 is loading feedback that already stops under reduced motion | A redesign without named targets or the owner's eyes risks churn |
| 2026-11-16 | F12 | Extended the one shared launch script (all three launchers call it) instead of writing new per-OS installers; Python offered on first launch, `setup:all` does everything and ends on doctor | Three new scripts would drift from the launchers, which the existing design avoids |
| 2026-11-16 | F11 | Print by default; install only on an explicit --install the person runs; not installed here | Installing writes outside the repo (LaunchAgents, crontab), which is the owner's call |
| 2026-11-16 | D1 | Workday only; fingerprint = total + first-page ids; skipped runs return `cached` so expireUnlisted ignores them; full sweep every 3 days; no ETag (CXS POST has none) | Without the `cached` mark, skipped pages would retire live postings after N runs |
| 2026-11-16 | D2 | DEFERRED: scoring runs after a cross-source pass (dedupe, US gate, freshness, exclusions); streaming per source would show jobs later excluded. Per-source found counts already stream | Needs a pipeline restructure with measurement |
| 2026-11-16 | F6 | DEFERRED: a bullet library needs the owner's design (where alternate versions are written and edited); the tailor must keep every word the person's | Large feature; design input required |
| 2026-11-16 | D7 | DEFERRED: its own precondition ('before adding non-US sources') is not met; no non-US source is planned | No evidence of need yet |
| 2026-11-15 | R2 | NVIDIA "Senior Analytics Engineer, Finance" R gap kept: no fix | The posting says "(Python, R, machine learning concepts, Snowflake)": R in a list next to Python is the language, and the resume does not show it |

## 10. Progress log

Updated after every commit. To resume: read this section, `git log --oneline 7e5c71b..HEAD`, and run the full gate.

| When | Commit | Item | State |
| --- | --- | --- | --- |
| 2026-11-15 | 3ce961f…d783bf4 | Phase 1 (S1, R1-R5, R8-R11, R13, R16, F4) | Done, 13 commits |
| 2026-11-15 | — | Real-data rescore | Pending (merge time) |
| 2026-11-15 | 810e891 | R6 measured page fit, style-aware estimate | Done |
| 2026-11-15 | eb82ea3 | R7 PDF = the DOCX via LibreOffice; Chromium fallback fidelity | Done |
| 2026-11-15 | 0c8a8fe | R14 section names by kind, config synonyms, structural headings | Done |
| 2026-11-15 | cd04512 | R15 text boxes in the PDF | Done |
| 2026-11-15 | d1d54f0 | R12 requirement phrases outside the vocabulary; watchSkills | Done |
| 2026-11-15 | 4137151 | R17 long-lived Python workers (100 → 24 ms per request) | Done. **Phase 2 complete.** |
| 2026-11-15 | f7a7658 | N2 dry run has no side effects (Phase 3, first item) | Done |
| 2026-11-15 | 817359b, f12923d | v0.2.3 changelog finalized; `JobAgent-Nov14` merged into `main` (merge commit) and **pushed** to origin (`eca8322..f12923d`), on the owner's explicit instruction | Done. Branch `JobAgent-Nov14` itself not pushed; `../JobAgent` untouched |
| 2026-11-16 | 8670261 | A14 assistApply as a state machine (applyRunner.js 280 lines, assistStages.js, assistSupport.js); the submit gate and `npm run verify` untouched | Done |
| 2026-11-16 | 88e93f0 | A7 bounded re-scan loop (MAX_RESCANS 4) | Done |
| 2026-11-16 | 46fdb87 | A8 open shadow roots read by scanner, validation check and the gate's required-field check | Done |
| 2026-11-16 | bdf3927 | A10 cover letter PDF beside txt/docx; stale PDF removed on edit/restore; JOB_AGENT_LETTER_PDF=off | Done |
| 2026-11-16 | 7229691 | A15 iCIMS/Taleo/Jobvite hand-written fixtures + matrix (all five tests passed first run; no code change needed) | Done |
| 2026-11-16 | 45446ef | A1/A13 coverage probe on saved pages only; refuses non-local URLs; per-ATS table in System health; packets carry probed required questions. **Phase 3 complete** except the live probe (Pending: owner go-ahead). | Done |
| 2026-11-16 | — | **Stopped after Phase 3.** Resume at Phase 4: A2 (pause and continue: wait in-run for a wall to clear, resume the same step), A3 (work history and education filler; verify the platform adapters first, fixtures only), A5, A6, A4, A11 (parallel tabs only), A12 (extension). Everything on fixture forms; the first supervised live run stays Pending. Baseline at stop: Node 3,344 passed / 3 skipped; pytest 375; lint 0 errors (12 warnings); typecheck clean; verify 7/7. `main` is at f12923d (pushed); `JobAgent-Nov14` is 6 commits ahead of it, not pushed. | |
| 2026-11-15 | — | **Earlier stop note (superseded).** | Resume at Phase 3: A14 (assistApply as a state machine; keep every existing applyRunner/autofill test green and `npm run verify` unchanged), then A7, A8, A10, A15, then the coverage probe on fixtures only (A1, A13, building on the N2 dry run). Then Phases 4, 5, 6 and the Explore rebuild as listed in the owner's plan. Baseline at stop: Node 3,298 passed / 3 skipped; pytest 375 passed / 0 xfailed; lint 0 errors (12 warnings); typecheck clean; verify 7/7. |
| 2026-11-16 | 858ccb5 | A2 wait on a wall (ASSIST_WAIT_FOR_WALL_SECONDS / waitForWallMs); 4 real-browser tests | Done |
| 2026-11-16 | 5a721b9 | A5 reworded-question suggestion, A6 skill years from work history (confirm to save); 28 tests | Done |
| 2026-11-16 | 8279011 | A3 work history + education filler (fixture only; no live Workday run) | Done |
| 2026-11-16 | 5533f8c | A4 grounded draft answers, per-job approval, UI panel in job detail; model stubbed in tests (no real model call) | Done |
| 2026-11-16 | 2d80df3 | A11 parallel tabs on the runAssist batch (scheduler + single-flight launch; 11 tests); dashboard batch still sequential (Deferred, see Decisions) | Partial |
| 2026-11-16 | 8545ed9 | A12 extension: shared field mapping (generated copy + drift test), pairing code, 400-control cap; 20 tests. Full gate run in a clean worktree because the user's live config changed (see Decisions: env) | Done |
| 2026-11-16 | e969cee | D6 stored pay range (schema 5, backfill in rescore, detail line, sort=pay), D5 report reads; 14 tests | Done (D5 partial) |
| 2026-11-16 | cfd35c5 | D4 vocabulary coverage check in System health (warns <40%, names asked-for phrases); 10 tests | Done |
| 2026-11-16 | d1b974a | F10 interview prep pack (JSON + printable page, link at Interviewing); 10 tests | Done |
| 2026-11-16 | a6e2c6b | F9 role family + resume groups and offer rates in What gets interviews; 5 tests | Done |
| 2026-11-16 | 2159ea8 | P5 sign out everywhere (System health) + SECURITY.md on unencrypted files; 8 tests | Done |
| 2026-11-16 | 90a6387 | F12 Python venv setup in the launcher + npm run setup:all; 6 tests | Done |
| 2026-11-16 | d8afa2a | F11 npm run schedule (launchd/cron/Task Scheduler entry, --install/--remove); 9 tests | Done |
| 2026-11-16 | eec2756 | D1 Workday unchanged-board skip with 3-day full sweep; 7 tests | Done (Workday only) |
| 2026-11-16 | 9265b3f | **Stopped: plan complete as far as allowed.** Phase 4, 5, 6 done or deferred (see Decisions). Pending owner action: real-data backup + rescore (also backfills pay, D6), merge into ../JobAgent, live coverage probe, first supervised live run, push, Explore rebuild (prompt never attached), installing the daily schedule. Final: Node 3,512 passed / 3 skipped; pytest 375; lint 0 errors (12 warnings); typecheck clean; verify healthy. | Done |
