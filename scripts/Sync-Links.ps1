<#
.SYNOPSIS
  检查或修正指向本仓库的 junction（映射见 links.json）。
.DESCRIPTION
  默认只检查。-Apply 时：缺失的创建，指向别处的 junction 改为指向本仓库。
  同名真实目录或文件一律报告为 conflict 并跳过，脚本不删除任何真实内容。
#>
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$repo = Split-Path $PSScriptRoot -Parent
$config = Get-Content (Join-Path $PSScriptRoot 'links.json') -Raw -Encoding utf8 | ConvertFrom-Json

function Resolve-LinkPath([string]$value) {
  if ($value -eq '~' -or $value.StartsWith('~/')) { $value = Join-Path $HOME $value.Substring(1).TrimStart('/') }
  elseif (-not [IO.Path]::IsPathRooted($value)) { $value = Join-Path $repo $value }
  [IO.Path]::GetFullPath($value).TrimEnd('\')
}

$pairs = [Collections.Generic.List[object]]::new()
foreach ($link in $config.links) { $pairs.Add([pscustomobject]@{ Path = $link.path; Target = $link.target }) }
foreach ($skill in $config.skills) {
  $roots = if ($skill.roots) { $skill.roots } else { $config.skillRoots }
  foreach ($root in $roots) { $pairs.Add([pscustomobject]@{ Path = "$root/$($skill.name)"; Target = $skill.target }) }
}

$failed = $false
$rows = foreach ($pair in $pairs) {
  $path = Resolve-LinkPath $pair.Path
  $target = Resolve-LinkPath $pair.Target
  $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  $status = if (-not (Test-Path -LiteralPath $target -PathType Container)) { 'target-missing' }
    elseif (-not $item) { 'missing' }
    elseif ($item.LinkType -in 'Junction', 'SymbolicLink') {
      $current = [IO.Path]::GetFullPath(@($item.Target)[0]).TrimEnd('\')
      if ($current -ieq $target) { 'ok' } else { "repoint (现指向 $current)" }
    }
    else { 'conflict' }

  if ($Apply -and ($status -eq 'missing' -or $status.StartsWith('repoint'))) {
    New-Item -ItemType Directory -Path (Split-Path $path -Parent) -Force | Out-Null
    # 非递归删除 junction 只移除链接本身，不触及目标内容。
    if ($item) { [IO.Directory]::Delete($path, $false) }
    New-Item -ItemType Junction -Path $path -Target $target | Out-Null
    $status = 'fixed'
  }
  if ($status -notin 'ok', 'fixed') { $failed = $true }
  [pscustomobject]@{ Status = $status; Path = $path; Target = $target }
}

$summary = ($rows | Group-Object { ($_.Status -split ' ')[0] } | ForEach-Object { "$($_.Name)=$($_.Count)" }) -join '  '
Write-Output "共 $($rows.Count) 项：$summary"
foreach ($row in $rows | Where-Object Status -ne 'ok' | Sort-Object Status, Path) {
  Write-Output "  [$($row.Status)] $($row.Path)`n      -> $($row.Target)"
}
if ($failed) {
  Write-Warning 'conflict 表示原位置仍是真实目录（尚未迁移或被占用）；target-missing 表示仓库内缺少目标。'
  exit 1
}
