@echo off
setlocal
rem UTOPIA · Room Pack V1 — start the local Room Hub.
rem Binds to 127.0.0.1 only. No Alien service (Gateway, Node, Android) is required.

set "HERE=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [rooms] Node.js was not found on PATH. Node 24 or newer is required.
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_VERSION=%%v"
for /f "delims=" %%m in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%m"
if %NODE_MAJOR% LSS 24 (
  echo [rooms] Node %NODE_VERSION% detected. Node 24 or newer is required.
  exit /b 1
)

if not defined ROOMS_PORT set "ROOMS_PORT=4320"
echo [rooms] UTOPIA Room Pack V1 starting on http://127.0.0.1:%ROOMS_PORT%/
echo [rooms] Node %NODE_VERSION% ^| runtime directory: %HERE%.runtime
echo [rooms] Press Ctrl+C to stop.
echo.

node "%HERE%hub\server.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo [rooms] Room Hub exited with code %EXIT_CODE%.
endlocal & exit /b %EXIT_CODE%
