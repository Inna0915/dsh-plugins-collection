#Requires -Version 7
[CmdletBinding()]
param([string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'), [switch]$Disable)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$packageName = 'dsh-project-package'
$profileDir = Join-Path $DshHome 'profiles\desktop'
$manifestPath = Join-Path $profileDir 'package.json'
$installDir = Join-Path $DshHome "local-plugins\$packageName"
$linkPath = Join-Path $profileDir "node_modules\$packageName"
$records = Join-Path $root 'docs\installation'
$original = [IO.File]::ReadAllText($manifestPath)
$profile = $original | ConvertFrom-Json -AsHashtable
if ($profile.name -ne 'dsh-profile-desktop') { throw 'Unexpected Desktop profile' }
if (-not $profile.dsh.profile.bundles) { throw 'Missing bundle manifest' }
if ($Disable) {
  $profile.dsh.profile.bundles = @($profile.dsh.profile.bundles | Where-Object { $_ -ne $packageName })
} else {
  $source = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if ($source.name -ne $packageName) { throw 'Wrong source package' }
  foreach ($name in @('dist\plugin.js','dist\runtime.js','dist\client.js','dist\panel.js','runtime\PackageEngine.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)) { throw "Missing release file: $name" }
  }
  if (Test-Path -LiteralPath $installDir) {
    $existing = Get-Content -LiteralPath (Join-Path $installDir 'package.json') -Raw | ConvertFrom-Json
    if ($existing.name -ne $packageName) { throw 'Installation belongs to another package' }
  }
  if (Test-Path -LiteralPath $linkPath) {
    $link = Get-Item -LiteralPath $linkPath -Force
    if ($link.LinkType -notin @('Junction','SymbolicLink') -or [IO.Path]::GetFullPath([string]$link.Target) -ne [IO.Path]::GetFullPath($installDir)) { throw 'Existing dependency is not this managed installation' }
  }
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
  foreach ($relative in @('package.json','cordis.patch.yml','README.md','dist','engine','runtime','locale')) {
    Copy-Item -LiteralPath (Join-Path $root $relative) -Destination $installDir -Recurse -Force
  }
  if (-not (Test-Path -LiteralPath $linkPath)) { New-Item -ItemType Junction -Path $linkPath -Value $installDir | Out-Null }
  $profile.dependencies[$packageName] = 'link:' + $installDir.Replace('\','/')
  if ($packageName -notin $profile.dsh.profile.bundles) { $profile.dsh.profile.bundles = @($profile.dsh.profile.bundles) + $packageName }
}
New-Item -ItemType Directory -Path $records -Force | Out-Null
$backup = Join-Path $records ('desktop-package-before-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '.json')
[IO.File]::WriteAllText($backup,$original,[Text.UTF8Encoding]::new($false))
if ([IO.File]::ReadAllText($manifestPath) -cne $original) { throw 'Desktop manifest changed concurrently; no manifest update applied' }
$temporary = Join-Path $profileDir ('.project-package-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
  [IO.File]::WriteAllText($temporary,($profile | ConvertTo-Json -Depth 30) + "`n",[Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporary,$manifestPath,$true)
} finally {
  if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
[ordered]@{package=$packageName;version=$(if($Disable){$null}else{$source.version});enabled=(-not $Disable);installDir=$installDir;backup=$backup;installedAt=(Get-Date).ToString('o')} | ConvertTo-Json | Tee-Object -FilePath (Join-Path $records 'latest.json')
