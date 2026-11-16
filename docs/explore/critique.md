# Explore JobAgent: critique of the page as it stands

Reviewed 2026-11-15 on branch `explore-product-film` (cut from `main` at `8bc42f8`, the same commit as `JobAgent-Nov14`), before any change to the page.

**How it was reviewed**

- The page was served by a private test dashboard (the real server and its real Content-Security-Policy, on a throwaway workspace). The dashboard already running on this machine was not touched.
- 1,424 screenshots: every section of both views at 1440x900, 1180x700, 768x1024, 390x844 and 320x568, in light and dark, with motion on and with reduced motion (`docs/explore/tools/shoot.mjs`). A selection is kept in `docs/explore/before/`.
- Three scroll recordings at 1440x900 with real wheel events: slow (10 px a frame), fast flicks (900 px every 220 ms) and backwards, with frame intervals, long tasks and layout shift measured in the page (`docs/explore/tools/trace.mjs`).
- Every claim in `content-overview.js` and `content-deep.js` checked against the code. The full tables are in `docs/explore/truth-audit.md`.
- Two independent passes, as the Impeccable critique asks: a design and newcomer review that never saw detector output, and a detector and browser pass. **The second pass stopped part way on a usage limit.** Its detector run, keyboard walk, touch-target, small-text, reduced-motion, axe and contrast sweeps finished and are reported here. Its deep-link landings, 40 px stepping across every sheet boundary and fast-jump screenshots did not run; section 9 says what stands in for them.

Severity: **P0** blocks the page's purpose, **P1** fix before release, **P2** fix in this pass, **P3** polish.

---

## 1. First-time visitor walkthrough

Five people who have never heard of JobAgent, reading the Overview from the top.

| Person | Understands what it does | Sees it is for them, or decides it is not | Trusts it | Leaves | Terms they do not understand |
| --- | --- | --- | --- | --- | --- |
| Full-stack developer | Hero sentence | Assumes so, by being near data work. Nothing confirms it. | "Serves itself on 127.0.0.1", then Never | The capability register | The tier names (Priority, Apply, Queue), "packet", "the line", "signal" |
| Cloud security analyst | Hero sentence | **Decides against at Discover**: the only security line on the page is "Excluded: requires a security clearance" | Never, at the CAPTCHA and sign-in line | Score | "source adapters", "ATS feeds", "dbt", "marts", "Meaning rank", "text embeddings", "packet" |
| Regulatory affairs specialist, pharma | Roughly, at the hero sentence | **No, at the hero**: eleven data-engineering cards. "Profiles for any profession" sits in a collapsed group near the foot | Never ("Adds a skill... not already yours"), if reached | Score | All of the above, plus "127.0.0.1", "Greenhouse", "ETL", "Queue", "config file", "master resume", "Kafka", "SQLite" |
| Registered nurse | Partly ("fills the forms"). "Explains every score" has nothing to attach to | **No, at the hero** | Only "Nothing is submitted without you" | The hero, or on the way into Discover | Nearly every technical noun on the page |
| Marketing manager | Hero sentence, fully at the three-way contrast | **No**: "for engineers" by Score | The contrast row, then "You approve." | Score | "source adapters", "ATS", "dbt", the tier names, "packet", "embeddings" |

Four of the five decide the page is not for them, three of them before leaving the first screen. That is the finding everything else is ranked against.

### Five-second test on the hero

| Size | What a stranger takes away |
| --- | --- |
| 1440x900 | The headline, a plain sentence and a card reading "Senior Data Engineer 78 Apply". What it is: yes. For me: only if I work in data. Trust: one of three proof items is plain. Next: "See it work". |
| 1180x700 | The same, with the card field competing with the sentence for the eye. |
| 768x1024 | Headline, a 450 px gap, then the sentence. The card field runs off the right edge. |
| 390x844 | Headline, then the data-engineer card, then the sentence underneath it. No dashboard link in the header. |
| 320x568 | Headline and the card only. No explanation, no trust line and no next step on the first screen. |

Against the four questions: *What is this?* answered on desktop, late on phones. *Is it for me?* answered "no" for anyone outside data. *Can I trust it?* one plain fact of three; nothing about AI, cost or where data goes. *What next?* one clear button and one for developers ("Explore the architecture").

### Heuristic score (Nielsen, 0 to 4)

