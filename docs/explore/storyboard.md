# Explore JobAgent: storyboard

One sentence: follow one real-feeling application along the line, in the reader's own field, and make every pause point obvious about who is in control.

**The thread.** One posting, the chosen field's, is the same object from the hero to Track: same title, same employer, same score chip. Each sheet hands it to the next.

**The field.** "See it for your field" sets `?field=` (kept across deep links, remembered for the visit, announced to screen readers). It swaps the posting, the stream, the score, the evidence, the gaps, the resume, the form and the Track card. Structure and motion do not change. Six fields, each on a real role family in `config/role_families.json`:

| Field | Role family | What it teaches | Backing |
| --- | --- | --- | --- |
| Software Engineer (default) | `software-engineering` | Evidence lines; "Also asked for"; an on-call tag | `src/resume/evidenceMap.js`, `src/scoring/requirementPhrases.js`, `src/scoring/hiddenClauses.js` |
| Cybersecurity Analyst | `security` | A clearance tag and "onsite for the first 90 days", each opening to its sentence | `src/scoring/hiddenClauses.js:22-42` |
| Regulatory Affairs | `regulatory-quality` | A stated years floor read from the posting (a stretch, not a refusal); evidence for CMC, eCTD, Module 3 | `src/scoring/eligibility.js` |
| Registered Nurse | `healthcare-clinical` | An RN licence requirement read by the eligibility check; shift and on-call tags | `src/scoring/eligibility.js:546-553`, `hiddenClauses.js` |
| Marketing Manager | `marketing-growth` | A resume reordered toward campaign and analytics lines; a portfolio link in the form; a Queue verdict | `src/shared/fieldLabels.js` |
| Financial Analyst | `finance-accounting` | An on-site posting scored against a remote preference; a CPA "nice to have" | `src/scoring/scorer.js` |

Every field's score and verdict is computed by `score-model.js` from that field's inputs and checked against the real scorer in `exploreContent.test.js`. Every field's resume lines pass the same rules as the tailor: reordered, emphasized or left out, never added.

## Overview

