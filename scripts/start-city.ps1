param([string]$BindAddress = '127.0.0.1', [int]$Port = 4310, [int]$RoomsPort = 4320, [switch]$DisableDiscovery, [switch]$DisableTelemetry, [switch]$NoRooms)
# Utopia Host launcher.
#
# One supported startup brings up the whole product: the control Gateway, the reference
# node Agent, and — since the pre-assistant closeout (T1.1) — the Room Hub that owns the
# ten accepted local Rooms. The Room Hub stays loopback-only; the product reaches it
# through the authenticated Gateway path, never by exposing its port.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
$configPath = Join-Path $runtime 'local-config.json'
if (!(Test-Path -LiteralPath $configPath)) {
    $config = @{ token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)); nodeToken = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(24)) }
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath
}
$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$env:CITY_HOST = $BindAddress
$env:CITY_PORT = "$Port"
$env:CITY_URL = "http://${BindAddress}:$Port"
$env:CITY_TOKEN = $config.token
$env:CITY_NODE_TOKEN = $config.nodeToken
$env:CITY_DATA = $runtime
$env:CITY_WORKSPACE = Join-Path $runtime 'workspace'
$env:CITY_DISCOVERY_DISABLED = if ($DisableDiscovery) { '1' } else { '0' }
$env:CITY_TELEMETRY_DISABLED = if ($DisableTelemetry) { '1' } else { '0' }
$env:ROOMS_PORT = "$RoomsPort"
$env:CITY_ROOMS_URL = "http://127.0.0.1:$RoomsPort"
$env:CITY_HOST_ID = $env:COMPUTERNAME
$node = (Get-Command node).Source

# A restart must never leave a second Room Hub behind: stop any hub this launcher (or a
# previous one) started. The match is strict (see scripts/host-processes.ps1) so a process
# that merely mentions the path in its command text is never touched.
. (Join-Path $PSScriptRoot 'host-processes.ps1')

function Stop-StaleRoomHub {
    foreach ($process in @(Get-UtopiaRoomHubProcesses)) {
        Write-Output "Stopping stale Room Hub pid $($process.ProcessId)."
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# Recorded PIDs are not enough: an interrupted earlier launch can leave an Agent or a Room
# Hub that was never written down, and running two Agents against one city is exactly the
# duplicate the workbook forbids. Sweep by strict match as well as by record.
function Stop-StaleHostProcesses {
    Stop-StaleRoomHub
    foreach ($process in @(Get-UtopiaAgentProcesses)) {
        Write-Output "Stopping stale reference node Agent pid $($process.ProcessId)."
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

# Starting twice must be a restart, not a second copy. Without this the second Gateway
# cannot bind, silently dies, and the launcher still reports success because the *first*
# Gateway answers the health check — the worst possible outcome.
$processesPath = Join-Path $runtime 'processes.json'
$previous = Get-UtopiaRecordedHost $processesPath
if ($previous) {
    if (Stop-UtopiaRecordedProcess $previous.agentPid 'agents/reference-node/main.mjs') { Write-Output "Stopped the previous reference node Agent (pid $($previous.agentPid))." }
    if (Stop-UtopiaRecordedProcess $previous.gatewayPid 'services/dev-gateway/main.mjs') { Write-Output "Stopped the previous Gateway (pid $($previous.gatewayPid))." }
}
Stop-StaleHostProcesses
$occupied = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($occupied.Count -gt 0) {
    $holder = [int]$occupied[0].OwningProcess
    if (Test-UtopiaProcessArgument $holder 'services/dev-gateway/main.mjs') {
        # An unrecorded Gateway of our own (for example one left by an interrupted launch).
        Write-Output "Stopping an unrecorded Gateway on port $Port (pid $holder)."
        Stop-Process -Id $holder -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 400
    } else {
        throw "Port $Port is already in use by pid $holder, which is not a Utopia Gateway. Stop that process or pass a different -Port."
    }
}
$stillBusy = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
if ($stillBusy.Count -gt 0) {
    throw "Port $Port is still in use by pid $($stillBusy[0].OwningProcess) after cleanup; refusing to start a Gateway that cannot bind."
}

$gateway = Start-Process -FilePath $node -ArgumentList 'services/dev-gateway/main.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'gateway.log') -RedirectStandardError (Join-Path $runtime 'gateway-error.log')
try {
    # Readiness here means "the Gateway answered", not "everything is healthy": the Room Hub
    # is started below, so during this poll the health status is legitimately `degraded`.
    # The Hub gets its own readiness check afterwards.
    $healthy = $false
    for ($i=0; $i -lt 30; $i++) {
        try { $health = Invoke-RestMethod "$env:CITY_URL/api/v0/health"; if ($health.status) { $healthy = $true; break } } catch {}
        Start-Sleep -Milliseconds 200
    }
    if (!$healthy -or $gateway.HasExited) { throw 'Gateway did not start. Inspect .runtime/gateway-error.log.' }

    $agent = Start-Process -FilePath $node -ArgumentList 'agents/reference-node/main.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'agent.log') -RedirectStandardError (Join-Path $runtime 'agent-error.log')

    # Room Hub. A failure here is recorded as an UNAVAILABLE product state and reported
    # loudly; it is never silently treated as ready, and it does not stop the city from
    # running (the rest of the product is still usable and tells the truth about Rooms).
    $roomHubPid = $null
    $roomHubState = 'DISABLED'
    $roomHubReason = if ($NoRooms) { 'disabled by -NoRooms' } else { $null }
    $roomHubUrl = "http://127.0.0.1:$RoomsPort/"
    if (!$NoRooms) {
        $hub = Start-Process -FilePath $node -ArgumentList 'apps/rooms/hub/server.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'rooms.log') -RedirectStandardError (Join-Path $runtime 'rooms-error.log')
        $roomHubPid = $hub.Id
        $roomReady = $false
        for ($i=0; $i -lt 30; $i++) {
            try { $roomHealth = Invoke-RestMethod "${roomHubUrl}health"; if ($roomHealth.status -eq 'ok') { $roomReady = $true; break } } catch {}
            if ($hub.HasExited) { break }
            Start-Sleep -Milliseconds 200
        }
        if ($roomReady) {
            $roomHubState = 'READY'
        } else {
            $roomHubState = 'UNAVAILABLE'
            $roomHubReason = if ($hub.HasExited) { 'the Room Hub process exited during startup; inspect .runtime/rooms-error.log' } else { 'the Room Hub did not answer /health within 6 s' }
            Write-Warning "Room Hub UNAVAILABLE: $roomHubReason. Utopia will report Rooms as unavailable."
        }
    }

    @{
        gatewayPid = $gateway.Id
        agentPid = $agent.Id
        url = $env:CITY_URL
        roomsPid = $roomHubPid
        roomsUrl = if ($NoRooms) { $null } else { $roomHubUrl }
        roomsState = $roomHubState
        roomsReason = $roomHubReason
        startedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content (Join-Path $runtime 'processes.json')

    Write-Output "Utopia Host running at $env:CITY_URL"
    Write-Output "  gateway : pid $($gateway.Id)"
    Write-Output "  agent   : pid $($agent.Id)"
    Write-Output "  rooms   : $roomHubState$(if ($roomHubPid) { " (pid $roomHubPid, $roomHubUrl, loopback only)" })"
    Write-Output '  stop    : scripts/stop-city.ps1'
    Write-Output "Device Center shows reference-node telemetry and current mDNS/Bluetooth status. LAN DEVELOPMENT ONLY; NOT FOR PUBLIC INTERNET."
} catch {
    if (!$gateway.HasExited) { Stop-Process -Id $gateway.Id }
    throw
}
