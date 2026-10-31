#Requires -Version 7
param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$')][string]$SessionId)
$ErrorActionPreference = 'Stop'
$kimiHome = if ($env:KIMI_CODE_HOME) { $env:KIMI_CODE_HOME } else { Join-Path $env:USERPROFILE '.kimi-code' }
$root = Join-Path $kimiHome 'sessions'
if (-not (Test-Path -LiteralPath $root)) { return }
$statePath = $null
foreach ($workspace in Get-ChildItem -LiteralPath $root -Directory) {
    $candidate = Join-Path $workspace.FullName "$SessionId/state.json"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $statePath = $candidate; break }
}
if (-not $statePath) { return }
$state = Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json
$wirePath = Join-Path (Split-Path -Parent $statePath) 'agents/main/wire.jsonl'
$result = [ordered]@{ cwd = $state.cwd; lastTurnReason = $state.lastTurnReason
    model = $null; effort = $null; permissionMode = $null; stateFile = $statePath; wireFile = $wirePath }
if (Test-Path -LiteralPath $wirePath) {
    $reader = [IO.StreamReader]::new([IO.FileStream]::new($wirePath, 'Open', 'Read', 'ReadWrite'), [Text.Encoding]::UTF8)
    try {
        while (($line = $reader.ReadLine()) -ne $null) {
            if (-not ($line.Contains('profile.bind') -or $line.Contains('permission.set_mode'))) { continue }
            try { $entry = $line | ConvertFrom-Json } catch { continue }
            if ($entry.type -eq 'profile.bind') { $result.model = $entry.modelAlias; $result.effort = $entry.thinkingEffort }
            if ($entry.type -eq 'permission.set_mode') { $result.permissionMode = $entry.mode }
        }
    } finally { $reader.Dispose() }
}
[pscustomobject]$result
