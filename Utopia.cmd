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
node scripts\utopia-client-launcher.mjs %*

echo.
echo ----------------------------------------------------------------
echo   The launcher has exited (see the log above for the reason).
echo   Press any key to close this window.
echo ----------------------------------------------------------------
pause >nul
