#Requires -Version 7
<#
.SYNOPSIS
Delegate a task to Codex CLI, recording each run and cleaning up its process job.
.EXAMPLE
pwsh -File Invoke-CodexTask.ps1 -Task smoke -Project D:\repo -PromptFile D:\repo\task.md -Mode read-only
.EXAMPLE
pwsh -File Invoke-CodexTask.ps1 -Task fix -Project D:\repo -PromptFile D:\repo\fix.md -SessionId <UUID>
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,79}$')][string]$Task,
    [Parameter(Mandatory)][Alias('Cwd')][string]$Project,
    [Parameter(Mandatory)][string]$PromptFile,
    [string]$Dir,
    [ValidatePattern('^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')][string]$SessionId,
    [ValidateSet('read-only', 'workspace-write', 'auto', 'yolo', 'danger-full-access')][string]$Mode = 'yolo',
    [ValidateNotNullOrEmpty()][string]$Model = 'gpt-6.1-sol',
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max', 'ultra')][string]$Effort = 'max',
    [ValidateSet('default', 'fast', 'flex', 'ultrafast')][string]$ServiceTier = 'default',
    # Extra Codex -c overrides (key=value, TOML value), e.g. 'windows.sandbox="mxc"'; appended after mode settings.
    [ValidatePattern('^[A-Za-z0-9_.]+=.+$')][string[]]$ExtraConfig,
    [switch]$Fast,
    [ValidateRange(1, 86400)][int]$TimeoutSeconds = 1800,
    [string]$CodexPath,
    [switch]$SkipGitRepoCheck,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'This dispatcher requires Windows and PowerShell 7.' }
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($Mode -eq 'danger-full-access') { $Mode = 'yolo' }
if ($Fast) {
    if ($PSBoundParameters.ContainsKey('ServiceTier') -and $ServiceTier -ne 'fast') {
        throw '-Fast cannot be combined with a different -ServiceTier.'
    }
    $ServiceTier = 'fast'
}

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

# Use a native executable rather than depending on the npm shim's PATH order.
if (-not $CodexPath) {
    $command = Get-Command codex.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $CodexPath = $command.Source }
    if (-not $CodexPath) {
        $desktopBin = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
        if (Test-Path -LiteralPath $desktopBin) {
            $candidate = Get-ChildItem -LiteralPath $desktopBin -Filter codex.exe -File -Recurse |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if ($candidate) { $CodexPath = $candidate.FullName }
        }
    }
    if (-not $CodexPath) { throw '找不到 codex.exe。请通过 -CodexPath 指定 Codex 入口。' }
}
$CodexPath = (Resolve-Path -LiteralPath $CodexPath).Path
$extension = [IO.Path]::GetExtension($CodexPath)
if ($extension -notin @('.exe', '.ps1')) { throw 'CodexPath supports native .exe or PowerShell .ps1 launchers.' }
$pwshPath = Join-Path $PSHOME 'pwsh.exe'
$executable = $CodexPath
$prefixArguments = @()
if ($extension -eq '.ps1') {
    $executable = $pwshPath
    $prefixArguments = @('-NoLogo', '-NoProfile', '-File', $CodexPath)
}

$runId = 'codex-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6)
$logDir = Join-Path $Project "work\alpha\logs\$Task"
$tmpDir = Join-Path $Project "work\alpha\tmp\$Task"
$statusPath = Join-Path $logDir "$runId.status.json"
$eventsPath = Join-Path $logDir "$runId.events.jsonl"
$stderrPath = Join-Path $logDir "$runId.stderr.log"
$finalPath = Join-Path $logDir "$runId.final.md"
$savedPromptPath = Join-Path $logDir "$runId.prompt.md"
$workerStatusPath = Join-Path $logDir "$runId.worker.json"

