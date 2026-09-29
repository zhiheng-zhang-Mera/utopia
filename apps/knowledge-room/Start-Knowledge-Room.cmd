@echo off
setlocal
rem UTOPIA Knowledge Room (MECH-K0) — start the local product.
rem Binds to 127.0.0.1 only. No other Utopia service is required.

set "HERE=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [knowledge-room] Node.js was not found on PATH. Node 24 or newer is required.
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_VERSION=%%v"
for /f "delims=" %%m in ('node -p "Number(process.versions.node.split('.')[0])"') do set "NODE_MAJOR=%%m"
if %NODE_MAJOR% LSS 24 (
  echo [knowledge-room] Node %NODE_VERSION% detected. Node 24 or newer is required.
  exit /b 1
)

if not defined KNOWLEDGE_ROOM_PORT set "KNOWLEDGE_ROOM_PORT=4317"
echo [knowledge-room] UTOPIA Knowledge Room starting on http://127.0.0.1:%KNOWLEDGE_ROOM_PORT%/
echo [knowledge-room] Node %NODE_VERSION% ^| data directory: %HERE%runtime-data
echo [knowledge-room] Press Ctrl+C to stop.
echo.

node "%HERE%src\server.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo [knowledge-room] server exited with code %EXIT_CODE%.
endlocal & exit /b %EXIT_CODE%
