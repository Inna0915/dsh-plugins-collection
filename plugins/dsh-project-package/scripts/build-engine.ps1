#Requires -Version 7
param([string]$Python = 'C:\Users\OMEN\AppData\Local\Python\pythoncore-3.14-64\python.exe')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONIOENCODING = 'utf-8'
$buildTemporary = Join-Path $root ('.task-temp\engine-build-' + [guid]::NewGuid().ToString('N'))
$env:PYINSTALLER_CONFIG_DIR = Join-Path $buildTemporary 'cache'
$env:TEMP = Join-Path $buildTemporary 'temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
try {
  & "$PSScriptRoot\run-bounded.ps1" -Executable $Python -CommandArgs @('-B','-m','PyInstaller','--noconfirm','--clean','--onefile','--console','--name','PackageEngine','--paths','engine','--distpath','runtime','--workpath',(Join-Path $buildTemporary 'work'),'--specpath',$buildTemporary,'engine\worker.py') -WorkingDirectory $root -TimeoutSeconds 300
  $buildExitCode = $LASTEXITCODE
} finally {
  $resolvedTemporary = [IO.Path]::GetFullPath($buildTemporary)
  $temporaryRoot = [IO.Path]::GetFullPath((Join-Path $root '.task-temp')) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedTemporary.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected build cleanup target' }
  Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
}
exit $buildExitCode
