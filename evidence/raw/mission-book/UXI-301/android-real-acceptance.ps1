$ErrorActionPreference = 'Continue'
# Four levels up from evidence/raw/mission-book/UXI-301. My first version used three and silently rooted
# the script at the EVIDENCE directory, so every path below it was wrong - caught immediately by the
# assertion rather than by a confusing failure three steps later.
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
if (-not (Test-Path (Join-Path $root 'apps\android\gradlew.bat'))) { throw "repo root looks wrong: $root" }

$adb = 'C:\Users\15601\AppData\Local\Android\Sdk\platform-tools\adb.exe'
$emuExe = 'C:\Users\15601\AppData\Local\Android\Sdk\emulator\emulator.exe'
$pkg = 'city.utopia.control'
$evidence = Join-Path $root 'evidence\raw\mission-book\UXI-301'
New-Item -ItemType Directory -Force -Path $evidence | Out-Null
$log = New-Object System.Collections.Generic.List[string]
function Note($m) { $log.Add([string]$m); Write-Output $m }

$TOKEN = 'uxi301-android-control'
$NODE_TOKEN = 'uxi301-android-node'
$PORT = 4310
$env:CITY_TOKEN = $TOKEN; $env:CITY_NODE_TOKEN = $NODE_TOKEN; $env:CITY_PORT = "$PORT"; $env:CITY_HOST = '127.0.0.1'
$env:CITY_URL = "http://127.0.0.1:$PORT"
Remove-Item Env:CITY_TELEMETRY_DISABLED -ErrorAction SilentlyContinue

