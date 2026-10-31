#Requires -Version 7
[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [switch]$Disable
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$packageName = 'dsh-sidebar-recents'
$profileDir = Join-Path $DshHome 'profiles\desktop'
$manifestPath = Join-Path $profileDir 'package.json'
$installDir = Join-Path $DshHome "local-plugins\$packageName"
$linkPath = Join-Path $profileDir "node_modules\$packageName"
$recordDir = Join-Path $projectRoot 'docs\installation'
$original = [IO.File]::ReadAllText($manifestPath)
$profile = $original | ConvertFrom-Json -AsHashtable
if ($profile.name -ne 'dsh-profile-desktop') { throw 'Unexpected Desktop profile.' }
if (-not $profile.dsh.profile.bundles) { throw 'Missing Desktop bundle manifest.' }

if ($Disable) {
  $profile.dsh.profile.bundles = @($profile.dsh.profile.bundles | Where-Object { $_ -ne $packageName })
} else {
  $sourcePackage = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
  if ($sourcePackage.name -ne $packageName) { throw 'Unexpected source package.' }
  $files = @('package.json', 'cordis.patch.yml', 'dist\plugin.js', 'dist\client.js', 'README.md', 'locale\en.json', 'locale\zh.json', 'docs\feasibility.md', 'docs\implementation-report.md')
  foreach ($relative in $files) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relative) -PathType Leaf)) {
      throw "Missing release file: $relative"
    }
  }
  if (Test-Path -LiteralPath $installDir) {
    $installedPackage = Get-Content -LiteralPath (Join-Path $installDir 'package.json') -Raw | ConvertFrom-Json
    if ($installedPackage.name -ne $packageName) { throw 'Installation folder belongs to another package.' }
  }
  if (Test-Path -LiteralPath $linkPath) {
    $existingLink = Get-Item -LiteralPath $linkPath -Force
    if ($existingLink.LinkType -notin @('Junction', 'SymbolicLink') -or
        [IO.Path]::GetFullPath([string]$existingLink.Target) -ne [IO.Path]::GetFullPath($installDir)) {
      throw 'Existing dependency is not this managed local installation.'
    }
  }
  foreach ($relative in $files) {
    $destination = Join-Path $installDir $relative
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination $destination -Force
  }
  if (-not (Test-Path -LiteralPath $linkPath)) {
    New-Item -ItemType Junction -Path $linkPath -Value $installDir | Out-Null
  }
  $profile.dependencies[$packageName] = 'link:' + $installDir.Replace('\', '/')
  if ($packageName -notin $profile.dsh.profile.bundles) {
    $profile.dsh.profile.bundles = @($profile.dsh.profile.bundles) + $packageName
  }
}

[IO.Directory]::CreateDirectory($recordDir) | Out-Null
$backup = Join-Path $recordDir ('desktop-package-before-' + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '.json')
[IO.File]::WriteAllText($backup, $original, [Text.UTF8Encoding]::new($false))
if ([IO.File]::ReadAllText($manifestPath) -cne $original) {
  throw 'Desktop manifest changed during preparation; no manifest update was applied.'
}
$temporaryManifest = Join-Path $profileDir ('.sidebar-recents-' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
  [IO.File]::WriteAllText($temporaryManifest, ($profile | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::Move($temporaryManifest, $manifestPath, $true)
} finally {
  if (Test-Path -LiteralPath $temporaryManifest) { Remove-Item -LiteralPath $temporaryManifest }
}
[ordered]@{
  package = $packageName
  version = $(if ($Disable) { $null } else { $sourcePackage.version })
  enabled = -not $Disable
  installDir = $installDir
  profile = $manifestPath
  backup = $backup
  installedAt = (Get-Date).ToString('o')
  method = 'local package copy, directory junction, atomic bundle manifest update; no host restart'
} | ConvertTo-Json | Tee-Object -FilePath (Join-Path $recordDir 'latest.json')
