@echo off
rem Compatibility launcher. The canonical startup logic lives in
rem start-job-agent.cmd -> npm run app (config checks, port fallback, browser,
rem and clean shutdown). Keeping this file as a thin wrapper prevents the two
rem Windows launch paths from drifting apart.
rem
rem   start-dashboard.cmd            port 4646
rem   start-dashboard.cmd 5000       port 5000
rem   start-dashboard.cmd --port=5000  also port 5000 (was passed as --port=--port=5000)
setlocal EnableExtensions

set "PORT=%~1"
if not defined PORT set "PORT=4646"
rem Accept an explicit --port=N as well as a bare N.
if /i "%PORT:~0,7%"=="--port=" set "PORT=%PORT:~7%"

call "%~dp0start-job-agent.cmd" "--port=%PORT%"
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
