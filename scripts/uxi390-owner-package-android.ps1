# UXI-390 step 5 - capture the Android half of the minimal Owner-facing package.
#
# The workbook asks for Android Home / Ask / Tools so the Owner can give the FINAL_VISUAL_ACCEPTANCE ruling.
# This drives the REAL installed app (city.utopia.control) on the REAL attached device against a REAL gateway
# and reference node started by this script, taps the real bottom-bar tabs, and captures what the device paints.
#
# ASCII-ONLY ON PURPOSE: PowerShell 5.1 decodes a BOM-less UTF-8 script as ANSI, so any non-ASCII literal in
# here would arrive mangled - the same class of defect that corrupted the UXI-390 workbook body. Labels read
# from the device are carried as DATA (JSON written as UTF-8 without BOM), never as script literals.
#
# The receipt records the visible text of each captured surface, and the run FAILS if two surfaces render the
# same text, because three screenshots of one page would be a vacuous package.

# NOT 'Stop': adb writes ordinary progress ("1 file pushed") to stderr, and under PowerShell 5.1 with
# ErrorActionPreference=Stop that becomes a terminating NativeCommandError. Measured, not guessed: the first
# run of this script died inside `adb push` with the push itself having succeeded. Assertions below are
# therefore explicit (file existence, dumps, hash counts) instead of relying on the preference.
$ErrorActionPreference = 'Continue'
$adb  = 'C:\Users\15601\AppData\Local\Android\Sdk\platform-tools\adb.exe'
$root = 'D:\utopia-uxi390'
$port = 4361
$hubPort = 4320
$token = 'uxi390-ownerpkg-android-7a31'
$out  = Join-Path $root 'evidence\raw\mission-book\UXI-390\owner-package'
$pkg  = 'city.utopia.control'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$env:CITY_TOKEN = $token
$env:CITY_NODE_TOKEN = 'uxi390-ownerpkg-android-node-3b58'
$env:CITY_PORT = "$port"
$env:CITY_HOST = '127.0.0.1'
$env:CITY_URL = "http://127.0.0.1:$port"
$env:CITY_DATA = Join-Path $root '.runtime-ownerpkg-android'
$env:CITY_WORKSPACE = Join-Path $env:CITY_DATA 'workspace'
$env:ROOMS_PORT = "$hubPort"
Remove-Item Env:CITY_TELEMETRY_DISABLED -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $env:CITY_DATA -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $env:CITY_WORKSPACE | Out-Null

$started = @()
$head = (& git -C $root rev-parse HEAD).Trim()
"=== UXI-390 step 5, Android package: gateway $port, hub $hubPort, head $head ==="

try {
  $hub = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'apps/rooms/hub/server.mjs' -WorkingDirectory $root
  $started += $hub
  $hubUp = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try { if ((Invoke-WebRequest -Uri "http://127.0.0.1:$hubPort/" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $hubUp = $true; break } } catch { }
  }
  "room hub up: $hubUp"

  $gw = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'services/dev-gateway/main.mjs' -WorkingDirectory $root
  $started += $gw
  $healthy = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try { if ((Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/v0/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $healthy = $true; break } } catch { }
  }
  if (-not $healthy) { throw 'gateway never became healthy' }
  "gateway healthy"

  # Asserted rather than assumed: without the hub the Tools / Rooms surface truthfully reports unavailability,
  # and a screenshot of that state is not the package the Owner is being asked to judge.
  $hdr = @{ Authorization = "Bearer $token"; 'X-City-Api-Version' = '0'; 'X-City-Schema-Version' = '0' }
  $rooms = (Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/v0/rooms" -Headers $hdr -UseBasicParsing -TimeoutSec 8).Content | ConvertFrom-Json
  "rooms available: $($rooms.rooms.available)  count: $($rooms.rooms.count)"

  $node = Start-Process -PassThru -WindowStyle Hidden -FilePath 'node' -ArgumentList 'agents/reference-node/main.mjs' -WorkingDirectory $root
  $started += $node
  Start-Sleep -Seconds 8

  # Seed the app's own stored connection with THIS run's token. Stage in /data/local/tmp and copy with run-as,
  # no extra sh -c, because /sdcard hits scoped storage.
  $xml = "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>`n<map>`n    <string name=`"host`">http://127.0.0.1:$port</string>`n    <string name=`"token`">$token</string>`n</map>`n"
  $tmp = Join-Path $env:TEMP 'cc-uxi390-ownerpkg.xml'
  [System.IO.File]::WriteAllText($tmp, $xml, (New-Object System.Text.UTF8Encoding($false)))
  & $adb shell am force-stop $pkg 2>&1 | Out-Null
  & $adb push $tmp /data/local/tmp/cc-uxi390-ownerpkg.xml 2>&1 | Out-Null
  & $adb shell run-as $pkg mkdir -p shared_prefs 2>&1 | Out-Null
  & $adb shell run-as $pkg cp /data/local/tmp/cc-uxi390-ownerpkg.xml shared_prefs/city-connection.xml 2>&1 | Out-Null
  & $adb reverse "tcp:$port" "tcp:$port" 2>&1 | Out-Null
  & $adb shell input keyevent 224 2>&1 | Out-Null
  & $adb shell am start -n "$pkg/.MainActivity" 2>&1 | Select-Object -Last 1 | Out-Null
  Start-Sleep -Seconds 14

  $size = (& $adb shell wm size) -join ' '
  $m = [regex]::Match($size, '(\d+)x(\d+)')
  $screenH = if ($m.Success) { [int]$m.Groups[2].Value } else { 2340 }
  "device screen: $size (bottom-bar threshold y >= $([int]($screenH * 0.7)))"

  function Dump {
    & $adb shell uiautomator dump /data/local/tmp/ownerpkg.xml 2>&1 | Out-Null
    return (& $adb shell cat /data/local/tmp/ownerpkg.xml 2>&1 | Out-String)
  }
  function VisibleText($xml) {
    $out = New-Object System.Collections.ArrayList
    foreach ($mm in [regex]::Matches($xml, 'text="([^"]+)"')) { [void]$out.Add($mm.Groups[1].Value) }
    foreach ($mm in [regex]::Matches($xml, 'content-desc="([^"]+)"')) { [void]$out.Add($mm.Groups[1].Value) }
    return ($out | Where-Object { $_.Trim().Length -gt 0 }) -join ' | '
  }
  function BottomTabs($xml) {
    $res = New-Object System.Collections.ArrayList
    foreach ($mm in [regex]::Matches($xml, '<node\s+([^>]+?)/?>')) {
      $a = $mm.Groups[1].Value
      if ($a -notmatch 'clickable="true"') { continue }
      $b = [regex]::Match($a, 'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
      if (-not $b.Success) { continue }
      $x1 = [int]$b.Groups[1].Value; $y1 = [int]$b.Groups[2].Value
      $x2 = [int]$b.Groups[3].Value; $y2 = [int]$b.Groups[4].Value
      if ($y1 -lt ($screenH * 0.7)) { continue }
      $t = [regex]::Match($a, 'text="([^"]*)"')
      $d = [regex]::Match($a, 'content-desc="([^"]*)"')
      $label = if ($t.Success -and $t.Groups[1].Value.Trim().Length -gt 0) { $t.Groups[1].Value }
               elseif ($d.Success) { $d.Groups[1].Value } else { '' }
      [void]$res.Add([pscustomobject]@{ x = [int](($x1 + $x2) / 2); y = [int](($y1 + $y2) / 2); label = $label })
    }
    return ($res | Sort-Object { $_.x })
  }

  $tabs = BottomTabs (Dump)
  "bottom-bar tabs found: $($tabs.Count)"
  $tabs | ForEach-Object { "  tab @($($_.x),$($_.y)) label='$($_.label)'" }

  $wanted = @(
    @{ name = 'home';  match = 'Home' },
    @{ name = 'ask';   match = 'Ask' },
    @{ name = 'tools'; match = 'Room' }
  )

  $images = New-Object System.Collections.ArrayList
  $textsByTab = @{}
  foreach ($w in $wanted) {
    $tab = $tabs | Where-Object { $_.label -and $_.label -match $w.match } | Select-Object -First 1
    if (-not $tab) {
      # Fall back to position only when the label is unreadable, and SAY SO rather than silently guessing.
      $idx = [array]::IndexOf($wanted, $w)
      $tab = if ($idx -lt $tabs.Count) { $tabs[$idx] } else { $null }
      "tab '$($w.match)' not found by label; falling back to position $idx"
    }
    if (-not $tab) { "tab '$($w.match)' unavailable - skipping"; continue }
    & $adb shell input tap $tab.x $tab.y 2>&1 | Out-Null
    Start-Sleep -Seconds 4
    $dump = Dump
    $text = VisibleText $dump
    $textsByTab[$w.name] = $text
    $remote = '/sdcard/uxi390-ownerpkg.png'
    & $adb shell screencap -p $remote 2>&1 | Out-Null
    $local = Join-Path $out ("android-$($w.name).png")
    & $adb pull $remote $local 2>&1 | Out-Null
    & $adb shell rm $remote 2>&1 | Out-Null
    if (-not (Test-Path $local)) { throw "screenshot for $($w.name) was not pulled" }
    $bytes = [System.IO.File]::ReadAllBytes($local)
    $sha = (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash.ToLower()
    [void]$images.Add([pscustomobject]@{
      file = "evidence/raw/mission-book/UXI-390/owner-package/android-$($w.name).png"
      bytes = $bytes.Length
      sha256 = $sha
      tabTapped = "$($w.name) @($($tab.x),$($tab.y)) label='$($tab.label)'"
      visibleText = $text.Substring(0, [Math]::Min(600, $text.Length))
    })
    "captured android-$($w.name).png  $($bytes.Length) bytes  sha256=$($sha.Substring(0,16))..."
    "  visible: $($text.Substring(0, [Math]::Min(200, $text.Length)))"
  }

  $distinct = ($textsByTab.Values | Sort-Object -Unique).Count
  $hashes = ($images | ForEach-Object { $_.sha256 } | Sort-Object -Unique).Count
  $receipt = [pscustomobject]@{
    task = 'UXI-390'
    step = '5 (Android half of the minimal Owner-facing package)'
    capturedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    implementationHead = $head
    device = ((& $adb devices) -join ' ').Trim()
    gatewayPort = $port
    roomHubPort = $hubPort
    roomsAvailable = $rooms.rooms.available
    screenshots = $images
    distinctSurfaces = $distinct
    distinctImageHashes = $hashes
  }
  $receiptPath = Join-Path $out 'capture-receipt-android.json'
  [System.IO.File]::WriteAllText($receiptPath, ($receipt | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  "wrote $receiptPath"
  "surfaces captured: $($images.Count); distinct visible-text sets: $distinct; distinct image hashes: $hashes"

  if ($images.Count -lt 3) { throw "expected three Android surfaces, captured $($images.Count)" }
  if ($distinct -lt 3) { throw 'two captured Android surfaces render the same text - the package would be vacuous' }
  if ($hashes -lt 3) { throw 'two captured Android images are identical - the package would be vacuous' }
  "RESULT: PASS - Android Home / Ask / Tools captured on the real device, all three surfaces distinct"
}
finally {
  foreach ($p in $started) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { } }
}