| # | Heuristic | Score | Key issue |
| --- | --- | --- | --- |
| 1 | Visibility of system status | 3 | The rail shows position in pinned mode; phones get no position cue |
| 2 | Match with the real world | 2 | Jargon throughout; one profession in every example |
| 3 | User control and freedom | 3 | Native scroll and deep links work; "Run the line" cannot be restarted from the start without a reload |
| 4 | Consistency and standards | 2 | Overview and Under the hood read as two products |
| 5 | Error prevention | n/a | Nothing to get wrong on a read-only page |
| 6 | Recognition rather than recall | 2 | "Apply" is both a verdict and looks like a button; tiers never explained |
| 7 | Flexibility and efficiency | 3 | Deep links, filters, keyboard paths all present |
| 8 | Aesthetic and minimalist design | 3 | Distinctive and restrained; Score and the register are the exceptions |
| 9 | Error recovery | n/a | |
| 10 | Help and documentation | 2 | No FAQ; the questions a newcomer has are answered only under the hood |
| | **Total** | **20 / 32** | 63%: acceptable, with significant work needed for a newcomer |

Cognitive load: 4 of 8 checks fail (single focus on Score, chunking in the register, minimal choices, progressive disclosure on phones).

**Design specificity.** The page is authored, not assembled: the transit-line idea, the signal sheets, the peel and the type pairing belong to this product and no other. The detector agrees in its own way: its only two findings are that Instrument Serif is a widely used face (`index.html`, `tokens.css:47`). The brief keeps the type pairing, so that is not acted on. The weakness is not craft. It is that the craft is spent on one reader.

---

## 2. Findings

Evidence paths are relative to `docs/explore/before/` unless they name a source file. `CO` is `src/dashboard/public/assets/explore/js/content-overview.js`, `CD` is `content-deep.js`.

### Content and story

| ID | Section | Issue | Evidence | Sev | Proposed fix |
| --- | --- | --- | --- | --- | --- |
| C1 | Whole Overview | Every example is a data engineer: 11 of 11 hero cards, the posting, the score, the resume bullets, the form and the Track card | `hero-1440.jpg`; `CO:22-55`, `CO:175-228` | **P0** | "See it for your field": one story told for six fields, software first. Hero field and Discover stream always mixed |
| C2 | Hero | Two of three proof items are jargon ("18 source adapters", "Serves itself on 127.0.0.1"). Nothing says any field, AI, cost or where data goes. The second button is for developers | `hero-1440.jpg`; `CO:31-37` | P1 | Three plain trust facts. Second action opens the dashboard |
| C3 | Whole Overview | Terms used with no explanation: ATS, tier names, packet, shortlist, source adapters, embeddings, config file, "the line", "signal" | `CO:36,89,112-115,170,274` | P1 | Replace or gloss at first use: "the employer's application system", "how strong a match", "everything ready for one application" |
| C4 | Problem | The statement runs about 1.6 screens, word by word. The three-way contrast, the strongest idea, is a small footnote under it | `problem-1440.jpg` | P1 | One beat. Four real frustrations, short. The contrast is the picture |
| C5 | Problem | A real frustration is missing: conditions buried deep in the posting | `CO:62-76` | P2 | Add it; it sets up the hidden-condition tags |
| C6 | Signals | Each gate's one sentence arrives late and is covered at once, after two nearly empty red frames | `signal-empty-red-1440.jpg` | P1 | Bring the sentence in with the title; hold the finished frame |
| C7 | After Never | Four reference sections in a row (hood, sources, run, register): six desktop screens after the story has ended | `run-1440.jpg`, `register-1440.jpg` | P1 | Run the line moves up; hood and sources merge; a short FAQ before the close |
| C8 | Run the line | Comes after the whole story and replays it. Small diagram, blank lower third | `run-1440.jpg` | P2 | Move it to just after the Problem as the reader's first look at the whole route, in their field |
| C9 | Close | The three steps are not the real first steps, and one says "packets". The architecture button appears a third time | `overview.js:142-150` | P1 | The real onboarding: add your resume, confirm the job titles, run your first search. One action |
| C10 | Trust | The Overview never says whether anything is sent to an AI model, what it costs or what you need to start | `CO:237-266` | P1 | Hero trust facts; FAQ |
| C11 | Features | Missing from the page entirely: hidden-condition tags, evidence per skill, the shared evidence rule, auto-fill readiness, sign in once, answers per person, employer history, Today, measured page fit, per-step undo, identity kept from AI, dry run | `truth-audit.md` section 2 | P1 | Show each where it belongs in the story; add all to the register |
| C12 | Tailor | 54-word body; the two sheets look alike, so the eye cannot tell what tailoring did | `tailor-1440.jpg` | P2 | Shorter body. A struck-through left-out line, "was 2nd" marks and the Compare with master ledger |
| C13 | Repetition | "127.0.0.1" four times; "Nothing is submitted without you" three | `CO:36,241,252`, `index.html` footer | P3 | Say each once, in plain words |
| C14 | Hero field | Each card's label is its source ("Greenhouse"), which means nothing to a newcomer | `hero-1440.jpg` | P3 | The label is the kind of work |

