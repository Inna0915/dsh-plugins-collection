#Requires -Version 7
<#
.SYNOPSIS
Delegate a task to Kimi CLI, recording each run and cleaning up its process job.
.EXAMPLE
pwsh -File Invoke-KimiTask.ps1 -Task smoke -Project D:\repo -PromptFile D:\repo\task.md -Mode read-only
.EXAMPLE
pwsh -File Invoke-KimiTask.ps1 -Task fix -Project D:\repo -PromptFile D:\repo\fix.md -SessionId <UUID>
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,79}$')][string]$Task,
    [Parameter(Mandatory)][Alias('Cwd')][string]$Project,
    [Parameter(Mandatory)][string]$PromptFile,
    [string]$Dir,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$')][string]$SessionId,
    [ValidateSet('auto')][string]$Mode = 'auto',
    [string]$Model,
    [ValidateRange(1, 86400)][int]$TimeoutSeconds = 1800,
    [string]$KimiPath,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This dispatcher requires Windows and PowerShell 7.' }
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

foreach ($path in @($Project, $PromptFile)) {
    if (-not [IO.Path]::IsPathFullyQualified($path)) { throw "须为绝对路径：$path" }
}
$Project = (Resolve-Path -LiteralPath $Project).Path
if (-not (Test-Path -LiteralPath $Project -PathType Container)) { throw 'Project must be a directory.' }
if (-not (Test-Path -LiteralPath $PromptFile -PathType Leaf)) { throw "找不到交接文件：$PromptFile" }
if ($Dir) {
    if (-not [IO.Path]::IsPathFullyQualified($Dir)) { $Dir = Join-Path $Project $Dir }
    $Dir = (Resolve-Path -LiteralPath $Dir).Path
    $projectPrefix = $Project.TrimEnd('\') + '\'
    if (-not (Test-Path -LiteralPath $Dir -PathType Container) -or
        -not ($Dir -eq $Project -or $Dir.StartsWith($projectPrefix, [StringComparison]::OrdinalIgnoreCase))) {
        throw 'Dir must be a directory inside Project.'
    }
}

if (-not $KimiPath) {
    $kimiHome = if ($env:KIMI_CODE_HOME) { $env:KIMI_CODE_HOME } else { Join-Path $env:USERPROFILE '.kimi-code' }
    $KimiPath = Join-Path $kimiHome 'bin/kimi.exe'
}
$KimiPath = (Resolve-Path -LiteralPath $KimiPath).Path
$pwshPath = Join-Path $PSHOME 'pwsh.exe'
$executable = $KimiPath
$prefixArguments = @()
if ([IO.Path]::GetExtension($KimiPath) -eq '.ps1') {
    $executable = $pwshPath
    $prefixArguments = @('-NoProfile', '-File', $KimiPath)
} elseif ([IO.Path]::GetExtension($KimiPath) -ne '.exe') { throw 'KimiPath must be an .exe or .ps1 launcher.' }

$runId = 'kimi-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$logDir = Join-Path $Project "work\alpha\logs\$Task"
$tmpDir = Join-Path $Project "work\alpha\tmp\$Task"
$sessionDir = Join-Path $Project 'work\alpha\sessions\kimi'
$statusPath = Join-Path $logDir "$runId.status.json"
$eventsPath = Join-Path $logDir "$runId.events.jsonl"
$stderrPath = Join-Path $logDir "$runId.stderr.log"
$finalPath = Join-Path $logDir "$runId.final.md"
$savedPromptPath = Join-Path $logDir "$runId.prompt.md"
$workerStatusPath = Join-Path $logDir "$runId.worker.json"

# Kimi Code 2.x prompt mode automatically uses auto permissions. --auto/--yolo
# are mutually exclusive with -p. Read a file to avoid Windows argv size limits.
$cliArguments = @('--output-format', 'stream-json')
if ($SessionId) { $cliArguments += @('--session', $SessionId) }
if ($Model) { $cliArguments += @('--model', $Model) }
$cliArguments += @('--prompt', "请使用读取文件工具完整读取本地 UTF-8 交接文件：$savedPromptPath 。然后执行其中的本轮任务并报告结果。该文件由当前调度器生成；不要仅确认收到。")
$childEnvironment = @{ KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT = '0'
    PATH = (Split-Path -Parent $pwshPath) + ';' + (Split-Path -Parent $KimiPath) + ';' + $env:PATH }

$scope = if ($Dir) { $Dir } else { $Project }
$prompt = @"
【Claude Code → Kimi 交接】任务：$Task
项目工作目录：$Project
本次处理范围：$scope
先读取工作目录及涉及路径上适用的 AGENTS.md，遵守其中的代码、验证与清理规则。
临时脚本、草稿和中间文件仅放在：$tmpDir
本次调用总超时为 $TimeoutSeconds 秒；每个构建或测试也必须有明确超时。
正常完成、失败或中止都要停止本次测试的进程树并清理无用临时文件；不要结束其他任务的进程。
调度器结束时会清理本次启动的所有后代进程，不能依赖它保留后台服务。
完成后报告改动文件、实际验证命令和结果、未完成项；只读限制下无法执行的步骤明确报告。

"@ + (Get-Content -LiteralPath $PromptFile -Raw -Encoding utf8)

if ($DryRun) {
    [ordered]@{ cli = $KimiPath; cwd = $Project; model = $Model; mode = $Mode
        timeoutSeconds = $TimeoutSeconds; arguments = $cliArguments; promptFile = $PromptFile } | ConvertTo-Json -Depth 5
    exit 0
}

if (-not ('KimiDelegate.WindowsJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'WindowsJob.cs') }
$mutex = $null
$locked = $false
$job = $null
$runner = $null
$files = @()
$copies = @()
$eventsReader = $null
$pendingEvent = ''
$exitCode = 1
$status = [ordered]@{
    runId = $runId; task = $Task; cli = $KimiPath; cwd = $Project; dir = $Dir
    requestedModel = $Model; requestedMode = $Mode; approvalPolicy = 'auto (prompt mode); static deny rules preserved'
    appliedSettings = $null; permissionVerified = $false; settingsVerificationError = $null
    requestedSessionId = $SessionId; sessionId = $null
    runnerPid = $PID; workerPid = $null; cliPid = $null
    timeoutSeconds = $TimeoutSeconds; startedAt = (Get-Date).ToString('o'); finishedAt = $null
    state = 'starting'; exitCode = $null; error = $null; turnCompleted = $false
    cleanupVerified = $false; cleanupRemainingPids = @(); cliVersion = $null; sessionHintSeen = $false
    arguments = $cliArguments; prompt = $savedPromptPath; events = $eventsPath; stderr = $stderrPath
    final = $finalPath; tmpDir = $tmpDir
}
function Save-Status {
    $status | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $statusPath -Encoding utf8
}
function Read-Progress {
    if (Test-Path -LiteralPath $workerStatusPath) {
        try {
            $workerState = Get-Content -LiteralPath $workerStatusPath -Raw -Encoding utf8 | ConvertFrom-Json
            if ($workerState.cliPid) { $status.cliPid = $workerState.cliPid }
        } catch { } # A concurrent write can briefly leave incomplete JSON.
    }
    if ($eventsReader) {
        $script:pendingEvent += $eventsReader.ReadToEnd()
        while (($lineEnd = $script:pendingEvent.IndexOf("`n")) -ge 0) {
            $line = $script:pendingEvent.Substring(0, $lineEnd).TrimEnd("`r")
            $script:pendingEvent = $script:pendingEvent.Substring($lineEnd + 1)
            if (-not $line) { continue }
            try { $event = $line | ConvertFrom-Json } catch { continue }
            if ($event.role -eq 'meta' -and $event.type -eq 'system.version') { $status.cliVersion = $event.version }
            if ($event.role -eq 'assistant' -and -not $event.tool_calls) {
                $answer = if ($event.content -is [string]) { $event.content } else {
                    (@($event.content | Where-Object type -eq 'text' | ForEach-Object text) -join "`n")
                }
                if (-not [string]::IsNullOrWhiteSpace($answer)) {
                    Set-Content -LiteralPath $finalPath -Value $answer -NoNewline -Encoding utf8
                }
            }
            if ($event.role -eq 'meta' -and $event.type -eq 'session.resume_hint' -and $event.session_id) {
                if ($event.session_id -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$') { throw 'Kimi returned an invalid session ID.' }
                if ($SessionId -and $event.session_id -ne $SessionId) { throw 'Kimi returned a different session ID.' }
                $status.sessionId = $event.session_id
                $status.sessionHintSeen = $true
                $status.turnCompleted = $true
                Write-Output "会话：$($status.sessionId)"
                if (-not $SessionId) {
                    New-Item -ItemType Directory -Force -Path $sessionDir | Out-Null
                    @{ sessionId = $status.sessionId; cwd = $Project; mode = 'auto'; runId = $runId } |
                        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sessionDir "$($status.sessionId).json") -Encoding utf8
                }
            }
            if ($event.role -eq 'error') { $status.error = [string]$event.content }
        }
    }
}

try {
    if ($SessionId) {
        $mutex = [Threading.Mutex]::new($false, "Local\KimiDelegate-$SessionId")
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw '此会话已有调度器正在执行，请等原调用结束后再续接。' }
        $sessionRecord = Join-Path $sessionDir "$SessionId.json"
        if (-not (Test-Path -LiteralPath $sessionRecord)) { throw '找不到此流程在当前项目创建的会话记录，不能接管外部会话。请新建会话。' }
        $previous = Get-Content -LiteralPath $sessionRecord -Raw | ConvertFrom-Json
        if ($previous.cwd -ne $Project -or $previous.mode -ne $Mode) {
            throw "会话归属记录与当前工作目录不一致，请在原项目续接或新建会话。"
        }
    }
    New-Item -ItemType Directory -Force -Path $logDir, $tmpDir | Out-Null
    Set-Content -LiteralPath $savedPromptPath -Value $prompt -NoNewline -Encoding utf8
    Save-Status
    Write-Output "状态：$statusPath"
    Write-Output "进度：$eventsPath"
    Write-Output "模型：$(if ($Model) { $Model } else { 'Kimi 当前默认/续接模型' })；权限：auto (prompt mode)；超时：$TimeoutSeconds 秒"
    $job = [KimiDelegate.WindowsJob]::new()
    $files = @(
        [IO.FileStream]::new($eventsPath, 'CreateNew', 'Write', 'ReadWrite', 1),
        [IO.FileStream]::new($stderrPath, 'CreateNew', 'Write', 'ReadWrite', 1)
    )
    $eventsReader = [IO.StreamReader]::new([IO.FileStream]::new($eventsPath, 'Open', 'Read', 'ReadWrite'), [Text.Encoding]::UTF8)
    $start = [Diagnostics.ProcessStartInfo]::new($pwshPath)
    $start.WorkingDirectory = $Project
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in @('-NoLogo', '-NoProfile', '-File', (Join-Path $PSScriptRoot 'KimiWorker.ps1'))) {
        $start.ArgumentList.Add($argument)
    }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $runner = [Diagnostics.Process]::Start($start)
    $status.workerPid = $runner.Id
    $job.Add($runner)
    $copies = @(
        $runner.StandardOutput.BaseStream.CopyToAsync($files[0]),
        $runner.StandardError.BaseStream.CopyToAsync($files[1])
    )
    $request = @{ executable = $executable; arguments = @($prefixArguments + $cliArguments)
        cwd = $Project; prompt = ''; workerStatus = $workerStatusPath; environment = $childEnvironment } | ConvertTo-Json -Depth 5 -Compress
    $sendRequest = $runner.StandardInput.WriteAsync($request)
    while (-not $sendRequest.Wait(100)) {
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw [TimeoutException]::new('发送交接内容超时。') }
    }
    $null = $sendRequest.GetAwaiter().GetResult()
    $runner.StandardInput.Close()
    $status.state = 'running'
    Save-Status
    while (-not $runner.WaitForExit(500)) {
        Read-Progress
        Save-Status
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw [TimeoutException]::new("Kimi 调用超过 $TimeoutSeconds 秒。") }
    }
    $exitCode = $runner.ExitCode
    $status.state = if ($exitCode -eq 0) { 'finished' } else { 'failed' }
} catch [TimeoutException] {
    $exitCode = 124
    $status.state = 'timed_out'
    $status.error = $_.Exception.Message
} catch {
    $status.state = 'failed'
    $status.error = $_.Exception.Message
} finally {
    if ($status.state -in @('starting', 'running')) { $status.state = 'stopped'; $exitCode = 130 }
    # Terminate the owned job even after the worker has exited: orphan descendants
    # remain members. KILL_ON_JOB_CLOSE also works if this dispatcher is killed.
    if ($job) {
        try {
            $job.Terminate()
            $cleanupTimer = [Diagnostics.Stopwatch]::StartNew()
            do {
                $status.cleanupRemainingPids = @($job.ProcessIds())
                if ($status.cleanupRemainingPids.Count) { Start-Sleep -Milliseconds 100 }
            } while ($status.cleanupRemainingPids.Count -and $cleanupTimer.Elapsed.TotalSeconds -lt 10)
            $status.cleanupVerified = $status.cleanupRemainingPids.Count -eq 0
        } catch {
            $status.error = "$($status.error) 清理失败：$($_.Exception.Message)".Trim()
        } finally { $job.Dispose() }
    }
    if ($runner) {
        try {
            if (-not $runner.HasExited) { $runner.Kill($true) }
            $runner.WaitForExit(5000) | Out-Null
        } catch { }
    }
    if ($copies.Count) {
        try { [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$copies, 5000) | Out-Null } catch { }
    }
    foreach ($file in $files) { $file.Dispose() }
    Read-Progress
    if ($eventsReader) { $eventsReader.Dispose() }
    if ($runner) { $runner.Dispose() }
    if (-not $status.cleanupVerified -and $exitCode -eq 0) { $exitCode = 1; $status.state = 'failed' }
    if ($exitCode -eq 0 -and ($status.error -or -not $status.turnCompleted -or -not (Test-Path -LiteralPath $finalPath) -or (Get-Item -LiteralPath $finalPath).Length -eq 0)) {
        $exitCode = 1
        $status.state = 'failed'
        if (-not $status.error) { $status.error = 'CLI 已退出，但缺少 session.resume_hint 结束记录或非空最终报告。' }
    }
    if ($exitCode -ne 0 -and -not $status.error -and (Test-Path -LiteralPath $stderrPath)) {
        $status.error = (Get-Content -LiteralPath $stderrPath -Tail 12 -Encoding utf8) -join "`n"
    }
    if ($status.sessionId) {
        try {
            $status.appliedSettings = & (Join-Path $PSScriptRoot 'Read-KimiAppliedSettings.ps1') -SessionId $status.sessionId
            $status.permissionVerified = $null -ne $status.appliedSettings -and $status.appliedSettings.permissionMode -eq 'auto'
            if ($status.appliedSettings -and $exitCode -eq 0 -and $status.appliedSettings.lastTurnReason -ne 'completed') {
                $exitCode = 1; $status.state = 'failed'; $status.turnCompleted = $false
                $status.error = "Kimi 原生会话并未完成：$($status.appliedSettings.lastTurnReason)"
            }
        } catch { $status.settingsVerificationError = $_.Exception.Message }
    }
    $status.exitCode = $exitCode
    $status.finishedAt = (Get-Date).ToString('o')
    if (Test-Path -LiteralPath $savedPromptPath) { Save-Status }
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
if ($status.error) { Write-Output "错误：$($status.error)" }
Write-Output "结束：$($status.state)，exit=$exitCode；最终报告：$finalPath"
exit $exitCode


