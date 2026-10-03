# UXI-391 Step 3 item 13 / Step 6 - drive the ANDROID surface across a REAL handoff.
#
# The workbook requires the result to return to "the still-open original interaction surface"; the Web half is
# already driven (scripts/uxi391-handoff-e2e.mjs). This is the Android half, on the REAL attached device,
# against a real Gateway and two real nodes, with the app pointed at THIS run's gateway and never restarted.
#
# THREE THINGS THIS SCRIPT HAD TO LEARN, each recorded because each cost a failed run:
#
#  1. THE APP IS NAVIGATED BY FRACTION, NOT BY NODE. On this build the five nav labels (Home/Ask/Rooms/Devices/
#     Activity) are nodes whose bounds are ALL [0,0][0,0] and which are NOT clickable - the same trap UXI-390
#     recorded - while the real tap targets are five ~216px slots along the bottom bar. Tapping "the 4th
#     clickable node above 70% height" therefore landed on whatever else was clickable down there.
#  2. THE IN-FLIGHT WINDOW IS NOT WHERE THE EVIDENCE HAS TO BE TAKEN. WAIT holds a node for only about six
#     seconds, and a single uiautomator dump costs seconds, so trying to photograph the panel BEFORE stopping
#     node A loses the race twice over. It does not have to be won: after A's worker stops, the assignment
#     survives and the run stays RUNNING on a dead device, which is a LONG window. So A is stopped first and
#     the surface is read afterwards.
#  3. THE PANEL AND THE RESULT LIVE ON DIFFERENT SURFACES. The Devices panel lists work IN FLIGHT and drops a
#     run the moment it completes; the finished run appears on Home's recent list. Asserting the result on the
#     panel would fail even when the handoff worked perfectly.
#
# ASCII-ONLY ON PURPOSE: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI. Text read from the device
# travels as DATA and is written as UTF-8 without BOM.
$ErrorActionPreference = 'Continue'
$adb  = 'C:\Users\15601\AppData\Local\Android\Sdk\platform-tools\adb.exe'
$root = 'D:\utopia-uxi391'
$port = 4394
$token = 'uxi391-android-handoff'
$nodeToken = 'uxi391-android-node'
$data = Join-Path $root '.runtime-uxi391-android'
$out  = Join-Path $root 'evidence\raw\mission-book\UXI-391'
$pkg  = 'city.utopia.control'
New-Item -ItemType Directory -Force -Path $out | Out-Null
Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Join-Path $data 'workspace') | Out-Null

$env:CITY_TOKEN = $token; $env:CITY_NODE_TOKEN = $nodeToken
$env:CITY_HOST = '127.0.0.1'; $env:CITY_PORT = "$port"; $env:CITY_URL = "http://127.0.0.1:$port"
$env:CITY_DATA = $data; $env:CITY_WORKSPACE = (Join-Path $data 'workspace')
Remove-Item Env:CITY_TELEMETRY_DISABLED -ErrorAction SilentlyContinue

