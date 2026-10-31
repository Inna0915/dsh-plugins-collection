#Requires -Version 7
# Offline test double; never calls a model or reads authentication files.
$CliArgs = @($args)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$prompt = [Console]::In.ReadToEnd()
$finalIndex = [Array]::IndexOf($CliArgs, '-o')
$finalPath = $CliArgs[$finalIndex + 1]
$markerRoot = Split-Path -Parent $finalPath
@{ arguments = $CliArgs; prompt = $prompt; cwd = (Get-Location).Path } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $markerRoot 'fake-input.json') -Encoding utf8
$resumeIndex = [Array]::IndexOf($CliArgs, 'resume')
$threadId = if ($resumeIndex -ge 0) { $CliArgs[$resumeIndex + 1] } else { '01234567-1234-1234-1234-123456789abc' }
@{ type = 'thread.started'; thread_id = $threadId } | ConvertTo-Json -Compress
if ($prompt.Contains('TEST_CHILD')) {
    $start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    foreach ($argument in @('-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 120')) {
        $start.ArgumentList.Add($argument)
    }
    $child = [Diagnostics.Process]::Start($start)
    @{ pid = $child.Id; startedAt = $child.StartTime.ToUniversalTime().ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $markerRoot 'fake-child.json') -Encoding utf8
    $child.Dispose()
}
if ($prompt.Contains('TEST_WAIT')) { Start-Sleep -Seconds 120 }
if ($prompt.Contains('TEST_FAIL')) {
    [Console]::Error.WriteLine('Simulated CLI failure')
    exit 7
}
Set-Content -LiteralPath $finalPath -Value '模拟完成：中文路径和提示词正常。' -Encoding utf8
@{ type = 'turn.completed'; usage = @{ input_tokens = 0; output_tokens = 0 } } | ConvertTo-Json -Compress
exit 0
