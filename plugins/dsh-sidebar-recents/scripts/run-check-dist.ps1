param([int]$TimeoutSeconds = 60)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& "$PSScriptRoot/run-bounded.ps1" -Executable node -CommandArgs @('scripts/check-dist.mjs') -TimeoutSeconds $TimeoutSeconds -WorkingDirectory $root
exit $LASTEXITCODE
