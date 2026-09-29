$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $root '.runtime'
$processes = Get-Content (Join-Path $runtime 'processes.json') -Raw | ConvertFrom-Json
$config = Get-Content (Join-Path $runtime 'local-config.json') -Raw | ConvertFrom-Json
$existing = Get-CimInstance Win32_Process -Filter "ProcessId=$($processes.gatewayPid)"
if ($existing -and $existing.CommandLine -notlike '*services/dev-gateway/main.mjs*') { throw 'Recorded PID is not the Gateway; refusing to stop it.' }
if ($existing) { Stop-Process -Id $processes.gatewayPid }
$uri = [uri]$processes.url
$env:CITY_HOST = $uri.Host
$env:CITY_PORT = "$($uri.Port)"
$env:CITY_DATA = $runtime
$env:CITY_TOKEN = $config.token
$env:CITY_NODE_TOKEN = $config.nodeToken
$gateway = Start-Process -FilePath (Get-Command node).Source -ArgumentList 'services/dev-gateway/main.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'gateway.log') -RedirectStandardError (Join-Path $runtime 'gateway-error.log')
$processes.gatewayPid = $gateway.Id
$processes | ConvertTo-Json | Set-Content (Join-Path $runtime 'processes.json')
Write-Output "Gateway restarted at $($processes.url)"