### Truth

| ID | Where | Issue | Backing | Sev | Fix |
| --- | --- | --- | --- | --- | --- |
| T1 | `CD:353` | Still describes the "Most relevant to this role" line. It was removed, and it contradicts "nothing is added" | `src/resume/tailor.py:36` | P1 | Delete the sentence and its file citations |
| T2 | `CD:102`, `CD:351` | "Node spawns a Python process" per job. It is now a pool of two long-lived workers | `src/resume/tailorRunner.js:383-414`, `src/resume/pythonWorker.js` | P2 | Reword and cite the worker |
| T3 | `CD:312` | "Two factors can only subtract." There are three: pay 6, stated requirement 8, manager or individual track 20 | `src/scoring/scorer.js:584,587`, `src/scoring/eligibility.js:44` | P2 | Say three |
| T4 | `CD:318` | Board order "then the last 24 hours". It now uses bands: under 24 h, 1 to 3 d, 4 to 7 d, 8 to 21 d, older | `src/scoring/jobRanking.js:47-49` | P2 | Reword |
| T5 | `CD:227` | Freshness windows omit 14 and 30 days | `src/utils/credentialManager.js:204` | P3 | "24 hours to 30 days, or no limit" |
| T6 | `CD:338` | "The six tasks." There are seven: free-text answers were added | `src/apply/groundedAnswer.js:42` | P2 | Say seven |
| T7 | `CD:181` | "Nothing is sent unless LLM assist is on." Meaning rank and inbox reading are separate switches | `src/llm/embeddings.js:15`, `SECURITY.md:34-47` | P1 | "unless you turn a model feature on" |
| T8 | `CO:335` | "Template cover letters." Letters now come from your master cover letter, with versions | `src/apply/masterLetter.js:128` | P2 | Rename the row |
| T9 | `CO:356` | Assistant access is described as read-only. It can also add a note and record an outcome | `src/mcp/server.js` | P2 | Say so |
| T10 | `CO:357-358` | "Dropped-field report" is listed as Planned and overlaps the shipped Resume check | `src/resume/readiness.py:46` | P2 | Remove the row |
| T11 | `CO:244` | "edits your Word file". It edits a per-job copy | `src/resume/tailor.py` | P2 | "edits a copy" |
| T12 | `CO:253` | Says files are local; does not say they are unencrypted | `SECURITY.md:57-72` | P1 | Say it plainly, with the advice to use disk encryption |
| T13 | The brief's "Planned only" list | **Seven of the ten items have shipped in some form since the brief was written.** Work history and education filling, skipping unchanged boards (Workday only), outcome analytics and the interview prep pack are on by default. Drafted answers, waiting at a sign-in, several applications at once and the daily schedule are built and off until switched on. Only live results and a packaged installer are not built | `truth-audit.md` section 3 | P1 | Label each by what the code does, with its caveat in the row. **Needs the owner's decision** |
| T14 | Close (brief) | "Choose your field" is not a step in the product. The role family is matched from the job titles you confirm | `src/profile/roleFamilies.js`, `src/dashboard/public/index.html:1117` | P2 | Close with the real three steps |

Everything else checked is true as written, including 18 sources, nine employer feeds, the two-page budget, the tier thresholds, every line of Never and the auto-submit wording.

### Visual

