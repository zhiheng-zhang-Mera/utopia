@echo off
rem ============================================================================
rem  Utopia - the launcher for THIS host.
rem
rem  Double-clicking this file:
rem    1. generates a fresh LOCAL token for this machine (nothing to type),
rem    2. brings this host's City up with that token, in THIS window,
rem    3. opens the web client already connected, in your default browser.
rem
rem  Closing this window stops the City. Pass --takeover if a City from an older
rem  launch is still holding the port; the launcher stops it only if the process
rem  it finds really is a dev-gateway.
rem ============================================================================
title Utopia - launcher (this host)
cd /d "%~dp0"
if not exist "scripts\utopia-client-launcher.mjs" (
  echo   This file must sit in the Utopia checkout ^(scripts\utopia-client-launcher.mjs is missing^).
  pause
  exit /b 2
)
rem Node is not on the user or system PATH on this machine, so it is located here rather than assumed:
rem PATH first, then the known runtime locations. Without this a double-click from Explorer fails at once.
set "NODEEXE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%N"
if not defined NODEEXE for /f "delims=" %%N in ('dir /b /a:d "D:\DS-Hns\runtime\node-*" 2^>nul') do if not defined NODEEXE if exist "D:\DS-Hns\runtime\%%N\node.exe" set "NODEEXE=D:\DS-Hns\runtime\%%N\node.exe"
if not defined NODEEXE if exist "D:\DS-Hns\runtime\node.exe" set "NODEEXE=D:\DS-Hns\runtime\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODEEXE (
  echo   Could not find a node runtime. Install Node 24 or unpack one, then run this launcher again.
  pause
  exit /b 3
)
"%NODEEXE%" scripts\utopia-client-launcher.mjs %*

echo.
echo ----------------------------------------------------------------
echo   The launcher has exited (see the log above for the reason).
echo   Press any key to close this window.
echo ----------------------------------------------------------------
pause >nul
