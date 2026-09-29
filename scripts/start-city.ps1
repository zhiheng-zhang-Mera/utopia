param([string]$BindAddress = '127.0.0.1', [int]$Port = 4310)
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
$node = (Get-Command node).Source
$gateway = Start-Process -FilePath $node -ArgumentList 'services/dev-gateway/main.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'gateway.log') -RedirectStandardError (Join-Path $runtime 'gateway-error.log')
try {
    $healthy = $false
    for ($i=0; $i -lt 30; $i++) {
        try { $health = Invoke-RestMethod "$env:CITY_URL/api/v0/health"; if ($health.status -eq 'healthy') { $healthy = $true; break } } catch {}
        Start-Sleep -Milliseconds 200
    }
    if (!$healthy -or $gateway.HasExited) { throw 'Gateway did not start. Inspect .runtime/gateway-error.log.' }
    $agent = Start-Process -FilePath $node -ArgumentList 'agents/reference-node/main.mjs' -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'agent.log') -RedirectStandardError (Join-Path $runtime 'agent-error.log')
    @{ gatewayPid = $gateway.Id; agentPid = $agent.Id; url = $env:CITY_URL } | ConvertTo-Json | Set-Content (Join-Path $runtime 'processes.json')
    Write-Output "City running at $env:CITY_URL; private pairing token: .runtime/local-config.json (token)."
} catch { if (!$gateway.HasExited) { Stop-Process -Id $gateway.Id }; throw }
