# Job Agent — PowerShell launcher.
# All launchers call the same cross-platform startup: `npm run app`
# (validate config -> migrate DB -> pick free port -> serve -> open browser).
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found. Install Node 22.5+ from https://nodejs.org and run this again.' -ForegroundColor Red
  exit 1
}

$nodeVersionText = & node -p "process.versions.node"
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]'22.5.0') {
  Write-Host "Job Agent requires Node.js 22.5 or newer. Found $nodeVersion." -ForegroundColor Red
  exit 1
}

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules'))) {
  Write-Host 'First run: installing dependencies once...'
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Host 'npm install failed' -ForegroundColor Red; exit 1 }
}

npm run app -- @args
exit $LASTEXITCODE
