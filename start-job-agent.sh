#!/usr/bin/env bash
# Job Agent — macOS/Linux launcher.
# All launchers call the same cross-platform startup: `npm run app`
# (validate config -> migrate DB -> pick free port -> serve -> open browser).
set -euo pipefail
cd -- "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node 22.5+ from https://nodejs.org and run this again." >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1)'; then
  echo "Job Agent requires Node.js 22.5 or newer. Found $(node --version)." >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run: installing dependencies once..."
  npm install
fi

exec npm run app -- "$@"
