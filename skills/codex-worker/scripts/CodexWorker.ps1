#Requires -Version 7
# Internal worker: starts no child until the parent assigns it to a Windows job
# and sends a complete request over stdin. Invoke Invoke-CodexTask.ps1 instead.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = $null
$process = $null
$copies = @()
$exitCode = 1
try {
    $requestText = [Console]::In.ReadToEnd()
    if (-not $requestText) { throw 'No request received from the dispatcher.' }
    $request = $requestText | ConvertFrom-Json
    $start = [Diagnostics.ProcessStartInfo]::new($request.executable)
    $start.WorkingDirectory = $request.cwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($argument in $request.arguments) { $start.ArgumentList.Add([string]$argument) }
    $process = [Diagnostics.Process]::Start($start)
    @{ cliPid = $process.Id; exitCode = $null } | ConvertTo-Json |
        Set-Content -LiteralPath $request.workerStatus -Encoding utf8
    $copies = @(
        $process.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput()),
        $process.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
    )
    $process.StandardInput.Write($request.prompt)
    $process.StandardInput.Close()
    while (-not $process.WaitForExit(500)) { }
    $exitCode = $process.ExitCode
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
} finally {
    if ($process -and -not $process.HasExited) {
        try { $process.Kill($true); $process.WaitForExit(5000) | Out-Null } catch { }
    }
    if ($copies.Count) {
        try { [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$copies, 1500) | Out-Null } catch { }
    }
    if ($request) {
        @{ cliPid = $(if ($process) { $process.Id } else { $null }); exitCode = $exitCode } |
            ConvertTo-Json | Set-Content -LiteralPath $request.workerStatus -Encoding utf8
    }
    if ($process) { $process.Dispose() }
}
exit $exitCode