$cliArguments = @('exec', '-C', $Project)
if ($SkipGitRepoCheck) { $cliArguments += '--skip-git-repo-check' }
# Put configuration on the actual exec/resume invocation, including resumed runs.
if ($SessionId) { $cliArguments += @('resume', $SessionId) }
# Resume has its own config overrides. Put the tier after resume, with the
# feature enabled explicitly; an exec-level wrapper alone is not sufficient.
$cliArguments += @('-c', "service_tier=`"$ServiceTier`"")
if ($ServiceTier -eq 'fast') { $cliArguments += @('-c', 'features.fast_mode=true') }
switch ($Mode) {
    'yolo' { $cliArguments += '--dangerously-bypass-approvals-and-sandbox' }
    'auto' {
        $cliArguments += @('-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"')
    }
    default {
        $cliArguments += @('-c', "sandbox_mode=`"$Mode`"", '-c', 'approval_policy="never"')
    }
}
foreach ($override in $ExtraConfig) { $cliArguments += @('-c', $override) }
$cliArguments += @('--model', $Model, '-c', "model_reasoning_effort=`"$Effort`"", '--json', '-o', $finalPath, '-')
$scope = if ($Dir) { $Dir } else { $Project }
$prompt = @"
【Claude Code → Codex 交接】任务：$Task
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
    [ordered]@{ cli = $CodexPath; cwd = $Project; model = $Model; effort = $Effort; mode = $Mode
        serviceTier = $ServiceTier; timeoutSeconds = $TimeoutSeconds; arguments = $cliArguments; promptFile = $PromptFile } | ConvertTo-Json -Depth 5
    exit 0
}

if (-not ('CodexDelegate.WindowsJob' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'WindowsJob.cs') }
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
    runId = $runId; task = $Task; cli = $CodexPath; cwd = $Project; dir = $Dir
    requestedModel = $Model; requestedEffort = $Effort; requestedMode = $Mode
    requestedServiceTier = $ServiceTier
    appliedSettings = $null; serviceTierVerified = $false; settingsVerificationError = $null
    requestedSessionId = $SessionId; sessionId = $null
    runnerPid = $PID; workerPid = $null; cliPid = $null
    timeoutSeconds = $TimeoutSeconds; startedAt = (Get-Date).ToString('o'); finishedAt = $null
    state = 'starting'; exitCode = $null; error = $null; turnCompleted = $false
    cleanupVerified = $false; cleanupRemainingPids = @()
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
            if ($event.type -eq 'thread.started' -and $event.thread_id) {
                if (-not $status.sessionId) { Write-Output "会话：$($event.thread_id)" }
                $status.sessionId = $event.thread_id
            }
            if ($event.type -eq 'turn.completed') { $status.turnCompleted = $true }
            if ($event.type -eq 'turn.failed') { $status.error = $event.error.message }
        }
    }
}

try {
    if ($SessionId) {
        $mutex = [Threading.Mutex]::new($false, "Local\CodexDelegate-$SessionId")
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw '此会话已有调度器正在执行，请等原调用结束后再续接。' }
    }
    New-Item -ItemType Directory -Force -Path $logDir, $tmpDir | Out-Null
    Set-Content -LiteralPath $savedPromptPath -Value $prompt -NoNewline -Encoding utf8
    Save-Status
    Write-Output "状态：$statusPath"
    Write-Output "进度：$eventsPath"
    Write-Output "模型：$Model / $Effort；服务档位：$ServiceTier；权限：$Mode；超时：$TimeoutSeconds 秒"
    $job = [CodexDelegate.WindowsJob]::new()
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
    foreach ($argument in @('-NoLogo', '-NoProfile', '-File', (Join-Path $PSScriptRoot 'CodexWorker.ps1'))) {
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
        cwd = $Project; prompt = $prompt; workerStatus = $workerStatusPath } | ConvertTo-Json -Depth 5 -Compress
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
        if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw [TimeoutException]::new("Codex 调用超过 $TimeoutSeconds 秒。") }
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
    if ($exitCode -eq 0 -and ($status.error -or -not (Test-Path -LiteralPath $finalPath))) {
        $exitCode = 1
        $status.state = 'failed'
        if (-not $status.error) { $status.error = 'CLI 已退出，但未生成最终报告。' }
    }
    if ($exitCode -ne 0 -and -not $status.error -and (Test-Path -LiteralPath $stderrPath)) {
        $status.error = (Get-Content -LiteralPath $stderrPath -Tail 12 -Encoding utf8) -join "`n"
    }
    $status.exitCode = $exitCode
    if ($status.sessionId) {
        try {
            $status.appliedSettings = & (Join-Path $PSScriptRoot 'Read-CodexAppliedSettings.ps1') -SessionId $status.sessionId -Since ([datetimeoffset]$status.startedAt)
            $expectedTier = if ($ServiceTier -eq 'fast') { 'priority' } else { $ServiceTier }
            $status.serviceTierVerified = $null -ne $status.appliedSettings -and $status.appliedSettings.serviceTier -eq $expectedTier
        } catch { $status.settingsVerificationError = $_.Exception.Message }
    }
    $status.finishedAt = (Get-Date).ToString('o')
    if (Test-Path -LiteralPath $savedPromptPath) { Save-Status }
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
if ($status.error) { Write-Output "错误：$($status.error)" }
Write-Output "结束：$($status.state)，exit=$exitCode；最终报告：$finalPath"
exit $exitCode
