# Repository structure

The repository separates executable code, maintained tools, published references, and local candidate data. Keep paths used by launchers, configuration loading, and generated application packets stable unless a migration is planned and tested.

```text
JobAgent/
├── src/                 Application code, grouped by capability
│   ├── cli/             Commands, guided run, and preflight
│   ├── search/          Discovery sources and normalization
│   ├── scoring/         Eligibility and ranking
│   ├── profile/         Candidate/search profile model
│   ├── resume/          Tailoring and Python bridge
│   ├── apply/           Packets, approvals, cover letters, answers
│   ├── automation/      Browser assisted fill
│   ├── dashboard/       Local server and public web assets
│   └── ...              Domain, logging, reports, extension, utilities
├── extension/           Browser extension shipped separately
├── scripts/             Maintained commands; archive/ holds retired probes
├── tests/               Node and Python test suites
├── config/              Tracked defaults/examples and JSON schemas
├── interview-prep/      Study course, modules/, and published exports
├── docs/                Architecture, support evidence, published audits
├── data/                Local job store and tracked manual input templates
├── resumes/             Local master and tailored documents
├── applications/        Local application packets
├── reports/             Generated run reports
└── logs/                Generated run logs
```

## Ownership and data flow

| Area | Maintainer rule |
| --- | --- |
| `src/` | Product behavior lives here. Put new code beside the capability it serves; use `utils/` only for genuinely shared helpers. |
| `extension/` and `src/dashboard/public/` | These are distributed browser assets. Their URLs and manifest paths are runtime contracts. |
| `scripts/` | Operational entry points stay at their existing paths so npm commands, launchers, and documented invocations keep working. [Script index](../../scripts/README.md). |
| `config/` | Commit examples, taxonomy, and schemas. Candidate profiles, answers, cover letter facts, and secrets remain local and gitignored. `npm run setup` seeds missing personal files from examples. |
| `data/`, `resumes/`, `applications/`, `reports/`, `logs/` | Runtime state stays at these established paths. Only synthetic examples, manual input templates, and `.gitkeep` files are tracked. Do not move or publish a real resume, packet, database, or log while reorganizing source. |
| `docs/` | Durable project references and dated reviews. A review is a historical snapshot; generated run reports stay under `reports/`. |
| `interview-prep/` | The overview links into `modules/`. The PDF builder reads those modules and writes the combined Markdown and PDF at the course root. The live academy web assets have one source in `src/dashboard/public/learn/`. |

## Path rules for changes

1. Keep the root launchers and `src/index.js` entry point discoverable. They are user-facing commands.
2. Preserve the local-state paths above. A path change needs a migration for existing users and a clean-checkout test.
3. Update package scripts, imports, documentation links, and Windows paths together when moving executable files.
4. Verify both a clean setup (`npm run setup`, `npm run verify`) and the Node/Python suites before publishing a structural change.