| # | Beat | What moves | What it proves | Backing |
| --- | --- | --- | --- | --- |
| 1 | **Hero** | Cards from ten professions drift in from depth. The chosen field's posting comes forward and sharpens, with its score and what the score means in words. Changing field turns that one card over; nothing else moves | What it is, that it is for many kinds of work, and three reasons to trust it, in one screen | `config/role_families.json` (26), `score-model.js`, `SECURITY.md` |
| 2 | **Problem** | Four frustrations set short, then three columns rise: a job board, an auto-apply bot, JobAgent. One beat, played once on arrival | The reader's own morning, and the one difference that matters: it waits for you | `README.md` |
| 3 | **The whole line** (was "Run the line") | The reader's posting runs the route of five stops and stops at each red signal until the reader clears it | The shape of everything that follows, and what "the line" and a "signal" are, before either word is relied on | `src/lifecycle.js`, `src/apply/approvalDigest.js` |
| 4 | **Discover** | Postings from many families arrive. Three copies merge into one. Mismatches step back, each with its reason. A hidden-condition tag lifts out of a posting and opens to its sentence. One clean list remains | It reads the boards for you and tells you why it set something aside | `src/search/index.js` (18 sources), `src/search/deduplicator.js`, `src/scoring/hiddenClauses.js` |
| 5 | **Score** | Skills light in the posting one by one. Each bar that fills adds its points to the number, so the number is always the sum on screen. It lands on a verdict, said in plain words. Evidence lines appear beside matched skills; then the gap and "Also asked for", quoted | The score is arithmetic you can read, it never claims a skill for you, and it says what it does not know to look for | `src/scoring/scorer.js`, `src/scoring/explainScore.js`, `src/resume/evidence.js`, `src/scoring/requirementPhrases.js:98` |
| 6 | **Tailor** | The tailored sheet starts as a copy of the master. Line by line, bullets lift and travel to their new place. The one that will not fit slides out to the ledger. The posting's terms turn bold where they already were. The page count reads "2 pages, measured". The ledger counts the moves; Added stays at 0 | Tailoring is reordering and emphasis. Every sentence on the right exists on the left, and the proof is a number | `src/resume/tailor.py`, `src/resume/pagefit.py`, `src/resume/resumeDiff.js`, `src/resume/tailor_cli.py:122` |
| 7 | **You approve** (signal) | The posting runs up the line and stops short of a red signal. Title and sentence arrive together and hold | Nothing is filled until you approve. Change the resume, letter or answers afterwards and the approval is withdrawn | `src/apply/approvalDigest.js:15,109` |
| 8 | **Fill** | Readiness first: does this employer need an account, which questions have no answer. Then each field is recognized, matched and typed, and read back. It stops at a sign-in; "Sign in once, retry all" gathers the stopped jobs. It stops again before Submit | It does the typing, in a window you watch, and it stops wherever a person is needed | `src/apply/autofillReadiness.js`, `src/automation/assistStages.js`, `src/dashboard/public/assets/js/signin.js` |
| 9 | **You submit** (signal) | The same stop, at the second signal | The click is yours. A click is not proof: an application counts as sent only when a confirmation is seen | `src/automation/applyRunner.js`, `src/lifecycle.js` |
| 10 | **Track** | The card moves one stage along the board. A follow-up comes due on Today. A reply arrives as a suggestion (Optional, labelled) and you confirm it | What happened next is kept in one place, and outcomes are recorded only when you say so | `src/dashboard/public/assets/js/today.js`, `src/inbox/sync.js`, `src/dashboard/prepPack.js` |
| 11 | **Never** | The six rules arrive as a list on the near-black sheet | The limits are code with tests, not settings | `src/apply/autoApplyEligibility.js:124-128`, `config/verified_live_ats.json` |
| 12 | **Where jobs come from, and the turn-off** | Three columns fill: on already (12), needs your key (2), links you give it (4). Under them the system map draws west to east and a branch leaves the main line toward Under the hood | Coverage at a glance, and that nothing is read from behind a sign-in | `src/search/index.js:38-57`, `config/jobboards.json` |
| 13 | **Capability register** | A four-part bar fills and the counts settle, once. Every area is open, two columns of rows; a status filter swaps rows in place | How much is finished before a row is read. Planned work is marked as not built | `content-overview.js` `CAPABILITIES`, `CHANGELOG.md` |
| 14 | **Questions a newcomer asks** | Seven questions, open on arrival, no motion beyond the reveal | The answers a wary reader needs, each backed by a file | `docs/explore/truth-audit.md` section 5 |
| 15 | **Close** | Three numbered steps and one button | What to do in the next five minutes: add your resume, confirm the job titles it proposes, run your first search | `src/dashboard/public/index.html:1088,1117`, `src/dashboard/data.js:1294-1300` |

Removed: the hero's "source adapters" proof line, the second "Explore the architecture" button, the word-by-word Problem scrub, the standalone Sources block, the late "Run the line".

## Under the hood

Same structure: map, flows, lifecycle, Score Lab, stack. Changes:

| Beat | What changes | Backing |
| --- | --- | --- |
| Entry | Arrives as a branch off the main line: the Overview's line colours and serif section titles, on the drafting-blue ground | `tokens.css` |
| Scoring flow | Adds the evidence rule (one rule for the score, the packet and the gap list) and hidden clauses | `src/resume/evidence.js:5-18`, `src/scoring/hiddenClauses.js` |
| Tailoring flow | Adds measured page fit, per-step rollback and the worker pool; drops the removed "Most relevant" line | `src/resume/pagefit.py`, `src/resume/tailor.py:2851,2970-2985`, `src/resume/pythonWorker.js` |
| Autofill flow | Adds readiness, the dry run and waiting at a wall | `src/apply/autofillReadiness.js`, `src/automation/fieldFiller.js:603,651`, `src/automation/assistSupport.js:454` |
| AI | Says what each switch sends, and that lines with your name or contact details are removed first | `src/llm/identityUnits.js:77,88`, `SECURITY.md:34-47` |
| Stack, phone | The table stacks instead of clipping | critique V7 |

## Motion rules

- Each movement is a state change in the product: arrive, merge, step back, light up, add up, reorder, fill, stop, advance.
- Three memorable moments, and no more: the score adding itself up, the resume reordering line by line, the form filling and stopping at red.
- Native scroll. Transforms, opacity and custom properties only. No layout change while scrolling: the beat list keeps a fixed height.
- Any place the reader stops scrolling is a readable frame.
- The finished picture is the default DOM. Reduced motion shows it at once; phones play each picture once on arrival.
