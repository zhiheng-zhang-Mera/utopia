$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$processes = Get-Content (Join-Path $root '.runtime/processes.json') -Raw | ConvertFrom-Json
$pairingUrl = "$($processes.url)/pairing"
Write-Output "Pairing page: $pairingUrl"
Write-Output 'Sign in locally and generate a temporary QR/code. Never capture an active pairing QR or code in evidence.'
Start-Process $pairingUrl
