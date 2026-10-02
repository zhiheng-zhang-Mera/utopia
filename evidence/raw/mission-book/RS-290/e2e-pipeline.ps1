# RS-290 two-device E2E pipeline - ONE command, because the harness kills the process tree
# when a tool call ends (Mech's measured environment fact), so services cannot be started in an
# earlier call. The APK is already built from the integrated head and installed with a verified
# hash match, so it is deliberately NOT rebuilt here.
$ErrorActionPreference = 'Continue'
$root = 'D:\utopia-rs290'
$adb = 'C:\Users\15601\AppData\Local\Android\Sdk\platform-tools\adb.exe'
$ev = "$root\.runtime\evidence\rs-290"
New-Item -ItemType Directory -Force -Path $ev | Out-Null

$env:CITY_TOKEN = 'alien-rs290-control-7f31'
$env:CITY_NODE_TOKEN = 'alien-rs290-node-9c42'
$env:CITY_PORT = '4310'
$env:CITY_HOST = '127.0.0.1'
$env:ADB = $adb
$env:CITY_ROOMS_URL = 'http://127.0.0.1:4320'
# Deliberately NOT setting CITY_TELEMETRY_DISABLED: RS-203 root-caused the recovery failure to that
# flag suppressing the freshness the recovery scrape depends on.
Remove-Item Env:CITY_TELEMETRY_DISABLED -ErrorAction SilentlyContinue

Write-Output "PIPELINE_START $((Get-Date).ToUniversalTime().ToString('o'))"
cd $root

# clear any stale listeners so a previous run cannot serve us a different build
foreach ($port in 4310, 4320) {
  Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2

# 1. gateway
$gw = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'services/dev-gateway/main.mjs' -WorkingDirectory $root
Write-Output "gateway pid=$($gw.Id)"

# 2. wait for health
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:4310/api/v0/health' -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) { $healthy = $true; Write-Output "gateway healthy after ${i}s: $($r.Content)"; break }
  } catch { }
}
if (-not $healthy) { Write-Output "GATEWAY_NOT_HEALTHY - aborting"; Stop-Process -Id $gw.Id -Force -ErrorAction SilentlyContinue; exit 1 }

# 3. rooms hub (pilot opens the Web UI)
$hub = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'apps/rooms/hub/server.mjs' -WorkingDirectory $root
Write-Output "hub pid=$($hub.Id)"

# 4. reference node - a REAL executor, which is what makes this an E2E rather than a mock
$node = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'agents/reference-node/main.mjs' -WorkingDirectory $root
Write-Output "node pid=$($node.Id)"
Start-Sleep -Seconds 5

# 5. the two config files the pilot READS but never writes
[System.IO.File]::WriteAllText("$root\.runtime\local-config.json", (@{ token = $env:CITY_TOKEN; nodeToken = $env:CITY_NODE_TOKEN } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
[System.IO.File]::WriteAllText("$root\.runtime\processes.json", (@{ url = 'http://127.0.0.1:4310'; roomsUrl = 'http://127.0.0.1:4320' } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "configs written"

# 5b. seed the APP's own stored connection with THIS run's credentials.
# The first attempt skipped this and failed for a precise reason worth recording: the app still held the
# token from an earlier UI-190 session, so it read OFFLINE with 'Failed to connect to /127.0.0.1:4310',
# never rendered the task surface, and the pilot's route guard correctly refused to tap blindly. The
# mechanism is the one Mech established for the RS-203 capture: stage in /data/local/tmp and copy with
# run-as cp, with NO extra sh -c, because /sdcard staging hits scoped storage and shell redirection is
# refused, and an extra shell breaks run-as's working-directory assumption.
$xml = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>`n<map>`n    <string name=`"host`">http://127.0.0.1:4310</string>`n    <string name=`"token`">$($env:CITY_TOKEN)</string>`n</map>`n"
$tmp = Join-Path $env:TEMP 'cc-rs290.xml'
[System.IO.File]::WriteAllText($tmp, $xml, (New-Object System.Text.UTF8Encoding($false)))
& $adb shell am force-stop city.utopia.control 2>&1 | Out-Null
& $adb push $tmp /data/local/tmp/cc-rs290.xml 2>&1 | Out-Null
& $adb shell run-as city.utopia.control mkdir -p shared_prefs 2>&1 | Out-Null
& $adb shell run-as city.utopia.control cp /data/local/tmp/cc-rs290.xml shared_prefs/city-connection.xml 2>&1 | Out-Null
Write-Output "app prefs seeded: $((& $adb shell run-as city.utopia.control cat shared_prefs/city-connection.xml 2>&1) -join ' ')"
# relink the host gateway into the device's loopback, then bring the app up so the surface renders
& $adb reverse tcp:4310 tcp:4310 2>&1 | Out-Null
& $adb shell input keyevent 224 2>&1 | Out-Null
& $adb shell am start -n city.utopia.control/.MainActivity 2>&1 | Select-Object -Last 1
Start-Sleep -Seconds 8

# 5c. PRE-NAVIGATE TO HOME using a node with NON-ZERO bounds.
# The ablation run established WHY this is needed: the pilot's own route resolution matches the FIRST
# node carrying the label 'Home', and that node has bounds [0,0][0,0] on this build - a zero-sized entry
# - so the pilot taps the screen corner, a no-op, and never leaves the Devices page where Run Test Task
# is legitimately absent. Rather than edit a harness Mech already reviewed, this pipeline puts the app on
# the page where the control renders, so the pilot finds it already visible and no route tap is needed.
function Get-Ui2 { & $adb shell uiautomator dump /data/local/tmp/pn.xml 2>&1 | Out-Null; & $adb shell cat /data/local/tmp/pn.xml 2>&1 | Out-String }
$dumped = Get-Ui2
# The label is useless as a tap target on this build: the ONLY node carrying text="Home" has bounds
# [0,0][0,0] and is NOT clickable, while the real tab is a clickable node in the bottom bar. So the tab is
# located by being a CLICKABLE node in the bar row rather than by its label - which is also the reason
# Mech's original hard-coded `input tap 108 2195` worked and its label-based replacement does not: on a
# 1080x2400 device 108 is the centre of the first tab. This taps the clickable node instead, so it does
# not depend on that coincidence.
$tab = $null
foreach ($m in [regex]::Matches($dumped, '<node\s+([^>]+?)/?>')) {
  $attrs = $m.Groups[1].Value
  if ($attrs -notmatch 'clickable="true"') { continue }
  $b = [regex]::Match($attrs, 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
  if (-not $b.Success) { continue }
  $x1=[int]$b.Groups[1].Value; $y1=[int]$b.Groups[2].Value; $x2=[int]$b.Groups[3].Value; $y2=[int]$b.Groups[4].Value
  # bottom bar row on a 1080x2400 device, and the FIRST tab is Home
  if ($y1 -gt 2000 -and ($x2 - $x1) -gt 0 -and ($y2 - $y1) -gt 0) {
    if (-not $tab -or $x1 -lt $tab[3]) { $tab = @([int](($x1+$x2)/2), [int](($y1+$y2)/2), "$x1,$y1-$x2,$y2", $x1) }
  }
}
if ($tab) {
  Write-Output "pre-navigating to the FIRST bottom-bar tab (Home) at ($($tab[0]),$($tab[1])) bounds=$($tab[2])"
  & $adb shell input tap $tab[0] $tab[1] 2>&1 | Out-Null
  Start-Sleep -Milliseconds 1800
  $after = Get-Ui2
  Write-Output "  RunTestTask visible after pre-nav: $($after -match 'Run Test Task')"
  Write-Output ("  texts: " + (([regex]::Matches($after,'text="([^"]{1,40})"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique) -join ' | '))
} else {
  Write-Output "PRE-NAV: no clickable bottom-bar node found; leaving the app where it is"
}
Write-Output "  local-config: $(Get-Content "$root\.runtime\local-config.json" -Raw)"
Write-Output "  processes:    $(Get-Content "$root\.runtime\processes.json" -Raw)"

# 6. confirm the node registered before driving the UI
# The pilot writes its evidence to .runtime/evidence/v0.2/task-regression.json and does NOT create the
# directory, so the run that finally reached the end failed with ENOENT at the write. One line fixes it,
# and it is deliberately done here rather than by editing a harness Mech already reviewed.
New-Item -ItemType Directory -Force -Path "$root\.runtime\evidence\v0.2" | Out-Null
try {
  $h = @{ Authorization = 'Bearer ' + $env:CITY_TOKEN; 'X-City-Api-Version'='0'; 'X-City-Schema-Version'='0' }
  $city = (Invoke-WebRequest -Uri 'http://127.0.0.1:4310/api/v0/city' -Headers $h -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
  Write-Output "pre-run nodes=$($city.nodes.Count) tasks=$($city.tasks.Count)"
} catch { Write-Output "pre-run snapshot failed: $($_.Exception.Message)" }

# 7. run the success-path pilot
Write-Output "=== running device-task-pilot.mjs ==="
$out = & node scripts/device-task-pilot.mjs 2>&1
$code = $LASTEXITCODE
$out | ForEach-Object { "  $_" }
Write-Output "pilot_exit=$code"

# 8. collect whatever evidence the pilot produced, and say so if there is none
Write-Output "=== evidence produced ==="
Get-ChildItem "$root\.runtime" -Recurse -File -Include *.json -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'task-regression|local-config|processes' } |
  ForEach-Object { "  $($_.FullName.Replace($root, ''))  $($_.Length)B" }

# 9. tear down
foreach ($p in @($gw, $hub, $node)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
Write-Output "PIPELINE_END $((Get-Date).ToUniversalTime().ToString('o'))"
