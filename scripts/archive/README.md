# Archived scripts

One-off repairs and probes that are no longer part of any workflow. Each was
written to fix a specific incident, run once, and then left in `scripts/`
alongside the maintained tooling — 13 files with no entry point, no
documentation, and nothing importing them. Keeping them here preserves the
record of what was repaired without implying they are still runnable.

None of these is wired to an npm script. Read one before running it: several
assume a database shape or a file layout that has since changed.

| Script | What it was for |
| --- | --- |
| `repair-applied-status.mjs` | Corrected `applied` flags after a status-writing bug. |
| `repairMojibakePaths.mjs` | Fixed artifact paths mangled by a pre-UTF-8 Node/Python pipe. |
| `backfillEmployment.mjs` | Backfilled employment classification onto existing rows. |
| `cleanJobDescriptions.mjs` | Stripped boilerplate from stored JD text. |
| `strip_focus_line.py` | Removed the per-job focus line from already-tailored resumes. |
| `audit.mjs` | Ad-hoc repository statistics for an earlier review. |
| `demo-browser.mjs` | Manual Playwright form-fill demo. |
| `edge-profile-smoke.mjs` | Checked an Edge browser profile could be opened. |
| `find-resume.mjs` | Located the master resume during a path-handling bug. |
| `guard-probe.mjs` | Exercised the submit guards by hand. |
| `inspect-applied.mjs` | Printed applied rows during a tracking investigation. |
| `apify-check.mjs` | Queried Apify account quota by hand. |

`strip_focus_line_longpaths.py` was deleted rather than archived: its entire
body was a list of absolute paths to real applications, including the
candidate's name, and it could never run again on any other machine.

Still maintained, still in `scripts/`: `adzuna-check.mjs`,
`relabelUndatedJobs.mjs`, `harvestSources.mjs`, `enrichDescriptions.mjs`,
`dbMaintenance.mjs`, `tracker.mjs`, `verifyRepoHealth.js`, `repairJobUrls.mjs`,
`migrateOutputNames.js`, `regenerateResumes.js`, `auditTailoredResumes.js`,
`cleanupGeneratedOutputs.js`, `setupLocalConfig.mjs`.