$hdr = @{ Authorization = "Bearer $token"; 'X-City-Api-Version' = '0'; 'X-City-Schema-Version' = '0' }
$base = "http://127.0.0.1:$port/api/v0"
$started = @(); $failures = @(); $log = @()
function Say($m) { Write-Host $m; $script:log += $m }
function Check($name, $ok, $detail = '') {
  if (-not $ok) { $script:failures += "$name - $detail" }
  Say ("  [{0}] {1}{2}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $(if ($detail) { " - $detail" } else { '' }))
}
function Api($path, $method = 'GET', $body = $null) {
  $p = @{ Uri = "$base/$path"; Headers = $hdr; Method = $method; TimeoutSec = 10 }
  if ($body) { $p.Body = $body; $p.ContentType = 'application/json' }
  return Invoke-RestMethod @p
}
function WaitFor($label, [scriptblock]$pred, $tries = 60, $every = 1) {
  for ($i = 0; $i -lt $tries; $i++) { try { if (& $pred) { return $true } } catch { }; Start-Sleep -Seconds $every }
  throw "timeout waiting for $label"
}
function Dump {
  & $adb shell uiautomator dump /data/local/tmp/uxi391-android.xml 2>&1 | Out-Null
  return (& $adb shell cat /data/local/tmp/uxi391-android.xml 2>&1 | Out-String)
}
function VisibleText($xml) {
  $o = New-Object System.Collections.ArrayList
  foreach ($m in [regex]::Matches($xml, 'text="([^"]+)"')) { [void]$o.Add($m.Groups[1].Value) }
  foreach ($m in [regex]::Matches($xml, 'content-desc="([^"]+)"')) { [void]$o.Add($m.Groups[1].Value) }
  return (($o | Where-Object { $_.Trim().Length -gt 0 }) -join ' | ')
}
function ScreenSize {
  $s = (& $adb shell wm size) -join ' '
  $m = [regex]::Match($s, '(\d+)x(\d+)')
  if ($m.Success) { return @{ w = [int]$m.Groups[1].Value; h = [int]$m.Groups[2].Value } }
  return @{ w = 1080; h = 2400 }
}
# Slot 0..4 = Home / Ask / Rooms / Devices / Activity, tapped by FRACTION of the bar.
function NavTap($slot, $size) {
  $x = [int](($slot + 0.5) * ($size.w / 5.0))
  $y = [int]($size.h * 0.925)
  & $adb shell input tap $x $y 2>&1 | Out-Null
}

try {
  Say "=== UXI-391 Android handoff drive: port $port, fresh city $data ==="
  $gw = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'services/dev-gateway/main.mjs' -WorkingDirectory $root
  $started += $gw
  WaitFor 'gateway health' { try { (Invoke-WebRequest -Uri "$base/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { $false } } 40 1
  $nodeA = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'scripts/uxi391-node.mjs uxi391-android-a "Android node A"' -WorkingDirectory $root
  $started += $nodeA
  WaitFor 'node A online' { ((Api 'city').nodes | Where-Object { $_.id -eq 'uxi391-android-a' -and $_.online }) } 40 1
  Say '  gateway healthy, node A online'

  & $adb shell am force-stop $pkg 2>&1 | Out-Null
  $xml = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>`n<map>`n    <string name=`"host`">http://127.0.0.1:$port</string>`n    <string name=`"token`">$token</string>`n</map>`n"
  $tmp = Join-Path $env:TEMP 'cc-uxi391-android.xml'
  [System.IO.File]::WriteAllText($tmp, $xml, (New-Object System.Text.UTF8Encoding($false)))
  & $adb push $tmp /data/local/tmp/cc-uxi391-android.xml 2>&1 | Out-Null
  & $adb shell run-as $pkg mkdir -p shared_prefs 2>&1 | Out-Null
  & $adb shell run-as $pkg cp /data/local/tmp/cc-uxi391-android.xml shared_prefs/city-connection.xml 2>&1 | Out-Null
  & $adb reverse "tcp:$port" "tcp:$port" 2>&1 | Out-Null
  & $adb shell input keyevent 224 2>&1 | Out-Null
  & $adb shell am start -n "$pkg/.MainActivity" 2>&1 | Out-Null
  Start-Sleep -Seconds 14
  $size = ScreenSize
  $startText = VisibleText (Dump)
  Check 'the app is pointed at THIS run and reports its own connection' (($startText -match 'ONLINE') -and ($startText -match 'WHY THINGS ARE WAITING')) $startText.Substring(0, [Math]::Min(150, $startText.Length))

  # ---- create the target and stop A FIRST; the long non-terminal window is what gets photographed -------
  $target = (Api 'tasks' 'POST' '{"type":"WAIT"}').id
  WaitFor 'target RUNNING on A' { $t = Api "tasks/$target"; $t.state -eq 'RUNNING' -and $t.assignedNodeId -eq 'uxi391-android-a' } 20 1
  Say "  target $target is RUNNING on node A - stopping A's worker now, before the surface is read"
  $nodeA.Kill(); Start-Sleep -Seconds 1
  WaitFor 'A swept offline' { ((Api 'city').nodes | Where-Object { $_.id -eq 'uxi391-android-a' }).online -eq $false } 40 1

  NavTap 3 $size; Start-Sleep -Seconds 4
  $panelText = VisibleText (Dump)
  $taskNow = Api "tasks/$target"
  Check 'the run is still NON-TERMINAL with its owner gone (the long honest window)' (-not (@('COMPLETED', 'FAILED', 'CANCELLED') -contains $taskNow.state)) ("state=" + $taskNow.state + " assigned=" + $taskNow.assignedNodeId)
  Check 'the app shows that run in flight on its scheduler panel' ($panelText -match [regex]::Escape($target)) $panelText.Substring(0, [Math]::Min(190, $panelText.Length))
  Check 'the panel explains the state in user language, not raw vocabulary' ($panelText -match 'WAITING|waiting|another|available|reduced') $panelText.Substring(0, [Math]::Min(150, $panelText.Length))

  # ---- the handoff ------------------------------------------------------------------------------------
  $nodeB = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'scripts/uxi391-node.mjs uxi391-android-b "Android node B"' -WorkingDirectory $root
  $started += $nodeB
  WaitFor 'node B online' { ((Api 'city').nodes | Where-Object { $_.id -eq 'uxi391-android-b' -and $_.online }) } 40 1
  [void](Api "tasks/$target/switch-declined" 'POST' '{}')

  $handoffSeen = $false
  $panelDumps = @()
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 2
    $text = VisibleText (Dump)
    $panelDumps += $text
    if ($text -match 'another device' -or $text -match 'Handed to another') { $handoffSeen = $true }
    $t = Api "tasks/$target"
    if (@('COMPLETED', 'FAILED', 'CANCELLED') -contains $t.state) { break }
  }
  $finalTask = Api "tasks/$target"
  Check 'the run reached terminal success while the app watched' ($finalTask.state -eq 'COMPLETED') ("state=" + $finalTask.state)
  Check 'the handoff really moved the run off node A' ($finalTask.handoffFromRef -eq 'uxi391-android-a' -and $finalTask.handoffTargetRef -eq 'uxi391-android-b') ("from=" + $finalTask.handoffFromRef + " to=" + $finalTask.handoffTargetRef)
  Check 'the completion came from real execution' ($finalTask.result.waitedMs -eq 6000) ($finalTask.result | ConvertTo-Json -Compress)

  # ---- result return on the SAME app instance, on the surface that lists finished work ------------------
  NavTap 0 $size; Start-Sleep -Seconds 4
  $homeText = VisibleText (Dump)
  Check 'the finished run is visible on the app it was never moved away from' (($homeText -match [regex]::Escape($target)) -and ($homeText -match 'COMPLETED')) $homeText.Substring(0, [Math]::Min(200, $homeText.Length))

  $rawTokens = @('PRESSURE_PAUSED', 'USER_DISABLED', 'DEVICE_UNREACHABLE', 'DEVICE_REFUSING', 'DEVICE_DISABLED',
    'AT_CAPACITY', 'LOAD_UNMEASURED', 'FRESHNESS_UNKNOWN', 'POLICY_EXCLUDED', 'SELECTABLE', 'REMOTE_HANDOFF',
    'WAITING_USER', 'STRUCTURAL', 'RESOURCE', 'CHANNEL_READINESS_UNKNOWN', 'AVAILABILITY_UNKNOWN')
  $allText = @{ 'start' = $startText; 'panel' = $panelText; 'handoff' = ($panelDumps -join ' || '); 'home' = $homeText }
  $leaked = @()
  foreach ($pair in $allText.GetEnumerator()) { foreach ($tk in $rawTokens) { if ($pair.Value -match [regex]::Escape($tk)) { $leaked += "$($pair.Key):$tk" } } }
  Check 'no raw scheduler token leaked into any rendered surface' ($leaked.Count -eq 0) ($leaked -join ', ')

  $receipt = [pscustomobject]@{
    task = 'UXI-391'; step = '3 item 13 / 6 (Android surface across a handoff)'
    at = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    device = ((& $adb devices) -join ' ').Trim(); gatewayPort = $port; targetTaskId = $target
    screen = "$($size.w)x$($size.h)"; appRestartedByScript = $false
    handoffStateSeenOnDevice = $handoffSeen
    terminal = $finalTask.state; handoffFrom = $finalTask.handoffFromRef; handoffTo = $finalTask.handoffTargetRef
    result = $finalTask.result
    dumps = [pscustomobject]@{ start = $startText; panelInFlight = $panelText; duringHandoff = $panelDumps; homeAfter = $homeText }
    failures = $failures; log = $log
  }
  [System.IO.File]::WriteAllText((Join-Path $out 'android-handoff.json'), ($receipt | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  Say "wrote $(Join-Path $out 'android-handoff.json')"
  Say $(if ($failures.Count -eq 0) { 'RESULT: PASS - the Android surface followed a real handoff it did not trigger' } else { "RESULT: FAIL - $($failures.Count): $($failures -join ' | ')" })
}
catch { Say ("SCRIPT ERROR: " + $_.Exception.Message); $failures += ("script error: " + $_.Exception.Message) }
finally { foreach ($p in $started) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } } }
