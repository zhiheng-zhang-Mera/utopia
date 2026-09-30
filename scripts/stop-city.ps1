# Stop the Utopia Host started by scripts/start-city.ps1.
#
# Every process is verified against its own expected command line before it is stopped, so
# a recycled PID can never take down an unrelated program. The Room Hub is included: a
# graceful stop must not leave a second hub behind for the next start to trip over.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $root '.runtime'
$processesPath = Join-Path $runtime 'processes.json'

if (!(Test-Path -LiteralPath $processesPath)) {
    Write-Output 'No .runtime/processes.json; nothing recorded as running.'
    exit 0
}
$processes = Get-Content -LiteralPath $processesPath -Raw | ConvertFrom-Json

# Strict Room Hub matching, shared with the launcher. A loose `-like` here once matched the
# command text of the shell running the sweep itself and killed it.
. (Join-Path $PSScriptRoot 'host-processes.ps1')

function Stop-Recorded([int]$id, [string]$relativePath, [string]$label) {
    if (!$id) { return 'not recorded' }
    if (Test-UtopiaProcessArgument $id $relativePath) {
        Stop-Process -Id $id -Force
        return 'stopped'
    }
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
    if (!$live) { return 'already stopped' }
    Write-Warning "PID $id does not look like $label; refusing to stop it."
    return 'refused (unexpected command line)'
}

$result = [ordered]@{
    # The Agent is a client of the Gateway, so it goes first: stopping it before the Gateway
    # avoids a burst of failed heartbeats in the log.
    agent   = Stop-Recorded $processes.agentPid 'agents/reference-node/main.mjs' 'the reference node Agent'
    gateway = Stop-Recorded $processes.gatewayPid 'services/dev-gateway/main.mjs' 'the Gateway'
}

# The recorded room PID is checked against the strict hub pattern, not a loose substring,
# so a recycled PID pointing at something else is reported rather than killed.
if (!$processes.roomsPid) {
    $result.rooms = 'not recorded'
} elseif (Test-UtopiaRoomHubProcess $processes.roomsPid) {
    Stop-Process -Id $processes.roomsPid -Force -ErrorAction SilentlyContinue
    $result.rooms = 'stopped'
} else {
    $live = Get-CimInstance Win32_Process -Filter "ProcessId=$($processes.roomsPid)" -ErrorAction SilentlyContinue
    $result.rooms = if ($live) { 'refused (unexpected command line)' } else { 'already stopped' }
}

# Anything the recorded PIDs missed is still something this host started, so sweep the
# remaining ones by strict match. Without this, a crash between start and stop leaves a
# listener on the room port — and a second Agent against the same city.
foreach ($process in @(Get-UtopiaRoomHubProcesses)) {
    Write-Output "Stopping unrecorded Room Hub pid $($process.ProcessId)."
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
foreach ($process in @(Get-UtopiaAgentProcesses)) {
    Write-Output "Stopping unrecorded reference node Agent pid $($process.ProcessId)."
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

$processes | Add-Member -NotePropertyName stoppedAt -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o') -Force
$processes | Add-Member -NotePropertyName state -NotePropertyValue 'STOPPED' -Force
$processes | ConvertTo-Json | Set-Content -LiteralPath $processesPath

foreach ($name in $result.Keys) { Write-Output "  $name : $($result[$name])" }
$leftover = @(Get-NetTCPConnection -LocalPort 4320 -State Listen -ErrorAction SilentlyContinue).Count
Write-Output "Utopia Host stopped. Remaining listeners on the room port: $leftover"
