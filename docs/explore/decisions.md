# Explore JobAgent: decisions log

Format: date, ID, decision, why. Decisions marked **Pending owner** are proposals shown in the preview; they are not final until answered.

| Date | ID | Decision | Why |
| --- | --- | --- | --- |
| 2026-11-15 | E1 | Work on a new branch, `explore-product-film`, cut from `main` at `8bc42f8` | The owner asked for a new branch. `main`, `JobAgent-Nov14` and `origin/JobAgent-Nov14` are all the same commit, so nothing is lost by branching from where the session started. The brief calls `JobAgent-Nov14` unpushed; it is in fact on the remote |
| 2026-11-15 | E2 | Nothing pushed, no PR, `../JobAgent` untouched, the running dashboard untouched, `config/scoring.json` (the owner's live, modified file) left alone | The brief's hard limits. Every page load used a private test dashboard on a throwaway workspace |
| 2026-11-15 | E3 | **Pending owner.** Label the ten "not shipped" items by what the code does, not as Planned: 4 Implemented (work history and education, with "tested on a test page only" in the row; skip unchanged boards, Workday only; outcome analytics; interview prep pack), 4 Optional (drafted answers; wait at a sign-in; several applications at once, command line only; daily schedule), 2 Planned (results while a search runs; packaged installer) | The brief's list predates commits `858ccb5` to `eec2756`. The brief's own truth rule ("every claim checked against the code on this branch") outranks its list. Calling shipped work Planned would be as untrue as the reverse. `docs/explore/truth-audit.md` section 3 has the file for each |
| 2026-11-15 | E4 | Six fields: Software Engineer (default), Cybersecurity Analyst, Regulatory Affairs, Registered Nurse, Marketing Manager, Financial Analyst. Data engineering stays as one card in the hero field | The brief's order. A sixth option fills the row and adds a field with an on-site trade-off. Each maps to a family that exists in `config/role_families.json` |
| 2026-11-15 | E5 | Non-default examples do not need visa sponsorship; the software default does not either. Sponsorship stays as a Score preset and in the register | Most first-time visitors do not need it, and two sponsorship rows on every score would be the first thing a nurse or marketer does not understand. The reading is still shown where a reader can choose to see it |
| 2026-11-15 | E6 | The score shows five reasons in full (job title, skills, level, location, how recent) and folds the other five into one line with their true total | The critique's V1: ten equal bars and no focal point. The folded line states the points, so the arithmetic on screen still adds up |
| 2026-11-15 | E7 | Verdict names stay as the product has them (Priority, Apply, Queue, Near miss, Discard) and each is said in plain words beside it | They are the labels the reader will meet in the dashboard. Renaming them on this page only would make the page disagree with the product |
| 2026-11-15 | E8 | Regulatory: the years floor is shown as a marked phrase in the posting and a "One year short" line in the points. Its tag is a travel condition | A years floor is read by the eligibility check, not by the hidden-condition reader (`hiddenClauses.js` has eleven kinds; years is not one). A tag for it would show a feature that does not exist |
| 2026-11-15 | E9 | The Compare with master ledger uses the real six statuses (Unchanged, Moved up, Reordered, Reworded, Left out, Added) | `src/resume/resumeDiff.js:89`; the dashboard's own labels in `letters.js:520` |
| 2026-11-15 | E10 | **Pending owner.** "Run the line" moves up to just after the Problem and becomes the reader's first look at the whole route, in their field | It then explains "the line" and "signal" before the page relies on them, and removes one of four reference sections stacked after the story. The alternative in the brief (keep it late, make it a preset picker) leaves it a replay |
| 2026-11-15 | E11 | The close's three steps are the real ones: add your resume, confirm the job titles it proposes, run your first search | There is no "choose your field" step in the product; the family is matched from the titles (`src/profile/roleFamilies.js`) |
| 2026-11-15 | E12 | Sources merge into one "Where jobs come from" block with the system map: three columns by what the reader must do | Fixes the empty frame with substance, and answers "which job sites" at a glance |
| 2026-11-15 | E13 | The register keeps every area open, in two columns, with counts by status first. Status filters swap rows in place | The critique's V3. Collapsed groups hid five sixths of it |
| 2026-11-15 | E14 | No new library. No Lenis | The baseline trace shows 58.7 fps on a slow scroll and no long task while scrolling. The measured problems are layout shift and one counter, which scroll smoothing cannot fix |
| 2026-11-15 | E15 | The detector's only finding (Instrument Serif is widely used) is not acted on | The brief keeps the type pairing |
| 2026-11-15 | E16 | Hero's second button opens the dashboard; "Explore the architecture" is reached from the header and the turn-off | A first-time visitor's next step is the product, not the source |
| 2026-11-15 | E17 | Review tooling lives in `docs/explore/tools/` (`shoot.mjs`, `trace.mjs`) and is linted with the repo | The matrix is re-shot after every major change, so the scripts belong with the work |
| 2026-11-15 | E18 | The second critique pass (detector and browser evidence) was finished from its saved results after its agent stopped on a usage limit. Three of its sweeps did not run and are listed in the critique, section 5 | Reported, not hidden. They are covered again in step 5 on the new page |

| 2026-11-16 | E3 | Owner decided: 4 Implemented, 4 Optional, 2 Planned, labelled by the code | Owner decision; tested in `exploreContent.test.js` |
| 2026-11-16 | E10 | Owner decided: the whole route moves to just after the Problem | Owner decision |
| 2026-11-16 | E5 | Owner decided: sponsorship stays out of the main story and lives in the Score's "What if" and under the hood | Owner decision |
| 2026-11-16 | E19 | No CSS `scroll-behavior: smooth`; in-page links glide from script | It broke ScrollTrigger's measurements after a resize (the owner's screenshot) |
| 2026-11-16 | E20 | The signals play across a longer hold (1.1 stages) and end on the cleared state; the finished, reduced-motion picture is "approved by you" | The owner asked for the earlier, richer signal motion; the end state is what the person has done |
| 2026-11-16 | E21 | Page column `clamp(78rem, 70vw, 96rem)` | A 2000px window was framed in empty margin |
| 2026-11-16 | E22 | Under the hood keeps its own type (V6 deferred) | A full restyle of `deep.js` is a separate piece of work |

## Where to resume

Done and committed on `explore-product-film` (not pushed): see `report.md`. Open items: V6 (Under the hood restyle), the 120 ms build task on load, Safari and Firefox runs.
