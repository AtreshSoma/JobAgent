@echo off
rem Job Agent — double-click launcher (Windows).
rem All launchers call the same cross-platform startup: `npm run app`
rem (validate config -> migrate DB -> pick free port -> serve -> open browser).
setlocal EnableExtensions
cd /d "%~dp0" || (
  echo Could not open the Job Agent folder: "%~dp0"
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node 22.5+ from https://nodejs.org and run this again.
  pause
  exit /b 1
)

node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=5)?0:1)"
if errorlevel 1 (
  echo Job Agent requires Node.js 22.5 or newer. Your version is:
  node --version
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run: installing dependencies once...
  call npm install || (echo npm install failed & pause & exit /b 1)
)

call npm run app -- %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
endlocal & exit /b %EXIT_CODE%
