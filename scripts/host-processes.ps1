# Shared process discovery for the Utopia Host launcher and stopper.
#
# Why the matching is strict: a naive `CommandLine -like '*rooms/hub/server.mjs*'` also
# matches any process that merely *mentions* the path — an editor, a test runner, or a shell
# whose command text quotes the pattern. That is not a theoretical risk: two sweeps built on
# `-like` killed the very shell that was running them.
#
# So a process only counts when:
#   1. it is a node process,
#   2. the script path appears as a standalone argument (delimited by whitespace, a quote, a
#      path separator, or the ends of the line), and
#   3. it is neither this process nor one of its ancestors.
#
# Rule 3 matters because a harness may run the launcher from a node process whose command
# line embeds the launcher's own text, which would otherwise quote-match rule 2.

function Get-UtopiaProtectedProcessIds {
    $ids = [System.Collections.Generic.HashSet[int]]::new()
    [void]$ids.Add($PID)
    $current = $PID
    for ($depth = 0; $depth -lt 12; $depth++) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
        if (!$process -or !$process.ParentProcessId -or $process.ParentProcessId -eq 0) { break }
        $parent = [int]$process.ParentProcessId
        if (!$ids.Add($parent)) { break }
        $current = $parent
    }
    return $ids
}

$script:ProtectedProcessIds = Get-UtopiaProtectedProcessIds

function Get-UtopiaNodeProcesses {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { !$script:ProtectedProcessIds.Contains([int]$_.ProcessId) }
}

# Does this process's own command line carry the given relative script path as a standalone
# argument? This is the only matching rule used to decide that a process is ours.
function Test-UtopiaProcessArgument([int]$ProcessId, [string]$RelativePath) {
    if (!$ProcessId -or !$RelativePath) { return $false }
    if ($script:ProtectedProcessIds.Contains([int]$ProcessId)) { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if (!$process -or !$process.CommandLine) { return $false }
    $escaped = [regex]::Escape($RelativePath)
    return [regex]::IsMatch($process.CommandLine, '(^|[\s"''\\/])' + $escaped + '([\s"''\\/]|$)')
}

function Get-UtopiaRoomHubProcesses {
    Get-UtopiaNodeProcesses | Where-Object { Test-UtopiaProcessArgument $_.ProcessId 'apps/rooms/hub/server.mjs' }
}

function Get-UtopiaAgentProcesses {
    Get-UtopiaNodeProcesses | Where-Object { Test-UtopiaProcessArgument $_.ProcessId 'agents/reference-node/main.mjs' }
}

function Get-UtopiaGatewayProcesses {
    Get-UtopiaNodeProcesses | Where-Object { Test-UtopiaProcessArgument $_.ProcessId 'services/dev-gateway/main.mjs' }
}

function Test-UtopiaRoomHubProcess([int]$ProcessId) {
    return Test-UtopiaProcessArgument $ProcessId 'apps/rooms/hub/server.mjs'
}

# Stop one recorded process only when its own command line still proves what it is. Returns
# $true when it was actually stopped, $false when there was nothing safe to stop.
function Stop-UtopiaRecordedProcess([int]$ProcessId, [string]$RelativePath) {
    if (!(Test-UtopiaProcessArgument $ProcessId $RelativePath)) { return $false }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    return $true
}

# The recorded host description, or $null when there is none.
function Get-UtopiaRecordedHost([string]$ProcessesPath) {
    if (!(Test-Path -LiteralPath $ProcessesPath)) { return $null }
    return Get-Content -LiteralPath $ProcessesPath -Raw | ConvertFrom-Json
}
