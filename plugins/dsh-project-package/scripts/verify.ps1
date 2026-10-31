#Requires -Version 7
param([string]$Python = 'C:\Users\OMEN\AppData\Local\Python\pythoncore-3.14-64\python.exe')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot 'run-bounded.ps1'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'
& $runner -Executable node -CommandArgs @('scripts/build.mjs') -WorkingDirectory $root -TimeoutSeconds 120
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $runner -Executable node -CommandArgs @('--test','tests/client.test.mjs','tests/host.test.mjs') -WorkingDirectory $root -TimeoutSeconds 120
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $runner -Executable $Python -CommandArgs @('-B','tests/run_engine_tests.py') -WorkingDirectory $root -TimeoutSeconds 900
exit $LASTEXITCODE
