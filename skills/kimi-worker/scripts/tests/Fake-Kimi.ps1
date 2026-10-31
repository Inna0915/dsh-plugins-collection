#Requires -Version 7
$ErrorActionPreference = 'Stop'
$cliArgs = @($args)
$promptArgument = $cliArgs[[Array]::IndexOf($cliArgs, '--prompt') + 1]
if ($promptArgument -notmatch '交接文件：(.+?) 。') { throw 'Missing handoff file' }
$prompt = Get-Content -LiteralPath $Matches[1] -Raw -Encoding utf8
$markerRoot = Split-Path -Parent $Matches[1]
@{ arguments = $cliArgs; prompt = $prompt; cwd = (Get-Location).Path } | ConvertTo-Json -Depth 5 |
    Set-Content -LiteralPath (Join-Path $markerRoot 'fake-input.json') -Encoding utf8
$resumeIndex = [Array]::IndexOf($cliArgs, '--session')
$sessionId = if ($resumeIndex -ge 0) { $cliArgs[$resumeIndex + 1] } else { 'session_01234567-1234-1234-1234-123456789abc' }
@{ role = 'meta'; type = 'system.version'; version = '2.3.1-test' } | ConvertTo-Json -Compress
if ($prompt.Contains('TEST_CHILD')) {
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    foreach ($arg in @('-NoProfile', '-Command', 'Start-Sleep -Seconds 120')) { $start.ArgumentList.Add($arg) }
    $child = [Diagnostics.Process]::Start($start)
    @{ pid = $child.Id; startedAt = $child.StartTime.ToUniversalTime().ToString('o') } | ConvertTo-Json |
        Set-Content -LiteralPath (Join-Path $markerRoot 'fake-child.json') -Encoding utf8
    $child.Dispose()
}
if ($prompt.Contains('TEST_WAIT')) { Start-Sleep -Seconds 120 }
if ($prompt.Contains('TEST_FAIL')) { [Console]::Error.WriteLine('Simulated CLI failure'); exit 7 }
@{ role = 'assistant'; content = '模拟完成：中文交接正常。' } | ConvertTo-Json -Compress
if (-not $prompt.Contains('TEST_NO_END')) {
    @{ role = 'meta'; type = 'session.resume_hint'; session_id = $sessionId } | ConvertTo-Json -Compress
}
exit 0
