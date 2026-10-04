param([string]$BindAddress = '127.0.0.1', [int]$Port = 4310, [int]$RoomsPort = 4320, [switch]$DisableDiscovery, [switch]$DisableTelemetry, [switch]$NoRooms)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:CITY_MANAGE_SERVICES = '1'
$env:CITY_DISCOVERY_DISABLED = if ($DisableDiscovery) { '1' } else { '0' }
$env:CITY_TELEMETRY_DISABLED = if ($DisableTelemetry) { '1' } else { '0' }
$env:CITY_ROOMS_DISABLED = if ($NoRooms) { '1' } else { '0' }
$env:ROOMS_PORT = "$RoomsPort"
$env:CITY_HOST_ID = $env:COMPUTERNAME
# The Gateway owns all services in one process, protected by the host reservation.
# Repeated startup reuses the existing City without stopping it or creating more services.
$output = & node (Join-Path $PSScriptRoot 'utopia-client-launcher.mjs') --host-only --host $BindAddress --port $Port --no-open --json
if ($LASTEXITCODE -ne 0) { throw 'Utopia host startup failed.' }
$record = $output | ConvertFrom-Json
$runtime = Join-Path $root '.runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
@{gatewayPid=$record.gatewayPid; url=$record.endpoint; cityId=$record.cityId; dataDir=$record.dataDir} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'processes.json')
Write-Output "Utopia Host running at $($record.endpoint); City $($record.cityId); Gateway pid $($record.gatewayPid)"
