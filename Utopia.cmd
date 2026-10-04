@echo off
rem ============================================================================
rem  UTOPIA - launcher (self-bootstrapping, for ANY freshly cloned host)
rem
rem  WHAT IT GUARANTEES: clone the project, double-click this file, and it opens.
rem  Nothing has to be installed first and nothing has to be typed.
rem
rem  THE ORDER IS: START FIRST, PREPARE ONLY IF NEEDED.
rem    1. locate node (project-local first, then PATH, then the usual places);
rem    2. if there is NO node, fetch one into dependence\ and unpack it there;
rem    3. check the packages the app declares; if any are missing, create
rem       dependence\ and install them;
rem    4. start the City.
rem  A healthy checkout therefore never touches the network and never pays an
rem  install: steps 2 and 3 do nothing, and step 4 runs immediately.
rem
rem  TWO FOLDERS, TWO DIFFERENT JOBS - stated because they are easy to confuse:
rem    node_modules\   where the packages themselves live (standard, git-ignored)
rem    dependence\     the launcher's own provisioning: a fetched node runtime and
rem                    the log. Git-ignored, created only when it is needed.
rem
rem  WHY THIS FILE IS PURE ASCII: cmd.exe parses a batch file with the OEM/ANSI
rem  code page, so non-ASCII text here is a parse risk rather than a cosmetic
rem  choice - measured: a UTF-8 encoded copy of this file made cmd read command
rem  fragments as commands. The messages stay in English; the Chinese notes live
rem  in README.md, where no parser can be hurt by them.
rem
rem  Pass --takeover if a City from an older launch still holds the port; the
rem  launcher stops it only after confirming the process really is a dev-gateway.
rem ============================================================================
setlocal EnableExtensions
title Utopia - launcher (this host)
cd /d "%~dp0"
set "ROOT=%~dp0"
set "DEP=%ROOT%dependence"
set "LOGFILE=%DEP%\launcher.log"
set "PROBE=%DEP%\.env-probe"
set "PROBE_TMP=%DEP%\.env-probe.tmp"
set "NODE_BOOT=%DEP%\node\node.exe"
set "NODE_VER=v24.14.1"
set "NODE_DIR=node-%NODE_VER%-win-x64"
set "NPM_CACHE=%DEP%\npm-cache"
set "NODEEXE="
set "GOT_NODE="

if not exist "scripts\utopia-client-launcher.mjs" (
  echo   This file must sit in the Utopia checkout ^(scripts\utopia-client-launcher.mjs is missing^).
  pause
  exit /b 2
)

