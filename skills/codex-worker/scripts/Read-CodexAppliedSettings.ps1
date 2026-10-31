#Requires -Version 7
param(
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$SessionId,
    [Parameter(Mandatory)][datetimeoffset]$Since
)
$ErrorActionPreference = 'Stop'
$codexHomePath = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$sessionsPath = Join-Path $codexHomePath 'sessions'
if (-not (Test-Path -LiteralPath $sessionsPath)) { return }
$file = Get-ChildItem -LiteralPath $sessionsPath -Filter "*$SessionId.jsonl" -File -Recurse |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $file) { return }
$reader = [IO.StreamReader]::new([IO.FileStream]::new($file.FullName, 'Open', 'Read', 'ReadWrite'), [Text.Encoding]::UTF8)
$latest = $null
$lineNumber = 0
try {
    while (($line = $reader.ReadLine()) -ne $null) {
        $lineNumber++
        if (-not $line.Contains('thread_settings_applied')) { continue }
        try { $entry = $line | ConvertFrom-Json } catch { continue }
        if ($entry.payload.type -ne 'thread_settings_applied' -or [datetimeoffset]$entry.timestamp -lt $Since) { continue }
        $settings = $entry.payload.thread_settings
        $latest = [ordered]@{ timestamp = $entry.timestamp; model = $settings.model
            effort = $settings.reasoning_effort; serviceTier = $settings.service_tier
            permissionProfile = $settings.permission_profile; approvalPolicy = $settings.approval_policy
            source = $file.FullName; line = $lineNumber }
    }
} finally { $reader.Dispose() }
if ($latest) { [pscustomobject]$latest }
