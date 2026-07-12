@echo off
rem Compatibility launcher. The canonical startup logic lives in
rem start-job-agent.cmd -> npm run app (config checks, port fallback, browser,
rem and clean shutdown). Keeping this file as a thin wrapper prevents the two
rem Windows launch paths from drifting apart.
setlocal EnableExtensions

set "PORT=%~1"
if not defined PORT set "PORT=4646"

call "%~dp0start-job-agent.cmd" "--port=%PORT%"
set "EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %EXIT_CODE%