rem ---------------------------------------------------------------------------
rem STEP 1  FIND NODE. Never assumed: on the machine this was written for, node
rem is on neither the user nor the system PATH (it lives in a harness runtime and
rem is only on PATH inside that harness's session), so a bare "node ..." fails at
rem once under the environment Explorer gives a double-clicked .cmd.
rem ---------------------------------------------------------------------------
if exist "%NODE_BOOT%" (
  set "NODEEXE=%NODE_BOOT%"
  set "GOT_NODE=1"
  echo   node: found in dependence\ ^(fetched by an earlier run^)
)
if not defined NODEEXE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODEEXE set "NODEEXE=%%N"
if defined NODEEXE if not defined GOT_NODE echo   node: found on PATH
if not defined NODEEXE for /f "delims=" %%N in ('dir /b /a:d "D:\DS-Hns\runtime\node-*" 2^>nul') do if not defined NODEEXE if exist "D:\DS-Hns\runtime\%%N\node.exe" set "NODEEXE=D:\DS-Hns\runtime\%%N\node.exe"
if not defined NODEEXE if exist "D:\DS-Hns\runtime\node.exe" set "NODEEXE=D:\DS-Hns\runtime\node.exe"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"

if not defined NODEEXE (
  rem -------------------------------------------------------------------------
  rem STEP 2  NO NODE ANYWHERE: fetch one. This is the only time the launcher
  rem needs the network for a runtime, and it lands in dependence\ so the next
  rem launch finds it without touching the network at all.
  rem -------------------------------------------------------------------------
  echo.
  echo   No node runtime was found. Downloading one into dependence\ ...
  if not exist "%DEP%" mkdir "%DEP%" >nul 2>nul
  set "NODE_ZIP=%DEP%\%NODE_DIR%.zip"
  rem A failed download must not leave a truncated archive behind, or the NEXT
  rem run would find a file, skip the download, and fail while unpacking instead.
  if exist "%NODE_ZIP%" del /q "%NODE_ZIP%" >nul 2>nul
  set "DL_OK="
  rem npmmirror first: it is the reachable one from mainland China; the official
  rem host is the fallback rather than the default.
  for %%U in ("https://npmmirror.com/mirrors/node/%NODE_VER%/%NODE_DIR%.zip" "https://nodejs.org/dist/%NODE_VER%/%NODE_DIR%.zip") do (
    if not defined DL_OK (
      echo     %%~U
      where curl >nul 2>nul
      if not errorlevel 1 (
        curl -L --fail --silent --show-error -o "%NODE_ZIP%" "%%~U" >>"%LOGFILE%" 2>&1
      ) else (
        powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; try { Invoke-WebRequest -Uri '%%~U' -OutFile '%NODE_ZIP%' -UseBasicParsing } catch { exit 1 }" >>"%LOGFILE%" 2>&1
      )
      if exist "%NODE_ZIP%" set "DL_OK=1"
    )
  )
  if not defined DL_OK (
    echo.
    echo   Download failed. Install Node 24 from https://nodejs.org and run this launcher again.
    echo   ^(details in dependence\launcher.log^)
    pause
    exit /b 3
  )
  echo   unpacking ...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%NODE_ZIP%' -DestinationPath '%DEP%' -Force" >>"%LOGFILE%" 2>&1
  if exist "%DEP%\%NODE_DIR%\node.exe" (
    rem A stable path, so later launches do not care which version was fetched.
    if not exist "%DEP%\node" mkdir "%DEP%\node" >nul 2>nul
    robocopy "%DEP%\%NODE_DIR%" "%DEP%\node" /E /NFL /NDL /NJH /NJS /NP >nul 2>nul
    if exist "%NODE_BOOT%" set "NODEEXE=%NODE_BOOT%"
  )
  if not defined NODEEXE if exist "%DEP%\node\node.exe" set "NODEEXE=%DEP%\node\node.exe"
  if not defined NODEEXE (
    echo.
    echo   The runtime was downloaded but could not be unpacked.
    echo   ^(details in dependence\launcher.log^)
    pause
    exit /b 3
  )
  if exist "%NODE_ZIP%" del /q "%NODE_ZIP%" >nul 2>nul
  set "GOT_NODE=1"
  echo   node: %NODEEXE% ^(just fetched^)
)

rem Put the runtime's own directory on PATH, so npm and every child tool resolve it.
for %%N in ("%NODEEXE%") do set "NODEDIR=%%~dpN"
set "PATH=%NODEDIR%;%PATH%"

rem Node 24 is what the app declares (engines >=24). A NEWER one is fine; an older
rem one is reported rather than silently half-working. The version is read from
rem the SAME probe as the packages (step 3 below), so there is one question to
rem node instead of two.

rem ---------------------------------------------------------------------------
rem STEP 3  ASK NODE ONE QUESTION, IN ONE PASS: which of the app's declared
rem packages are missing, and which node is this. The list is read from
rem package.json by node itself instead of being repeated here - a launcher that
rem keeps its own copy of the dependency list goes stale the first time a
rem dependency is added.
rem
rem WHY THE PROBE WRITES A FILE INSTEAD OF BEING PARSED FROM STDOUT: a version
rem check written as a command substitution around "node -p ..." reads back as
rem v0 on this machine - cmd's handling of nested quotes there is not worth
rem betting the launcher on. node writes dependence\.env-probe and cmd only has
rem to read lines, which cannot be mis-quoted.
rem ---------------------------------------------------------------------------
rem THE FOLDER MUST EXIST BEFORE THE PROBE, and the first version of this step forgot it: with dependence\ absent
rem the redirection could not be created, the probe silently did not run, and the launcher concluded "nothing is
rem missing" and started the City with no packages installed. The folder is created here, its failure is fatal
rem rather than ignored, and a probe that did not run now reports itself instead of being read as an all-clear.
if not exist "%DEP%" mkdir "%DEP%" >nul 2>nul
if not exist "%DEP%" (
  echo   Could not create "%DEP%" - the launcher needs it for its probe and log.
  pause
  exit /b 5
)
rem WHY A FILE AND NOT A PIPE, WHICH IS THE OPPOSITE OF WHAT THE FIRST FIX TRIED: `for /f ... in (`command`)` makes
rem cmd run the command through a PIPE. A launcher started with no console (Start-Process with redirected output, a
rem shortcut, a scheduled task) has no console handles to build one from, and the console printed, verbatim:
rem   ???????????   /   ?????      ("the system cannot find the path specified" / "invalid handle")
rem The probe then never ran and the launcher installed nothing - on exactly the launch path a Windows launcher
rem needs most. A plain `>` redirection into a file needs no console handles at all, which is why it is used here.
rem
rem TWO GUARDS make the read safe, because a stale answer is worse than no answer: `del` first (so a failed write
rem cannot be masked by last run's file) and `PROBED` set ONLY when the file exists.
if exist "%PROBE_TMP%" del /q "%PROBE_TMP%" >nul 2>nul
set "NODE_MAJOR="
set "MISSING="
set "PROBED="
"%NODEEXE%" -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));console.log('NODE '+process.versions.node);const miss=Object.keys(pkg.dependencies||{}).filter(function(d){return !fs.existsSync('node_modules/'+d+'/package.json');}).sort();if(miss.length){console.log('MISSING '+miss.join(' '));}else{console.log('OK');}" >"%PROBE_TMP%" 2>nul
if not exist "%PROBE_TMP%" (
  rem THE PROBE COULD NOT RUN - and the launcher still has to work, because "no answer" must never mean "nothing to
  rem do". This path was reached for real while testing: a launcher started WITHOUT A CONSOLE (Start-Process with
  rem redirected output - exactly how a shortcut or a scheduled task launches it) fails here, because cmd cannot
  rem build the handles that redirection wants. The requirement is "a freshly cloned host opens", so the fallback
  rem covers the one case that matters most: node_modules missing or empty means nothing has ever been installed,
  rem and the installer is run on that evidence alone.
  rem
  rem THIS IS NOT A GUESS ABOUT WHICH PACKAGES: the installer is never handed a list - npm resolves the whole
  rem declared set from package.json itself. The only decision made here is WHETHER to run it, and "the package
  rem folder is missing or holds nothing" is unambiguous evidence for that.
  if not exist "%ROOT%node_modules\" (
    set "MISSING=<node_modules is missing>"
    set "PROBED=1"
    echo   NOTE: the dependency check could not run; node_modules is missing, installing.
  ) else (
    for /f %%C in ('dir /b /a "%ROOT%node_modules" 2^>nul ^| find /c /v ""') do if %%C LSS 1 set "MISSING=<node_modules is empty>"
    if defined MISSING (
      set "PROBED=1"
      echo   NOTE: the dependency check could not run; node_modules is empty, installing.
    ) else (
      echo   NOTE: the dependency check could not run - starting without touching node_modules.
    )
  )
)
if exist "%PROBE_TMP%" (
  for /f "usebackq tokens=1,* delims= " %%A in ("%PROBE_TMP%") do (
    if /i "%%A"=="NODE" set "NODE_MAJOR=%%B"
    if /i "%%A"=="MISSING" set "MISSING=%%B"
    set "PROBED=1"
  )
  if not exist "%PROBE%" copy /y "%PROBE_TMP%" "%PROBE%" >nul 2>nul
)
if not defined NODE_MAJOR set "NODE_MAJOR=0.0.0"
rem Node 24 is what the app declares (engines >=24). A NEWER one is fine; an older
rem one is reported rather than silently half-working.
for /f "tokens=1 delims=." %%V in ("%NODE_MAJOR%") do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 24 echo   WARNING: this app declares node ^>=24 and this runtime is v%NODE_MAJOR%.
if not defined MISSING (
  echo   packages: OK - starting now.
  goto :START
)
rem Reaching here means there IS something to do: either the probe named packages that are missing, or it could not
rem run at all while node_modules was missing or empty. A probe that could not run on a POPULATED node_modules
rem already took the :START branch above, so this is never an installer run on a bare guess.

