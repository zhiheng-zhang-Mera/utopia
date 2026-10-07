[CmdletBinding()]
param(
 [ValidateSet('INSTALL','START','STOP','DRAIN','UNINSTALL','UPDATE','ROLLBACK','STANDARD_DEVICES')][string]$Action='INSTALL',
 [string]$CandidateDirectory,
 [string]$ConfigFile,
 [switch]$OptIn,
 [switch]$Apply
)
$ErrorActionPreference='Stop'
# Candidate metadata only. The existing launcher retains runtime authority.
if (-not $OptIn) { @{state='REFUSED';reason='EXPLICIT_OPT_IN_REQUIRED';automaticInstall=$false} | ConvertTo-Json; exit 0 }
if (-not $CandidateDirectory -or -not $ConfigFile) { throw 'CandidateDirectory and ConfigFile are required' }
$targetPath=[IO.Path]::GetFullPath($CandidateDirectory)
$configPath=[IO.Path]::GetFullPath($ConfigFile)
if ($targetPath.TrimEnd([IO.Path]::DirectorySeparatorChar) -eq 'D:\utopia') { throw 'RESIDENT_OR_ROOT_PATH_FORBIDDEN' }
if ($targetPath -eq [IO.Path]::GetPathRoot($targetPath) -or $targetPath.StartsWith('D:\utopia\', [StringComparison]::OrdinalIgnoreCase)) { throw 'RESIDENT_OR_ROOT_PATH_FORBIDDEN' }
function Assert-CandidatePath([string]$candidatePath) {
 $ancestorPath=$candidatePath
 while ($ancestorPath) {
  if (Test-Path -LiteralPath $ancestorPath) {
   $ancestorItem=Get-Item -LiteralPath $ancestorPath -Force
   if ($ancestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'REPARSE_POINT_FORBIDDEN' }
  }
  $parentPath=[IO.Path]::GetDirectoryName($ancestorPath.TrimEnd([IO.Path]::DirectorySeparatorChar))
  if (-not $parentPath -or $parentPath -eq $ancestorPath) { break }
  $ancestorPath=$parentPath
 }
}
Assert-CandidatePath $targetPath
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { throw 'CONFIG_MISSING' }
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($config.PSObject.Properties.Name | Where-Object { $_ -match 'token|password|secret|credentialValue' }) { throw 'CREDENTIAL_VALUE_FORBIDDEN' }
if (-not $config.version -or $config.schemaVersion -isnot [long] -and $config.schemaVersion -isnot [int] -or $null -eq $config.schemaVersion -or $config.port -lt 1024 -or $config.port -gt 65535 -or -not $config.credentialReference) { throw 'CONFIG_CORRUPT' }
if (-not $Apply) { @{state='PROPOSED';action=$Action;automaticInstall=$false;serviceInstalled=$false;autostart=$false;candidateDirectory=$targetPath} | ConvertTo-Json; exit 0 }
if ($Action -notin @('INSTALL','UNINSTALL','STANDARD_DEVICES')) { @{state='REFUSED';reason='RUNTIME_ADAPTER_REQUIRED';action=$Action} | ConvertTo-Json; exit 0 }
$manifestPath=Join-Path $targetPath 'pcf-candidate-manifest.json'
Assert-CandidatePath $manifestPath
if ($Action -eq 'INSTALL') {
 if (Test-Path -LiteralPath $manifestPath) { throw 'ALREADY_INSTALLED' }
 $null=New-Item -ItemType Directory -Path $targetPath -Force
 Assert-CandidatePath $manifestPath
 @{owner='PCF-716-CANDIDATE';version=$config.version;schemaVersion=$config.schemaVersion;port=$config.port;credentialReference=$config.credentialReference;profile='STANDARD_DEVICES';serviceInstalled=$false;autostart=$false;authority='EXISTING_WINDOWS_LAUNCHER'} | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8
} else {
 if (-not (Test-Path -LiteralPath $manifestPath)) { throw 'NOT_INSTALLED' }
 $manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
 if ($manifest.owner -ne 'PCF-716-CANDIDATE') { throw 'OWNERSHIP_REQUIRED' }
 if ($Action -eq 'UNINSTALL') { Remove-Item -LiteralPath $manifestPath } else { $manifest.profile='STANDARD_DEVICES';$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding utf8 }
}
@{state=if($Action -eq 'UNINSTALL'){'UNINSTALLED'}else{'CANDIDATE_METADATA_READY'};serviceInstalled=$false;autostart=$false;action=$Action} | ConvertTo-Json
