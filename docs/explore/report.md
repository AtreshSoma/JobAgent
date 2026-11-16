# Explore JobAgent: the rebuild, verified

Branch `explore-product-film`, from `main` at `8bc42f8`. Nothing is pushed.

Commits:

| Commit | What |
| --- | --- |
| `5b33fe6`, `1fb010c`, `91abf18` | Critique, truth audit, storyboard, design preview (the approval gate) |
| `0131350` | One story for six fields, told for a first-time visitor |
| `81f2480` | The hero after a resize, the clipped headline, and signals you press |
| this commit | Wide screens, phone fixes, skip link, report |

## 1. Critique outcome

56 rows in `critique.md`: 52 distinct issues (1 P0, 19 P1, 27 P2, 5 P3).

| | Count |
| --- | --- |
| Fixed | 47 |
| Partly fixed | 3 |
| Deferred | 2 |

Partly fixed: **V8** (phones: walls of rows are gone, but the page is still long, since every picture plays once in turn); **V10** (dark theme: the Discover sheet's edge against the near-black page is unchanged); **V11** (the far cards of the hero are larger, and still softened by depth on purpose).

Deferred, with the reason:

- **V6, Under the hood restyle.** Its sections keep their structure and their grotesk headings; the stale lines in it are corrected (T1 to T7), its tables stack on phones and its touch targets meet 44 px. Bringing every diagram into the Overview's serif and grounds is a large rework of `deep.js`, beyond the brief's "closer".
- **P1, the 120 ms task while the page builds.** Building the Overview takes one task on load, before anything is scrolled. The trace shows no long task while scrolling slowly or in fast flicks.

The owner's review on 2026-11-16 added four issues, all fixed:

| Issue | Cause | Fix |
| --- | --- | --- |
| Headline clipped to "All the worl" at wide windows | Font size grew with the window, not with its column | Capped by the hero's own width (`12.2cqi`). A test checks 1180, 1440, 1997 and 2560 px |
| After a resize, the hero stayed faded, the headline shifted and the chapter rail stayed out | CSS `scroll-behavior: smooth` breaks ScrollTrigger's measurements: every trigger was placed off by the scroll distance | No CSS smoothing; in-page links glide from script. Regression test |
| Hero postings could end invisible after scrolling back | The scroll fade inherited the half-played entrance | Both ends stated, and nothing drawn until the page is scrolled |
| Header and skip link in the middle of a screenshot | A capture taller than the window paints sticky and fixed parts partway down. The same artifact appears in Playwright element captures | The skip link is clipped away until focused. The header is sticky by design; the review captures hide it |

## 2. First-time visitor results

| Person | Before: understands / for them / trusts | After |
| --- | --- | --- |
| Full-stack developer | Hero sentence / assumed / "127.0.0.1" | Hero sentence / the default example is their job / the three trust facts in the hero |
| Cloud security analyst | Hero / **no, at Discover** ("Excluded: requires a security clearance") / Never | Hero / a Security card in the hero and one press away, with a clearance tag and "Onsite for the first 90 days" read from the posting / hero trust facts |
| Regulatory affairs, pharma | Hero, roughly / **no, at the hero** / Never, if reached | Hero / "Pharma" in the picker; CMC, eCTD and Module 3 marked in the posting; the 6-year floor read and costing 2.7 points / hero trust facts and "Invents nothing" |
| Registered nurse | Partly / **no, at the hero** / only "Nothing is submitted" | Hero sentence in plain words / a Nursing card and option; the RN license read by the eligibility check; night shifts lifted out / hero trust facts; the FAQ answers "Is it only for tech jobs?" |
| Marketing manager | Hero / **no, by Score** / the contrast row | Hero / Marketing option; the resume reordered toward campaign and analytics lines; a portfolio link in the form / hero trust facts |

Jargon on the Overview is now refused by a test: ATS, packet, shortlist, 127.0.0.1, SQLite, Playwright, embeddings, JSON, adapters, LLM and IMAP.

## 3. Career switcher

Score and Tailor for every field, finished state, 1440 px: `after/fields/score-<field>.jpg` and `after/fields/tailor-<field>.jpg`.

| Field | Role family | Score | Verdict | What it teaches |
| --- | --- | --- | --- | --- |
| Software Engineer | software-engineering | 81 | Apply | Evidence lines; Also asked for; an on-call tag |
| Cybersecurity Analyst | security | 92 | Priority | "Onsite for the first 90 days"; a clearance posting set aside |
| Regulatory Affairs | regulatory-quality | 83 | Apply | 6+ years stated, one short, a stretch; CMC, eCTD, Module 3 |
| Registered Nurse | healthcare-clinical | 90 | Priority | RN license read; night shifts; a nurse practitioner posting held |
| Marketing Manager | marketing-growth | 80 | Apply | Campaign and analytics lines first; portfolio link |
| Financial Analyst | finance-accounting | 70 | Queue | Fully onsite against a wish for remote |

Every number is computed by `score-model.js` and checked against the real scorer (`exploreContent.test.js`). Every condition tag is the label the real reader (`src/scoring/hiddenClauses.js`) gives the sentence shown. Every tailored resume is checked by the real Compare with master (`src/resume/resumeDiff.js`): Added is 0.

## 4. Changes by section

Before images are in `before/`; after images are in `after/`.

| Section | Before | After |
| --- | --- | --- |
| Hero | Data engineer only; two jargon proof lines; clipped at wide windows | Plain sentence, three trust facts, field picker, a morning of eleven kinds of work, the score counting up as the posting comes forward. `hero-1440-light`, `hero-1997-light`, `hero-390-*` |
| Problem | 1.6 screens of half-lit words; contrast as a footnote | One beat: four frustrations crossed off by what JobAgent does about each, then the three ways side by side. `problem-*` |
| The whole route | Last, as a replay | Third, the reader's first look, in their field. `run-1440-light` |
| Discover | A depth field with 6.8 px text | Shallower depth; an employer's listing that carries other kinds of work; a condition tag that opens to its sentence |
| Score | Ten equal bars; the number disagreed with its bars mid-scroll | The number is the sum of what is counted; five reasons lead; evidence; Also asked for; What if. `score-1440-light` |
| Tailor | Two sheets that looked alike | A struck line, a lifted move, emphasis, "2 pages, measured", and the Compare with master ledger. `tailor-1440-dark` |
| You approve / You submit | Two nearly empty red frames | The whole hold plays: the posting waits at danger, the checks tick, your pointer presses, the lamp clears, the posting goes through. `signal-*` |
| Fill | Fields only | Readiness first; the open question left for you |
| Track | Board and history | Today, and a reply as a suggestion |
| Sources | A sparse dark frame | Three columns by what you do: on already (12), needs your key (2), links you give it (4). `sources-*` |
| Register | 41 rows, five groups closed | 63 capabilities; counts as filters; six areas; one spelled out: what, why, how. `register-*` |
| Questions | None | Seven, each backed. `faq-1440-light` |
| Close | Steps that were not real | Add your resume, confirm the job titles, run your first search. `close-1440-light` |

## 5. Browser matrix

Chromium (Playwright), served by the real dashboard under its real CSP.

| Matrix | Result |
| --- | --- |
| 1440x900, 1180x700, 768x1024, 390x844, 320x568; light and dark; motion on and reduced; both views (40 configurations, 1,534 frames) | No console or CSP error; no horizontal overflow |
| 1997x1161, 2560x1440 (wide) | Headline whole; pictures at full size |
| Every field at 1180x700 to 2560x1440 | Every picture at its natural size (no scaling under 1) |
| axe WCAG 2.2 AA, both views, both themes, 1280 and 390 | No violations (test suite) |

Safari and Firefox were not run.

## 6. Performance

Headless Chromium on this machine, 1440x900, pinned mode. The numbers compare builds on the same machine; they are not a promise about other hardware.

| Measure | Before | After |
| --- | --- | --- |
| Slow scroll, frames per second | 58.7 | 58.7 |
| Fast flicks, frames per second | 52.1 | 52.1 |
| Long tasks while scrolling | 0 slow, 0 fast, 1 back (52 ms) | 0 slow, 0 fast, 1 back (57 ms) |
| Layout shift on load | 0.278 | **0** |
| Layout shift, slow scroll | 0.100 (163 shifts) | **0.0016** (56) |
| Long task on load | 113 ms | 122 ms |
| Weight: script / styles / fonts | 339 / 129 / 111 KB | 407 / 162 / 111 KB |

No library was added.

## 7. Claims on the finished page

| Claim | Backed by |
| --- | --- |
| Runs on your computer; answers this computer only | `src/dashboard/server.js` (binds 127.0.0.1) |
| No account, no cloud service | `README.md`, `SECURITY.md` |
| Invents nothing; reordered, never added to | `src/resume/tailor.py`, `src/resume/resumeDiff.js` (Added 0, tested) |
| Never submits without you | `src/apply/autoApplyEligibility.js:124-128`, `config/verified_live_ats.json` (empty) |
| 26 job families | `config/role_families.json` (tested) |
| 18 sources: 12 on, 2 with a key, 4 from links | `src/search/index.js`, `config/jobboards.json` (tested) |
| Nine employer application systems | `src/search/index.js` (tested) |
| Score out of 100, same inputs same number; five verdicts | `src/scoring/scorer.js`, `src/scoring/explainScore.js` (tested) |
| Eleven kinds of hidden condition | `src/scoring/hiddenClauses.js` (tested) |
| Years, license and clearance read from a posting | `src/scoring/eligibility.js` (tested on the examples) |
| Evidence: one rule for score, application and gap list | `src/resume/evidence.js`, `src/resume/evidenceMap.js` |
| Two pages, measured | `src/resume/tailor_cli.py` (default 2, tested), `src/resume/pagefit.py` |
| Compare with master shows every move | `src/resume/resumeDiff.js` |
| Approval covers exactly what you saw; withdrawn on change | `src/apply/approvalDigest.js` |
| Stops before Submit, and for a sign-in, CAPTCHA or code | `src/automation/applyRunner.js`, `src/automation/assistStages.js` |
| A click is not proof: applied only on a confirmation | `src/automation/applyRunner.js` |
| Sign in once, retry all | `src/dashboard/public/assets/js/signin.js` |
| Answers kept per person; never guessed | `src/config/profileStore.js`, `src/apply/screeningQA.js` |
| Today | `src/dashboard/public/assets/js/today.js` |
| Replies read, never changed, suggested (Optional) | `src/inbox/sync.js` |
| No model unless you switch one on; identity lines removed first | `src/llm/client.js:47`, `src/llm/identityUnits.js` |
| Files are not encrypted | `SECURITY.md:57-72` |
| Free, open source | `LICENSE` (MIT, tested) |
| First three steps | `src/dashboard/public/index.html:1088,1117`, `src/dashboard/data.js` (tested) |
| Capability statuses: 42 Implemented, 15 Optional, 2 Experimental, 4 Planned | `truth-audit.md` section 3; owner decision 2026-11-15; tested |

## 8. Tests

| Suite | Before | After |
| --- | --- | --- |
| `exploreContent.test.js` | 48 | 109 |
| `explorePage.test.js` | 20 | 31 |
| Full suite (`npm test`) | 3,512 passed | 3,583 passed, 1 failed |
| Lint | 0 errors, 12 warnings | 0 errors, 12 warnings |
| Type-check, `npm run verify` | clean, healthy | clean, healthy |

The one failure is `gapAgreement.test.js`, which reads the owner's live `config/scoring.json` (modified in this working tree, not by this work). It passes in a clean worktree of this branch (9 of 9), as the audit's decisions log already records.

## 9. Known limitations

- Safari and Firefox were not run.
- Under the hood keeps its own type (section 1).
- The performance numbers are from headless Chromium on one machine.
- On a phone the page is long: every chapter's picture plays once, and nothing is held.
- Worth checking by hand: a fast trackpad flick through the two signals; switching fields from a chapter's corner; dark theme on a real display.
