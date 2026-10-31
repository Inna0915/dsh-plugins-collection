param([int]$TimeoutSeconds = 120)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& "$PSScriptRoot/run-bounded.ps1" -Executable node -CommandArgs @('tests/run-tests.js') -TimeoutSeconds $TimeoutSeconds -WorkingDirectory $root
exit $LASTEXITCODE
