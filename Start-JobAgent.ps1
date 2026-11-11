# Job Agent — PowerShell launcher.  Run:  pwsh ./Start-JobAgent.ps1
# All launchers call the same cross-platform startup: `npm run app`
# (validate config -> migrate DB -> reuse a running dashboard or pick a port ->
# serve -> open browser). Dependency freshness, first-run config seeding and
# the browser check live in scripts/prepareLaunch.mjs so the launchers cannot
# drift apart.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found. Install Node 22.13+ from https://nodejs.org and run this again.' -ForegroundColor Red
  exit 1
}

# [version] cannot parse a prerelease such as "23.0.0-rc.1" and would throw,
# so drop any "-suffix" before comparing. 22.13 is the first 22.x where
# node:sqlite works without a flag.
$nodeVersionText = (& node -p "process.versions.node") -replace '-.*$', ''
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]'22.13.0') {
  Write-Host "Job Agent requires Node.js 22.13 or newer. Found $nodeVersion." -ForegroundColor Red
  exit 1
}

# Installs/refreshes node_modules when package-lock.json changed (not merely
# when node_modules is missing), seeds missing personal config from the
# examples, and offers to download the form-filling browser.
node scripts/prepareLaunch.mjs
if ($LASTEXITCODE -ne 0) { Write-Host 'Dependency setup failed (see above).' -ForegroundColor Red; exit 1 }

npm run app -- @args
exit $LASTEXITCODE
