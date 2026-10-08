# Explicit restart preserves the host's canonical City and startup configuration.
$ErrorActionPreference = 'Stop'
$record = Invoke-RestMethod 'http://127.0.0.1:4389/' -TimeoutSec 3
if ($record.kind -ne 'utopia-city-host-v1') { throw 'Invalid host City reservation.' }
$uri = [uri]$record.endpoint
& (Join-Path $PSScriptRoot 'stop-city.ps1')
for ($i=0; $i -lt 40; $i++) {
    try { $null = Invoke-RestMethod 'http://127.0.0.1:4389/' -TimeoutSec 1 } catch { break }
    Start-Sleep -Milliseconds 100
}
# THE CAPABILITY SWITCHES ARE REPLAYED TOO. They live only in the environment, so a restart that dropped them brought
# the City up with the owner's remote-operation and agent-job decisions silently undone - the far side's requests would
# be refused as if nobody had turned them on. Recorded by main.mjs and replayed here as a pair; adding a switch in one
# place without the other is the defect this list exists to prevent.
foreach ($key in @('CITY_MANAGE_SERVICES','CITY_ROOMS_DISABLED','ROOMS_PORT','CITY_DISCOVERY_DISABLED','CITY_TELEMETRY_DISABLED',
  'CITY_REMOTE_OPERATION','CITY_REMOTE_OPERATION_ALLOWLIST','CITY_REMOTE_OPERATION_WORKSPACES','CITY_AGENT_JOB')) {
    [Environment]::SetEnvironmentVariable($key, [string]$record.startup.$key, 'Process')
}
& node (Join-Path $PSScriptRoot 'utopia-client-launcher.mjs') --host-only --host $uri.Host --port $uri.Port --no-open
if ($LASTEXITCODE -ne 0) { throw 'Gateway restart failed.' }
