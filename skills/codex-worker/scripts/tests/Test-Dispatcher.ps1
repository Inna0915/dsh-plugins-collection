#Requires -Version 7
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ScratchRoot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$scriptRoot = Split-Path -Parent $PSScriptRoot
$dispatcher = Join-Path $scriptRoot 'Invoke-CodexTask.ps1'
$fixture = Join-Path $PSScriptRoot 'Fake-Codex.ps1'
$scratch = Join-Path (Resolve-Path -LiteralPath $ScratchRoot).Path ('.test-run-' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $scratch '中文 项目'
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$results = [Collections.Generic.List[object]]::new()
function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Start-TestRun([string]$Name, [string]$Prompt, [string[]]$ExtraArguments = @()) {
    $promptFile = Join-Path $project "$Name.md"
    Set-Content -LiteralPath $promptFile -Value $Prompt -NoNewline -Encoding utf8
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in (@('-NoLogo', '-NoProfile', '-File', $dispatcher, '-Task', $Name,
                '-Project', $project, '-PromptFile', $promptFile, '-CodexPath', $fixture,
                '-SkipGitRepoCheck') + $ExtraArguments)) {
        $start.ArgumentList.Add($argument)
    }
    $process = [Diagnostics.Process]::Start($start)
    $ownedProcesses.Add($process)
    return @{ Process = $process; Output = $process.StandardOutput.ReadToEndAsync()
        Error = $process.StandardError.ReadToEndAsync(); Name = $Name }
}
function Complete-TestRun($Run) {
    if (-not $Run.Process.WaitForExit(30000)) { throw "测试超时：$($Run.Name)" }
    if (-not $Run.Output.Wait(5000) -or -not $Run.Error.Wait(5000)) { throw 'Test output pipes did not close.' }
    $statusFile = Get-ChildItem -LiteralPath (Join-Path $project "work\alpha\logs\$($Run.Name)") -Filter '*.status.json' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $statusFile) { throw "没有状态文件：$($Run.Error.Result) $($Run.Output.Result)" }
    $status = Get-Content -LiteralPath $statusFile.FullName -Raw -Encoding utf8 | ConvertFrom-Json
    Assert-True ($Run.Process.ExitCode -eq $status.exitCode) 'Dispatcher exit code differs from status.'
    Assert-True $status.cleanupVerified "Owned processes were not cleaned: $($status | ConvertTo-Json -Compress -Depth 5)"
    return $status
}
function Read-FakeInput([string]$Name) {
    Get-Content -LiteralPath (Join-Path $project "work\alpha\logs\$Name\fake-input.json") -Raw -Encoding utf8 | ConvertFrom-Json
}
function Wait-ForChild([string]$Name) {
    $marker = Join-Path $project "work\alpha\logs\$Name\fake-child.json"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 15) {
        if (Test-Path -LiteralPath $marker) {
            try { return Get-Content -LiteralPath $marker -Raw -Encoding utf8 | ConvertFrom-Json } catch { }
        }
        Start-Sleep -Milliseconds 100
    }
    throw "Child process was not started: $Name"
}
function Assert-ChildStopped($Child) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $process = Get-Process -Id $Child.pid -ErrorAction SilentlyContinue
        if (-not $process -or $process.StartTime.ToUniversalTime().ToString('o') -ne $Child.startedAt) { return }
        Start-Sleep -Milliseconds 100
    } while ($timer.Elapsed.TotalSeconds -lt 5)
    throw "Child process still alive: $($Child.pid)"
}
try {
    New-Item -ItemType Directory -Path $project -Force | Out-Null
    $longPrompt = ('中文内容 $literal `markdown` ' * 1800) + ' TEST_CHILD'
    $run = Start-TestRun 'success' $longPrompt
    $status = Complete-TestRun $run
    Assert-True ($status.state -eq 'finished') "Success failed: $($status.error)"
    Assert-True ($status.sessionId -eq '01234567-1234-1234-1234-123456789abc') 'Session ID was not parsed.'
    Assert-True $status.turnCompleted 'Completed event was not parsed.'
    $input = Read-FakeInput 'success'
    Assert-True ($input.arguments -contains 'gpt-6.1-sol') 'Default model was not passed.'
    Assert-True ($input.arguments -contains 'model_reasoning_effort="max"') 'Default effort was not passed.'
    Assert-True ($input.arguments -contains '--dangerously-bypass-approvals-and-sandbox') 'Full access default was not explicit.'
    Assert-True ($input.prompt.EndsWith($longPrompt)) 'Long Unicode stdin prompt was corrupted.'
    Assert-True ($input.cwd -eq $project) 'Working directory was corrupted.'
    Assert-ChildStopped (Wait-ForChild 'success')
    $results.Add(@{ name = 'new_session_unicode_and_success_child_cleanup'; passed = $true })

    $run = Start-TestRun 'resume' '续接测试' @('-SessionId', $status.sessionId, '-Mode', 'read-only', '-Fast')
    $resumed = Complete-TestRun $run
    $input = Read-FakeInput 'resume'
    Assert-True ($resumed.sessionId -eq $status.sessionId) 'Wrong resumed session ID.'
    Assert-True ([Array]::IndexOf($input.arguments, '-C') -lt [Array]::IndexOf($input.arguments, 'resume')) 'Wrong resume argument order.'
    Assert-True ($input.arguments -contains 'model_reasoning_effort="max"') 'Resume lost effort setting.'
    Assert-True ($input.arguments -contains 'sandbox_mode="read-only"') 'Resume lost permission setting.'
    Assert-True ($input.arguments -contains 'features.fast_mode=true') 'Fast feature was not enabled.'
    Assert-True ([Array]::IndexOf($input.arguments, 'service_tier="fast"') -gt [Array]::IndexOf($input.arguments, 'resume')) 'Fast override was placed before resume.'
    $results.Add(@{ name = 'resume_explicit_id_model_effort_permissions'; passed = $true })

    $run = Start-TestRun 'failure' 'TEST_FAIL TEST_CHILD'
    $failed = Complete-TestRun $run
    Assert-True ($failed.exitCode -eq 7 -and $failed.state -eq 'failed') 'CLI failure was not propagated.'
    Assert-ChildStopped (Wait-ForChild 'failure')
    $results.Add(@{ name = 'failure_exit_code_and_child_cleanup'; passed = $true })

    $run = Start-TestRun 'timeout' 'TEST_WAIT TEST_CHILD' @('-TimeoutSeconds', '8')
    $child = Wait-ForChild 'timeout'
    $timedOut = Complete-TestRun $run
    Assert-True ($timedOut.exitCode -eq 124 -and $timedOut.state -eq 'timed_out') 'Timeout was not propagated.'
    Assert-ChildStopped $child
    $results.Add(@{ name = 'timeout_and_child_cleanup'; passed = $true })

    $run = Start-TestRun 'forced-stop' 'TEST_WAIT TEST_CHILD'
    $child = Wait-ForChild 'forced-stop'
    # Kill only the dispatcher, deliberately leaving cleanup to KILL_ON_JOB_CLOSE.
    $run.Process.Kill()
    $run.Process.WaitForExit(5000) | Out-Null
    Assert-ChildStopped $child
    Assert-True ($run.Output.Wait(5000) -and $run.Error.Wait(5000)) 'Forced stop left inherited pipes open.'
    $results.Add(@{ name = 'forced_dispatcher_stop_kills_job'; passed = $true })

    $lockId = '12345678-1234-1234-1234-123456789abc'
    $run = Start-TestRun 'locked-owner' 'TEST_WAIT TEST_CHILD' @('-SessionId', $lockId)
    $child = Wait-ForChild 'locked-owner'
    $contender = Start-TestRun 'locked-contender' 'must not run' @('-SessionId', $lockId)
    Assert-True ($contender.Process.WaitForExit(15000)) 'Session lock contender hung.'
    Assert-True ($contender.Process.ExitCode -ne 0) 'Concurrent resume was allowed.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $project 'work\alpha\logs\locked-contender\fake-input.json'))) 'Concurrent session started Codex.'
    $run.Process.Kill()
    $run.Process.WaitForExit(5000) | Out-Null
    Assert-ChildStopped $child
    $results.Add(@{ name = 'concurrent_resume_rejected'; passed = $true })

    $dry = Start-TestRun 'dry-run' 'TEST_WAIT' @('-DryRun')
    Assert-True ($dry.Process.WaitForExit(15000)) 'Dry-run hung.'
    Assert-True ($dry.Process.ExitCode -eq 0) 'Dry-run failed.'
    $dryConfig = $dry.Output.GetAwaiter().GetResult() | ConvertFrom-Json
    Assert-True ($dryConfig.model -eq 'gpt-6.1-sol' -and $dryConfig.effort -eq 'max') 'Dry-run defaults differ.'
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $project 'work\alpha\logs\dry-run'))) 'Dry-run created execution logs.'
    $results.Add(@{ name = 'dry_run_does_not_start_cli'; passed = $true })
} finally {
    foreach ($process in $ownedProcesses) {
        if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit(5000) | Out-Null }
        $process.Dispose()
    }
    # A failure in job handling must still not leave this test's known sleepers.
    if (Test-Path -LiteralPath $scratch) {
        foreach ($marker in Get-ChildItem -LiteralPath $scratch -Filter fake-child.json -File -Recurse) {
            $child = Get-Content -LiteralPath $marker.FullName -Raw -Encoding utf8 | ConvertFrom-Json
            $process = Get-Process -Id $child.pid -ErrorAction SilentlyContinue
            if ($process -and $process.StartTime.ToUniversalTime().ToString('o') -eq $child.startedAt) {
                $process.Kill($true); $process.WaitForExit(5000) | Out-Null
            }
            Assert-ChildStopped $child
        }
        $resolvedScratch = (Resolve-Path -LiteralPath $scratch).Path
        if (-not $resolvedScratch.StartsWith((Resolve-Path -LiteralPath $ScratchRoot).Path + '\.test-run-', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing cleanup outside the owned test directory.'
        }
        Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
    }
    [ordered]@{ verifiedAt = (Get-Date).ToString('o'); liveModelCalled = $false
        tests = @($results.ToArray()); scratchRemoved = (-not (Test-Path -LiteralPath $scratch)) } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $scriptRoot '../references/offline-verification.json') -Encoding utf8
}
$results | ConvertTo-Json -Depth 4