$gw = $null; $node = $null; $emu = $null
try {
  Note '=== building the APK from this head ==='
  Push-Location (Join-Path $root 'apps\android')
  $env:JAVA_HOME = 'D:\GDPR-Refine\.tools\jdk-17.0.20.1+1'
  & .\gradlew.bat :app:assembleDebug --offline --console=plain 2>&1 | Select-Object -Last 2 | ForEach-Object { Note "  $_" }
  Pop-Location
  $apk = Join-Path $root 'apps\android\app\build\outputs\apk\debug\app-debug.apk'
  if (-not (Test-Path $apk)) { throw "APK not produced at $apk" }
  Note "  apk built: $((Get-Item $apk).Length) bytes"

  Note '=== starting the emulator (windowed, swiftshader) ==='
  $emu = Start-Process -PassThru -FilePath $emuExe -ArgumentList '-avd','utopia36','-gpu','swiftshader_indirect','-no-snapshot-save','-no-boot-anim' -WindowStyle Minimized
  & $adb wait-for-device 2>&1 | Out-Null
  for ($i = 0; $i -lt 120; $i++) {
    if ((((& $adb shell getprop sys.boot_completed 2>&1) -join '').Trim()) -eq '1') { break }
    Start-Sleep -Seconds 5
  }
  Note "  boot_completed after ~$($i*5)s"
  & $adb shell input keyevent 82 2>&1 | Out-Null

  Note '=== starting Gateway and a real reference node ==='
  $gw = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'services/dev-gateway/main.mjs' -WorkingDirectory $root
  $healthy = $false
  for ($i = 0; $i -lt 40; $i++) {
    try { $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT/api/v0/health" -UseBasicParsing -TimeoutSec 3; if ($r.StatusCode -eq 200) { $healthy = $true; break } } catch {}
    Start-Sleep -Milliseconds 500
  }
  Note "  gateway healthy=$healthy"
  if (-not $healthy) { throw 'GATEWAY_NOT_HEALTHY' }
  $node = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'agents/reference-node/main.mjs' -WorkingDirectory $root
  Start-Sleep -Seconds 5

  Note '=== installing the APK and seeding the connection ==='
  & $adb install -r $apk 2>&1 | Select-Object -Last 1 | ForEach-Object { Note "  $_" }
  & $adb reverse "tcp:$PORT" "tcp:$PORT" 2>&1 | Out-Null
  & $adb shell am force-stop $pkg 2>&1 | Out-Null
  $xml = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>" + "`n<map>`n    <string name=`"host`">http://127.0.0.1:$PORT</string>`n    <string name=`"token`">$TOKEN</string>`n</map>`n"
  $tmp = Join-Path $env:TEMP 'uxi301-conn.xml'
  [System.IO.File]::WriteAllText($tmp, $xml)
  & $adb push $tmp /data/local/tmp/uxi301-conn.xml 2>&1 | Out-Null
  & $adb shell "run-as $pkg cp /data/local/tmp/uxi301-conn.xml /data/data/$pkg/shared_prefs/city-connection.xml" 2>&1 | Out-Null
  $seeded = (& $adb shell "run-as $pkg cat /data/data/$pkg/shared_prefs/city-connection.xml" 2>&1) -join ''
  Note "  connection seeded: $($seeded -match [regex]::Escape($TOKEN))"

  function Read-Surface($label, $tries = 8) {
    # Retry until the dump actually has content: a 0-byte dump is a FAILED capture, not a quiet surface,
    # and treating it as a baseline silently weakens every later comparison against it.
    $dump = ''
    for ($t = 0; $t -lt $tries; $t++) {
      & $adb shell uiautomator dump /sdcard/uxi301.xml 2>&1 | Out-Null
      $dump = (& $adb shell cat /sdcard/uxi301.xml 2>&1) -join "`n"
      if ($dump -match '<node') { break }
      Start-Sleep -Seconds 3
    }
    [System.IO.File]::WriteAllText((Join-Path $evidence "android-surface-$label.xml"), $dump)
    $texts = [regex]::Matches($dump, 'text="([^"]*)"') | ForEach-Object { $_.Groups[1].Value } | Where-Object { $_ -ne '' }
    if (-not ($dump -match '<node')) { Note "  WARNING: the $label dump never produced content after $tries attempts; treating it as FAILED, not as an empty surface" }
    return $texts
  }

  Note '=== baseline: the surface while the fleet is healthy and idle ==='
  & $adb shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
  Start-Sleep -Seconds 14
  $idle = Read-Surface 'idle'
  Note "  idle surface texts: $(($idle | Select-Object -First 8) -join ' | ')"

  # MY OWN WEAK ASSERTION, CORRECTED. The first version stopped at the baseline and asserted the panel
  # TITLE was present - which it was, above the line "Nothing is waiting to run." The app was genuinely
  # connected, but with NO task in flight the panel had nothing substantive to show, so the assertion
  # proved almost nothing. That is the same vacuous pass I caught in the Web E2E, and the fix is the same:
  # create a REAL condition and require the surface to change because of it.
  Note '=== substantive condition: kill the executor, then create real work ==='
  if ($node) { Stop-Process -Id $node.Id -Force -ErrorAction SilentlyContinue }
  # WAIT for the City to actually observe the executor gone. Killing the process is not the condition;
  # the City calling the node offline is. Without this the work is assigned to a node the City still
  # believes is online, and the surface truthfully reports it as available - which is what happened.
  $offlineSeen = $false
  for ($t = 0; $t -lt 30; $t++) {
    Start-Sleep -Seconds 1
    $city = Invoke-RestMethod -Uri "http://127.0.0.1:$PORT/api/v0/city" -TimeoutSec 5 -Headers @{Authorization="Bearer $TOKEN";'X-City-Api-Version'='0';'X-City-Schema-Version'='0'}
    $online = @($city.nodes | Where-Object { $_.online -eq $true })
    if ($online.Count -eq 0) { $offlineSeen = $true; break }
  }
  Note "  the City observed the executor offline: $offlineSeen (after ~$t s)"
  if (-not $offlineSeen) { throw 'the City never observed the executor offline; refusing to claim a starved condition' }
  $created = Invoke-RestMethod -Uri "http://127.0.0.1:$PORT/api/v0/tasks" -Method Post -TimeoutSec 5 `
    -Headers @{Authorization="Bearer $TOKEN";'X-City-Api-Version'='0';'X-City-Schema-Version'='0';'Content-Type'='application/json'} `
    -Body '{"type":"CHECKPOINT_DEMO"}'
  Note "  created task $($created.id) with the executor gone"
  # Poll until the surface carries a PROVIDER line. A dump that holds only the state line and the task
  # id is a partial render racing the app's refresh, and scoring that as a missing reason would report a
  # product fault where there is only a capture race.
  $busy = @()
  $captureAttempts = 0
  for ($t = 0; $t -lt 12; $t++) {
    $captureAttempts = $t + 1
    $busy = Read-Surface 'starved'
    if (($busy -join ' ') -match 'Not available|Available') { break }
    Start-Sleep -Seconds 3
  }
  Note "  starved surface captured after $captureAttempts attempt(s)"
  Note "  starved surface texts: $(($busy | Select-Object -First 14) -join ' | ')"

  $rawTokens = @('SELECTABLE','DEVICE_UNREACHABLE','DEVICE_REFUSING','DEVICE_DISABLED','AT_CAPACITY','LOAD_UNMEASURED','PRESSURE_PAUSED','FRESHNESS_UNKNOWN','USER_DISABLED','POLICY_EXCLUDED','REMOTE_ONLINE')
  $leaked = @($rawTokens | Where-Object { ($busy -join ' | ') -match $_ })
  $reasonShown = @($busy | Where-Object { $_ -match "not available|can't be reached|isn't taking|turned off|still measuring|paused while|waiting its turn" })
  $changed = (($idle -join '|') -ne ($busy -join '|'))

  & $adb shell screencap -p /sdcard/uxi301.png 2>&1 | Out-Null
  & $adb pull /sdcard/uxi301.png (Join-Path $evidence 'android-surface-starved.png') 2>&1 | Out-Null

  $assertions = [ordered]@{
    'the app runs on a real device image and connects' = ($busy -contains 'ONLINE') -or (($busy -join ' ') -match 'ONLINE')
    'the connection was seeded with this run token' = ($seeded -match [regex]::Escape($TOKEN))
    'the scheduler panel renders its title on the device' = [bool](@($busy | Where-Object { $_ -eq 'WHY THINGS ARE WAITING' }).Count)
    'a BASELINE surface was captured, so the comparison is meaningful' = (@($idle).Count -gt 0)
    'the City really observed the executor offline before the work was created' = $offlineSeen
    'a REAL condition changed the device surface' = ($changed -and @($idle).Count -gt 0)
    'the panel states the scheduling reason in USER LANGUAGE' = (@($reasonShown).Count -gt 0)
    'no raw scheduler vocabulary is on the device surface' = (@($leaked).Count -eq 0)
  }
  $result = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    head = (& git -C $root rev-parse HEAD 2>&1) -join ''
    apkBytes = (Get-Item $apk).Length
    apkSha256 = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
    device = ((& $adb shell getprop ro.product.model 2>&1) -join '').Trim()
    abi = ((& $adb shell getprop ro.product.cpu.abi 2>&1) -join '').Trim()
    createdTaskId = $created.id
    cityObservedExecutorOffline = $offlineSeen
    starvedCaptureAttempts = $captureAttempts
    idleSurface = @($idle)
    starvedSurface = @($busy)
    rawVocabularyLeaked = $leaked
    userLanguageReasons = $reasonShown
    assertions = $assertions
  }
  $result['verdict'] = if ((@($assertions.Values | Where-Object { -not $_ })).Count -eq 0) { 'PASS' } else { 'FAIL' }
  $result['notes'] = $log
  [System.IO.File]::WriteAllText((Join-Path $evidence 'android-real-acceptance.json'), ($result | ConvertTo-Json -Depth 6))
  Note "=== VERDICT: $($result.verdict) ==="
  foreach ($k in $assertions.Keys) { Note ("  [{0}] {1}" -f $(if ($assertions[$k]) { 'PASS' } else { 'FAIL' }), $k) }
}
catch {
  Note "ERROR: $($_.Exception.Message)"
  [System.IO.File]::WriteAllText((Join-Path $evidence 'android-real-acceptance-error.json'), (@{verdict='ERROR'; error=$_.Exception.Message; notes=$log} | ConvertTo-Json -Depth 4))
}
finally {
  if ($node) { Stop-Process -Id $node.Id -Force -ErrorAction SilentlyContinue }
  if ($gw) { Stop-Process -Id $gw.Id -Force -ErrorAction SilentlyContinue }
  if ($emu) { Stop-Process -Id $emu.Id -Force -ErrorAction SilentlyContinue }
  Get-Process qemu-system-x86_64* -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  & $adb kill-server 2>&1 | Out-Null
}
