# Stop only the currently reserved Utopia Gateway; all owned services share its process.
$ErrorActionPreference = 'Stop'
try { $record = Invoke-RestMethod 'http://127.0.0.1:4389/' -TimeoutSec 3 } catch { Write-Output 'No active host City.'; exit 0 }
if ($record.kind -ne 'utopia-city-host-v1') { throw 'Coordination port belongs to another application.' }
. (Join-Path $PSScriptRoot 'host-processes.ps1')
if (!(Test-UtopiaProcessArgument $record.gatewayPid 'services/dev-gateway/main.mjs')) { throw 'Gateway PID does not match the expected program; refusing to stop it.' }
Stop-Process -Id $record.gatewayPid -Force
Write-Output "Stopped host City $($record.cityId). Data retained at $($record.dataDir)."
