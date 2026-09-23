# Scripts

These are maintained repository commands. Run them from the repository root; use the npm aliases in `package.json` where available. Read each script's header before running it: some preview changes until `--apply`, while setup and tracker commands write when invoked.

| Purpose | Scripts |
| --- | --- |
| Setup and launch | `prepareLaunch.mjs`, `setupLocalConfig.mjs`, `initScoring.mjs` |
| Validation | `verifyRepoHealth.js`, `lint.mjs`, `auditTailoredResumes.js`, `adzuna-check.mjs` |
| Daily operations | `tracker.mjs`, `checkPostings.mjs`, `enrichDescriptions.mjs`, `harvestSources.mjs` |
| Store maintenance | `dbMaintenance.mjs`, `relabelUndatedJobs.mjs`, `repairJobUrls.mjs` |
| Document and output maintenance | `regenerateResumes.js`, `migrateOutputNames.js`, `cleanupGeneratedOutputs.js` |

The scripts in [archive/](archive/README.md) are incident-specific probes and repairs. They are retained for provenance and are not part of a supported workflow.

Production application code lives in [`src/`](../src/); generated files go to the gitignored `data/`, `applications/`, `resumes/`, `reports/`, and `logs/` paths. See the [repository structure guide](../docs/architecture/REPOSITORY_STRUCTURE.md) for the ownership rules.
