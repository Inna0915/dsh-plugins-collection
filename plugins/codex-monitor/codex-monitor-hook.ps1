# Codex command hook adapter. The hook definition must set async=true.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Keep false normally; set true only while diagnosing Hook execution.
# $enableDebugLog = $true
$enableDebugLog = $false
$debugLogPath = 'C:\Users\y\Desktop\codex\codex-turn-stop.log'

$receivedAt = [DateTimeOffset]::Now.ToString('o')
$eventName = $null
$sessionId = $null
$refreshScope = 'default'
$refreshStatus = 'hook-received'
$refreshExitCode = $null
$errorMessage = $null

function Write-DebugLog {
    if (-not $enableDebugLog) {
        return
    }

    try {
        $logDirectory = Split-Path -Parent $debugLogPath
        $null = New-Item -ItemType Directory -Path $logDirectory -Force
        $record = [ordered]@{
            received_at      = $receivedAt
            source           = 'codex-monitor-hook'
            event            = $eventName
            session_id       = $sessionId
            refresh_scope    = $refreshScope
            status           = $refreshStatus
            refresh_exit_code = $refreshExitCode
            error            = $errorMessage
        }
        Add-Content -LiteralPath $debugLogPath -Value ($record | ConvertTo-Json -Compress) -Encoding utf8
    }
    catch {
        # Debug logging is best-effort and must never affect the Hook outcome.
    }
}

try {
    $inputText = [Console]::In.ReadToEnd()
    $event = $inputText | ConvertFrom-Json -ErrorAction Stop
    $eventName = [string]$event.hook_event_name
    if ($eventName -notin @('UserPromptSubmit', 'Stop')) {
        throw "Unsupported hook event: $eventName"
    }

    $sessionId = [string]$event.session_id

    # Hook events can arrive before the corresponding rollout fact is appended.
    if ($eventName -eq 'UserPromptSubmit') {
        Start-Sleep -Milliseconds 500
    }
    elseif ($eventName -eq 'Stop') {
        Start-Sleep -Seconds 5
    }

    $python = if ($env:CODEX_MONITOR_PYTHON) {
        $env:CODEX_MONITOR_PYTHON
    } else {
        (Get-Command python.exe -ErrorAction Stop).Source
    }
    $cli = Join-Path $PSScriptRoot 'codex_monitor.py'
    # Hook session_id is not a stable key for the private Codex threads index.
    # Let the monitor discover the current thread from its authoritative sources
    # instead of persisting an unmatched ID as an abnormal session card.
    $arguments = @($cli, '--timeout', '2', '--quiet', 'refresh')

    & $python @arguments *> $null
    $refreshExitCode = $LASTEXITCODE
    if ($refreshExitCode -eq 0) {
        $refreshStatus = 'refresh-request-accepted'
    }
    else {
        $refreshStatus = 'refresh-request-failed'
        $errorMessage = "CLI exited with code $refreshExitCode."
    }
}
catch {
    # Monitoring is best-effort and must never change the Codex hook outcome.
    $refreshStatus = 'hook-error'
    $errorMessage = $_.Exception.Message
}
finally {
    Write-DebugLog
}

[Console]::Out.Write('{}')
exit 0
