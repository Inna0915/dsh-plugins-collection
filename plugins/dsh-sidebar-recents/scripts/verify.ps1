$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
try {
  & "$PSScriptRoot/run-tests.ps1" -TimeoutSeconds 120
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & "$PSScriptRoot/run-build.ps1" -TimeoutSeconds 120
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & "$PSScriptRoot/run-check-dist.ps1" -TimeoutSeconds 60
  exit $LASTEXITCODE
} finally {
  Write-Output 'verify.ps1: all bounded steps completed'
}
