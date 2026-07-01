@echo off
REM ============================================================================
REM  JobAgent Dashboard - one-click launcher (Windows)
REM
REM  Just DOUBLE-CLICK this file. It will:
REM    1. Move into the project folder (works no matter where it is run from)
REM    2. Install dependencies the first time (only if node_modules is missing)
REM    3. Start the local-only dashboard
REM    4. Open it in your default browser automatically
REM
REM  Optional: pass a port number, e.g.   start-dashboard.cmd 5000
REM  Stop the dashboard any time with Ctrl+C in this window.
REM ============================================================================

setlocal EnableExtensions

REM --- Always run from the folder this script lives in (fixes MODULE_NOT_FOUND)
cd /d "%~dp0"

REM --- Port: default 4646, or the first argument if you pass one --------------
set "PORT=%~1"
if "%PORT%"=="" set "PORT=4646"

REM --- Make sure Node.js is installed -----------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on your PATH.
  echo   Install it from https://nodejs.org/ ^(version 22.5 or newer^) and try again.
  echo.
  pause
  exit /b 1
)

REM --- First run only: install dependencies -----------------------------------
if not exist "node_modules" (
  echo Installing dependencies for the first time. This happens only once...
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. Scroll up to see the error.
    echo.
    pause
    exit /b 1
  )
)

echo.
echo   Starting the JobAgent dashboard at http://127.0.0.1:%PORT%/
echo   Your browser will open automatically once it is ready.
echo   Press Ctrl+C in this window to stop.
echo.

REM --- Open the browser, but only after the server is actually listening ------
start "" /min powershell -NoProfile -Command "$p=%PORT%; for($i=0;$i -lt 60;$i++){ if(Test-NetConnection 127.0.0.1 -Port $p -InformationLevel Quiet -WarningAction SilentlyContinue){ Start-Process ('http://127.0.0.1:{0}/' -f $p); break }; Start-Sleep -Milliseconds 500 }"

REM --- Run the dashboard. Absolute entry path => current directory never matters
node "%~dp0src\index.js" dashboard --port=%PORT%

echo.
echo   Dashboard stopped.
echo.
pause
endlocal
