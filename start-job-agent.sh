#!/usr/bin/env bash
# Job Agent — macOS/Linux launcher.  Run:  ./start-job-agent.sh
# All launchers call the same cross-platform startup: `npm run app`
# (validate config -> migrate DB -> reuse a running dashboard or pick a port ->
# serve -> open browser). Dependency freshness, first-run config seeding and
# the browser check live in scripts/prepareLaunch.mjs so the launchers cannot
# drift apart.
set -euo pipefail
cd -- "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node 22.13+ from https://nodejs.org and run this again." >&2
  exit 1
fi

# 22.13 is the first 22.x where node:sqlite works without a flag.
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; then
  echo "Job Agent requires Node.js 22.13 or newer. Found $(node --version)." >&2
  exit 1
fi

# Installs/refreshes node_modules when package-lock.json changed (not merely
# when node_modules is missing), seeds missing personal config from the
# examples, and offers to download the form-filling browser.
node scripts/prepareLaunch.mjs

exec npm run app -- "$@"