| ID | Section | Issue | Evidence | Sev | Fix |
| --- | --- | --- | --- | --- | --- |
| V1 | Score | The densest frame with no focal point: number, ruler, posting, ten equal bars, a meaning rank, four presets, four beats. "Apply" reads as a button | `score-1440.jpg` | P1 | One focal point per beat: the number. Five rows lead, five fold into one line. The verdict is glossed in words |
| V2 | Sources | About 45% of the frame is used, in small type, with developer names for the groups. In dark the empty part is near black | `sources-dark-1440.jpg` | P2 | Three columns by what you must do: on already, needs your key, links you give it, each with its count |
| V3 | Register | Five of six groups closed, half the frame empty, 41 rows of equal weight | `register-1440.jpg` | P2 | Counts by status first, every group open in two columns, new work marked |
| V4 | Tailor | At 1440x900 the last line of the body text sits on the rule above the first beat | `tailor-text-overlap-1440.jpg` | P2 | Shorter body; the list takes the remaining row |
| V5 | Run the line, 768 | Stop labels collide ("DiscoverScore") | `run-768.jpg` | P2 | A minimum column width, or stack |
| V6 | Under the hood | Reads as a different product: grotesk headings, a flat ground, 16 contents entries. The teaser map has no labels at 768 and below | `how-1440-sheet.jpg` | P2 | The Overview's type roles and line colours; an entry that reads as a junction off the main line |
| V7 | Under the hood, phone | The stack table's third column is cut off at 390 | `how-390-sheet.jpg` | P2 | Stack the rows |
| V8 | Phones | Walls of rows; no cue for where you are; 34 screens at 390 and 49 at 320 | `overview-390-sheet.jpg` | P2 | Compact pictures; picture before the list of moments; shorter page |
| V9 | Hero, phone | The explanation sits under the card at 390 and off the first screen at 320. No dashboard link | `hero-390.jpg`, `hero-320.jpg` | P1 | Sentence directly under the headline; the field as a strip below the switcher |
| V10 | Dark theme | Near black from Never to the close; Discover's sheet edge does not read against the page | `sources-dark-1440.jpg` | P3 | Lift the edge |
| V11 | Hero field | Text on the far cards is 7.5 px on screen at every size, including reduced motion | computed, 10 cards | P2 | Less depth and larger labels, so the range of professions can be read |

### Motion

| ID | Section | Issue | Evidence | Sev | Fix |
| --- | --- | --- | --- | --- | --- |
| M1 | Score | The number counts on its own clock. Stop scrolling part way and it reads 47 beside ten full bars and no verdict | `score-47-with-full-bars-1440.jpg`, `scroll-slow-score.jpg` | P1 | The number is the sum of the bars shown so far. Each bar adds its points |
| M2 | Problem | Words sit at 14% opacity until scrolled to. A reader who stops there has text that fails contrast (28 to 39 elements, axe) | `problem-1440.jpg`; axe, motion on | P2 | One beat that plays on arrival; no half-lit resting state |
| M3 | Tailor | A mid-state leaves bullets stacked on one another on the tailored sheet | `score-47-with-full-bars-1440.jpg`, lower half | P2 | Lines travel one at a time, so any stop is readable |
| M4 | Discover | Board text is 6.8 px on screen while the cards are in depth | computed, motion on | P2 | Less depth; cards stay legible throughout |
| M5 | Continuity | The posting is a different object in every chapter. Nothing visibly carries it from the hero to Track | recordings | P2 | The same card, with the same title and score chip, at each hand-off |
| M6 | Signals | Two nearly empty red frames before the title lands | `signal-empty-red-1440.jpg` | P1 | See C6 |

No flicker, jitter or empty frame between sheets was seen in the slow, fast or backward recordings. The peel is sound and stays.

### UX and accessibility

| ID | Section | Issue | Evidence | Sev | Fix |
| --- | --- | --- | --- | --- | --- |
| A1 | Phones | Touch targets under 44 px: "How ... works" links 26 px tall, filter chips 32, the theme button 36, the view switch 40. Under the hood: contents links 29, flow steps 36, chips 28 | measured at 390 and 320 | P2 | 44 px minimum on touch |
| A2 | Fill, hood | Text just under 12 px on screen where a picture is scaled to fit (11.4 to 11.9) | computed at 1440 and 1180 | P3 | Size pictures so nothing scales below 12 |
| A3 | Under the hood, 390 light | One "Optional" flag fails contrast | axe, motion on | P2 | Use the ink step of the line colour |
| A4 | Hero, phone | No link to the dashboard in the header | `hero-390.jpg` | P2 | Keep it at every width |

Clean: 47 keyboard stops on the Overview at 1440 (36 at 390) and 153 under the hood, every one with a visible focus ring, none covered by the header or the rail, no trap, skip link first. axe WCAG 2.2 AA with reduced motion: no violations in either view, theme or width. Contrast spot-check of the smallest text on every ground: nothing under 4.5:1 at rest. Reduced motion shows every picture finished, with nothing hidden. No horizontal overflow at any of the five widths. No console or CSP error in any of the 40 configurations.

