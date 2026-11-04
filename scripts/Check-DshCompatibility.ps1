#Requires -Version 7
[CmdletBinding()]
param([string]$DesktopDirectory = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness'))
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$previous = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  & (Join-Path $root 'plugins\dsh-project-package\scripts\run-bounded.ps1') `
    -Executable (Join-Path $DesktopDirectory 'DeepSeek Harness.exe') `
    -CommandArgs @('--expose-internals', 'scripts/check-dsh-compatibility.cjs', (Join-Path $DesktopDirectory 'resources\app.asar\dsh')) `
    -WorkingDirectory $root -TimeoutSeconds 30
  $result = $LASTEXITCODE
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previous
}
exit $result
