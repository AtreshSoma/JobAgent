@echo off
rem Job Agent — double-click launcher (Windows).
rem All launchers call the same cross-platform startup: `npm run app`
rem (validate config -> migrate DB -> reuse a running dashboard or pick a port ->
rem serve -> open browser). Dependency freshness, first-run config seeding and
rem the browser check live in scripts\prepareLaunch.mjs so the launchers cannot
rem drift apart.
setlocal EnableExtensions
cd /d "%~dp0" || (
  echo Could not open the Job Agent folder: "%~dp0"
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node 22.13+ from https://nodejs.org and run this again.
  pause
  exit /b 1
)

rem 22.13 is the first 22.x where node:sqlite works without a flag.
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo Job Agent requires Node.js 22.13 or newer. Your version is:
  node --version
  pause
  exit /b 1
)

rem Installs/refreshes node_modules when package-lock.json changed (not merely
rem when node_modules is missing), seeds missing personal config from the
rem examples, and offers to download the form-filling browser.
node scripts\prepareLaunch.mjs || (echo Dependency setup failed - see above. & pause & exit /b 1)

call npm run app -- %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
endlocal & exit /b %EXIT_CODE%
