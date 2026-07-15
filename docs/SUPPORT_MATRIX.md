# Source / ATS support matrix

Honest, evidence-backed capability statement. **Fixture-tested** means a vitest
suite drives the capability against local fixtures (never a live site, never a
real application). **Manually verified** means a human confirmed it against a
live site at least once — absence of that mark means NOT VERIFIED live.
Anything not listed is unsupported: the agent stops safely and reports RCA
rather than guessing.

Legend: ✅ supported · ◐ partial/limited · ❌ unsupported by design · — n/a

## Discovery sources

| Source | Discovery | Detail extraction | Limitations | Fixture-tested |
| --- | --- | --- | --- | --- |
| Greenhouse | ✅ public board API | ✅ JD + `first_published` posted date | board token must be configured | ✅ `searchAdapters`, `dataQualityRegressions` |
| Lever | ✅ public postings API | ✅ | company slug must be configured | ✅ `searchAdapters` |
| Ashby | ✅ public posting API | ✅ | org slug must be configured | ✅ `ashbySmartrecruiters` |
| SmartRecruiters | ✅ public company API | ✅ | company id must be configured | ✅ `ashbySmartrecruiters` |
| Workday | ◐ public CXS job feeds | ✅ | tenant/site must be configured; some tenants block unauthenticated feeds → per-source RCA | ✅ `searchAdapters` (`workday_jobs.json`) |
| Company career pages | ◐ JSON-LD (`JobPosting`) + sitemaps | ✅ where JSON-LD present | no JSON-LD → no extraction (reported, not guessed) | ✅ `discoveryCoverage` |
| LinkedIn — direct | ◐ public `/jobs/view/` URLs you provide | ✅ JSON-LD | ❌ query/feed search (login-walled; automating it requires evasion — refused with an explanatory error) | ✅ `directSourceAdapters` |
| Indeed — direct | ◐ public posting URLs you provide | ✅ JSON-LD | ❌ query search (bot-protected — refused honestly) | ✅ `directSourceAdapters` |
| Dice — direct | ◐ public posting URLs you provide | ✅ JSON-LD | ❌ query search (refused honestly) | ✅ `directSourceAdapters` |
| LinkedIn / Indeed / Dice / Glassdoor — via Apify provider | ✅ query-based through YOUR Apify account + actors | ✅ actor output mapped to normalized jobs | billed per run; actor schema changes surface as RCA (`schema_changed`) | ✅ `searchAdapters` provider mappings |
| Manual CSV / Add-by-URL | ✅ | ✅ | you supply the data | ✅ `cliCommands`, `dashboardServer` |
| Staffing/recruiting portals | ◐ via Apify actors or public URLs only | ✅ where JSON-LD/API exists | no dedicated adapters | ◐ covered by the paths above |

Discovery-wide guarantees (tested): cross-source dedup by company+title and
normalized URL (`deduplicator`), incremental skip-unchanged
(`incrementalDiscovery`), truthful last-24h (`dates`,
`workbenchReconciliation`), per-source failure isolation + partial-run RCA
(`runRca`), retry/backoff + rate limiting (`retryHandler`, `rateLimiter`),
cancellation (`jobs_cancelled`).

## ATS application filling

| ATS | Auto-fill | Multi-step nav | Uploads (verified attached) | Verified submission | Known limitations | Fixture-tested |
| --- | --- | --- | --- | --- | --- | --- |
| Greenhouse | ✅ adapter + semantic resolver | ✅ | ✅ `input-file-list` check | ✅ confirmation-evidence gate | embedded-iframe boards handled | ✅ `atsApplicationFixtures`, `embeddedFormAutomation` |
| Lever | ✅ | ✅ | ✅ | ✅ | — | ✅ `atsApplicationFixtures` |
| Ashby | ✅ | ✅ | ✅ | ✅ | — | ✅ `atsApplicationFixtures` |
| Workday | ✅ (`data-automation-id` selectors) | ✅ | ✅ | ✅ | account-creation/login walls stop the run (by design) | ✅ `atsApplicationFixtures`, `workdayFormFill` |
| SmartRecruiters | ✅ | ✅ | ✅ | ✅ | — | ✅ `atsApplicationFixtures` |
| iCIMS | ◐ generic resolver + selector hints | ◐ | ◐ | ◐ | frequently login-walled → blocked with RCA | ❌ no dedicated fixture |
| Taleo | ◐ generic resolver + selector hints | ◐ | ◐ | ◐ | legacy multi-frame flows often blocked | ❌ no dedicated fixture |
| Jobvite | ◐ generic resolver + selector hints | ◐ | ◐ | ◐ | — | ❌ no dedicated fixture |
| Generic accessible forms | ✅ semantic field resolver (labels/ARIA/question text; selects, comboboxes, radios, checkboxes, dates, files, conditionals) | ✅ safe Next/Continue only | ✅ | ✅ | unknown required questions block (never guessed) | ✅ `atsApplicationFixtures` generic case, `validationDetection`, `fieldFiller` |

Filling-wide guarantees (tested): CAPTCHA/login/MFA/bot walls always stop the
run (`guards`); validation-error detection after fill and after advancing
(`validationDetection`); `applied=1` only after positive confirmation evidence,
otherwise `submit_unverified` (`hardening`, `dashboardServer`); Auto-Apply
requires per-run explicit opt-in + eligibility precheck
(`autoApplyEligibility`); resumable persisted application state
(`applicationState`, `applicationResume`); duplicate-application prevention
(`dashboardServer` idempotency guard).

## Manually verified (live)

None this cycle — every capability above is fixture-tested only unless your
own runs have exercised it. Treat live-site behavior as **NOT VERIFIED** until
you have completed at least one supervised run per ATS.