:INSTALL
rem ---------------------------------------------------------------------------
rem STEP 4  INSTALL. dependence\ already exists by now (it holds the probe file
rem and the log); the packages themselves go to node_modules\ as npm expects.
rem npm ci when there is a lockfile - it installs exactly what was locked - and
rem npm install when there is not. Both are quiet: on success the user should
rem see the City starting, not a wall of package-manager noise.
rem ---------------------------------------------------------------------------
echo.
echo   Missing package^(s^): %MISSING%
echo   Installing into node_modules\ - first run only, this can take a minute ...
set "NPM_CMD="
where npm >nul 2>nul
if not errorlevel 1 set "NPM_CMD=npm"
if exist "%NODEDIR%npm.cmd" set "NPM_CMD=%NODEDIR%npm.cmd"
if not defined NPM_CMD (
  echo.
  echo   npm was not found, so the missing packages cannot be installed automatically.
  echo   Install Node 24 from https://nodejs.org and run this launcher again.
  pause
  exit /b 4
)
rem --package-lock=false when there is no lockfile: npm would otherwise CREATE one, and this project's dependency
rem versions in package.json are already exact, so a generated lockfile is churn in the checkout rather than a
rem guarantee. A lockfile that IS committed is still honoured, by `npm ci`.
if exist "%ROOT%package-lock.json" (
  call "%NPM_CMD%" ci --no-audit --no-fund --loglevel=error --cache "%NPM_CACHE%" >>"%LOGFILE%" 2>&1
) else (
  call "%NPM_CMD%" install --no-audit --no-fund --loglevel=error --package-lock=false --cache "%NPM_CACHE%" >>"%LOGFILE%" 2>&1
)
if exist "%NODE_BOOT%" if not exist "%ROOT%node_modules\ws\package.json" call "%NPM_CMD%" install --no-audit --no-fund --loglevel=error --package-lock=false --cache "%NPM_CACHE%" >>"%LOGFILE%" 2>&1
set "STILL="
rem Checked against the SAME probe file this run wrote (not the convenience copy), so "installed" is verified against
rem what was actually asked for rather than against a stale list.
if exist "%PROBE_TMP%" for /f "usebackq tokens=1,* delims= " %%A in ("%PROBE_TMP%") do if /i "%%A"=="MISSING" (
  for %%D in (%%B) do if not exist "%ROOT%node_modules\%%D\package.json" set "STILL=%%D"
)
if defined STILL (
  echo.
  echo   Install did not complete: %STILL% is still missing.
  echo   ^(details in dependence\launcher.log^)
  echo   If this machine is behind a proxy, set HTTPS_PROXY and run this launcher again.
  pause
  exit /b 4
)
echo   packages: installed.

:START
rem ---------------------------------------------------------------------------
rem STEP 5  START. Everything below this line is the app doing its job.
rem ---------------------------------------------------------------------------
echo.
"%NODEEXE%" scripts\utopia-client-launcher.mjs %*

echo.
echo ----------------------------------------------------------------
echo   The launcher has exited (see the log above for the reason).
echo   Press any key to close this window.
echo ----------------------------------------------------------------
pause >nul
endlocal