### Performance (1440x900, pinned mode, headless Chromium)

| Measure | Slow scroll | Fast flicks | Backwards |
| --- | --- | --- | --- |
| Frames per second | 58.7 | 52.1 | 56.9 |
| Dropped frames (over 1.5 frame budgets) | 116 of 5,049 | 50 of 337 | 15 of 291 |
| Worst frame | 33 ms | 50 ms | 50 ms |
| Long tasks over 50 ms | 0 | 0 | 1 (52 ms) |
| Layout shift while scrolling | 0.100 (163 shifts) | 0.097 | 0.054 |

| ID | Issue | Evidence | Sev | Fix |
| --- | --- | --- | --- | --- |
| P1 | Layout shift of 0.28 during load, and one 113 ms task | `trace.json` | P1 | Reserve the hero's layout before fonts and motion start; split the start-up work |
| P2 | 163 small layout shifts across a slow scroll. The open beat in each chapter changes height as it opens and closes | `trace.json`; `scenes.css` beat rules | P1 | The beat list keeps a fixed height; text fades in place |
| P3 | Frame rate is close to the target and not at it: 2.3% of frames dropped on a slow scroll | `trace.json` | P2 | Fewer moving layers in Discover and the hero; pause off-screen work |

Weight: 339 KB of script in 15 files (116 KB of it the vendored animation library), 129 KB of styles, 111 KB of fonts. No images. Nothing here calls for another library: the problems are layout shift and one counter, which scroll smoothing would not fix.

### Bugs

| ID | Issue | Evidence | Sev |
| --- | --- | --- | --- |
| B1 | Tailor body text overlaps the first beat's rule at 1440x900 | `tailor-text-overlap-1440.jpg` | P2 |
| B2 | Run the line stop labels collide at 768 | `run-768.jpg` | P2 |
| B3 | Score shows a number that disagrees with its own bars mid-scroll | `score-47-with-full-bars-1440.jpg` | P1 |
| B4 | Stack table cut off at 390 under the hood | `how-390-sheet.jpg` | P2 |

---

## 3. The known starting points

| Starting point | Verdict | Evidence |
| --- | --- | --- |
| Sources leaves a mostly empty dark frame on desktop | **Confirmed** in dark. In light it is pale and just as sparse | `sources-dark-1440.jpg` |
| The register is a long flat run of collapsed rows | **Confirmed** | `register-1440.jpg` |
| Problem lingers; the three-way contrast is undersized | **Confirmed** | `problem-1440.jpg` |
| Score is the densest frame, with no focal point | **Confirmed**, and its number disagrees with its bars mid-scroll | `score-1440.jpg`, `score-47-with-full-bars-1440.jpg` |
| Run the line feels like a replay | **Confirmed**, plus the label collision at 768 | `run-1440.jpg`, `run-768.jpg` |
| On phones the hero field crowds the headline | **Corrected.** It does not overlap. It pushes the explanation below the card at 390 and off the first screen at 320 | `hero-390.jpg`, `hero-320.jpg` |
| On phones some frames are walls of rows | **Confirmed** | `overview-390-sheet.jpg` |
| Every example is a data engineer | **Confirmed**, without exception | `CO:22-55`, `CO:175-228` |
| Jargon assumes the reader knows the product | **Confirmed**, and the list is longer than the brief's | C3 |

---

## 4. Counts

56 rows: 1 P0, 19 P1, 31 P2, 5 P3. Four of the Bugs rows restate a finding above (V4, V5, M1, V7), so 52 distinct issues. All are in scope for this pass. Two need a decision from the owner before the content is written (T13, T14).

## 5. What was not checked, and what stands in for it

- **Deep-link landings** (`#/overview/<stage>`, `#/how/<topic>`) were not re-measured by hand. The existing browser test lands on a deep link and passes; all will be walked in step 5.
- **Stepping every sheet boundary in 40 px increments** did not run. The three recordings were sampled at 1.5 to 6 frames a second and show no empty frame, and the existing test "no empty frames between sheets" passes. A stepped scan belongs in step 5, on the new page.
- **Under the hood in dark and with reduced motion at 1180, 768, 390 and 320** was photographed and not looked at frame by frame.
- Frame rates are from headless Chromium on this machine. They compare one build with another; they are not a promise about a mid-range laptop.
