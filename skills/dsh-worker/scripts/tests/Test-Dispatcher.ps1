#Requires -Version 7
param([Parameter(Mandatory)][string]$ScratchRoot)
$ErrorActionPreference = 'Stop'
$scripts = Split-Path -Parent $PSScriptRoot
$scratch = Join-Path (Resolve-Path -LiteralPath $ScratchRoot).Path ('offline-' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $scratch '中文 项目'
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()
$results = [Collections.Generic.List[object]]::new()
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Start-Run([string]$Name, [string]$Prompt, [string[]]$Extra = @()) {
    $file = Join-Path $project "$Name.md"
    Set-Content -LiteralPath $file -Value $Prompt -NoNewline -Encoding utf8
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($arg in (@('-NoProfile', '-File', (Join-Path $scripts 'Invoke-DshTask.ps1'),
        '-Task', $Name, '-Project', $project, '-PromptFile', $file,
        '-DshEntry', (Join-Path $PSScriptRoot 'Fake-Dsh.mjs'), '-TimeoutSeconds', '20') + $Extra)) {
        $start.ArgumentList.Add($arg)
    }
    $process = [Diagnostics.Process]::Start($start)
    $owned.Add($process)
    return @{ Process = $process; Output = $process.StandardOutput.ReadToEndAsync(); Error = $process.StandardError.ReadToEndAsync(); Name = $Name }
}
function Complete($Run) {
    Assert ($Run.Process.WaitForExit(30000)) "Test timeout: $($Run.Name)"
    Assert ($Run.Output.Wait(5000) -and $Run.Error.Wait(5000)) 'Output pipes still open'
    $file = Get-ChildItem -LiteralPath (Join-Path $project "work/alpha/logs/$($Run.Name)") -Filter '*.status.json' | Select-Object -First 1
    Assert ($null -ne $file) "Missing status: $($Run.Error.Result)"
    $status = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
    Assert ($status.exitCode -eq $Run.Process.ExitCode) 'Wrong exit code'
    Assert $status.cleanupVerified 'Process cleanup failed'
    Assert $status.overlayRemoved 'Overlay cleanup failed'
    return $status
}
function Input-For([string]$Name) { Get-Content -LiteralPath (Join-Path $project "work/alpha/logs/$Name/fake-input.json") -Raw | ConvertFrom-Json }
function Child-For([string]$Name) {
    $marker = Join-Path $project "work/alpha/logs/$Name/fake-child.json"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ($timer.Elapsed.TotalSeconds -lt 10) {
        if (Test-Path -LiteralPath $marker) { return (Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).pid }
        Start-Sleep -Milliseconds 100
    }
    throw "Missing child: $Name"
}
function Assert-Stopped([int]$ChildPid) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (Get-Process -Id $ChildPid -ErrorAction SilentlyContinue) {
        Assert ($timer.Elapsed.TotalSeconds -lt 5) "Owned child still running: $ChildPid"
        Start-Sleep -Milliseconds 100
    }
}
try {
    New-Item -ItemType Directory -Path $project -Force | Out-Null
    $prompt = ('中文内容 $literal `markdown` ' * 1800) + ' TEST_CHILD'
    $status = Complete (Start-Run 'success' $prompt)
    $input = Input-For 'success'
    Assert ($status.state -eq 'finished' -and $status.turnCompleted) 'Success not recognized'
    Assert ($input.prompt.EndsWith($prompt)) 'Unicode stdin corrupted'
    Assert ($input.mode -eq 'danger-full-access') 'Wrong default permission'
    Assert (($input.patch | Where-Object id -eq 'approval').config.policy -eq 'never') 'Approval not disabled'
    Assert (($input.patch | Where-Object id -eq 'agent-default-model').config.reasoningEffort -eq 'max') 'Wrong default effort'
    Assert-Stopped (Child-For 'success')
    $results.Add(@{ name='unicode_defaults_and_success_cleanup'; passed=$true })

    $initialSession = $status.sessionId
    $resumed = Complete (Start-Run 'resume' '续接' @('-SessionId',$initialSession,'-Effort','high','-Model','deepseek/deepseek-flash'))
    $input = Input-For 'resume'
    Assert ($resumed.sessionId -eq $status.sessionId) 'Resume ID changed'
    $selection = ($input.patch | Where-Object id -eq 'agent-default-model').config
    Assert ($selection.model -eq 'deepseek/deepseek-flash' -and $selection.reasoningEffort -eq 'high') 'Override lost'
    $mismatch = Start-Run 'mode-mismatch' 'must not run' @('-SessionId',$initialSession,'-Mode','read-only')
    Assert ($mismatch.Process.WaitForExit(10000) -and $mismatch.Process.ExitCode -ne 0) 'Permission mismatch was accepted'
    $results.Add(@{ name='resume_model_effort_override_and_permission_mismatch_rejection'; passed=$true })

    $status = Complete (Start-Run 'failure' 'TEST_FAIL TEST_CHILD')
    Assert ($status.exitCode -eq 7 -and $status.state -eq 'failed') 'Failure masked'
    Assert-Stopped (Child-For 'failure')
    $results.Add(@{ name='failure_exit_and_cleanup'; passed=$true })

    $status = Complete (Start-Run 'incomplete' 'TEST_NO_COMPLETED')
    Assert ($status.exitCode -ne 0) 'Accepted false success'
    $results.Add(@{ name='reject_exit_zero_without_completed'; passed=$true })

    $status = Complete (Start-Run 'timeout' 'TEST_WAIT TEST_CHILD')
    Assert ($status.exitCode -eq 124) 'Timeout not enforced'
    Assert-Stopped (Child-For 'timeout')
    $results.Add(@{ name='timeout_tree_and_overlay_cleanup'; passed=$true })

    $run = Start-Run 'cancel' 'TEST_WAIT TEST_CHILD' @('-SessionId',$initialSession)
    $child = Child-For 'cancel'
    $duplicate = Start-Run 'duplicate' 'must not run' @('-SessionId',$initialSession)
    Assert ($duplicate.Process.WaitForExit(10000)) 'Lock contention did not fail promptly'
    Assert ($duplicate.Process.ExitCode -ne 0) 'Concurrent session was allowed'
    $run.Process.Kill() # deliberately kill just the parent: the job must own descendants
    Assert ($run.Process.WaitForExit(5000)) 'Cancelled dispatcher still running'
    Assert-Stopped $child
    $results.Add(@{ name='same_session_mutex_and_forced_parent_exit_cleanup'; passed=$true })

    $status = Complete (Start-Run 'bad-model' 'must not run' @('-Model','not-configured'))
    Assert ($status.exitCode -ne 0 -and -not $status.sessionId) 'Invalid model silently replaced'
    $results.Add(@{ name='invalid_model_fails_before_execution'; passed=$true })
    $results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $scripts '../references/offline-verification.json') -Encoding utf8
    $results | ConvertTo-Json
} finally {
    foreach ($process in $owned) {
        if (-not $process.HasExited) { $process.Kill($true); $process.WaitForExit(5000) | Out-Null }
        $process.Dispose()
    }
    $resolved = [IO.Path]::GetFullPath($scratch)
    $prefix = (Resolve-Path -LiteralPath $ScratchRoot).Path.TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup target' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
