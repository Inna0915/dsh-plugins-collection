#Requires -Version 7
<#
.SYNOPSIS
Safely remove a task's isolated git worktree(s) created by Invoke-CodexTask / Invoke-DshTask after changes are landed.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)][string]$Project,
    [Parameter(Mandatory)][ValidatePattern('^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,79}$')][string]$Task,
    [switch]$DeleteBranch,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'TaskWorktree.ps1')

if (-not [IO.Path]::IsPathFullyQualified($Project)) { throw "须为绝对路径：$Project" }
$Project = (Resolve-Path -LiteralPath $Project).Path
$branchName = "worker/$Task"
$removed = @()

$topRes = Invoke-GitCapture -RepoDir $Project -GitArgs @('rev-parse', '--show-toplevel')
if ($topRes.ExitCode -eq 0 -and $topRes.Stdout.Trim() -and (Test-Path -LiteralPath $topRes.Stdout.Trim())) {
    $repoRoot = (Resolve-Path -LiteralPath $topRes.Stdout.Trim()).Path
    $wtRoot = Join-Path (Split-Path -Parent $repoRoot) ".worktrees\$(Split-Path -Leaf $repoRoot)\$Task"
    if (Test-Path -LiteralPath $wtRoot) {
        $rmArgs = @('worktree', 'remove')
        if ($Force) { $rmArgs += '--force' }
        $rmArgs += $wtRoot
        $res = Invoke-GitCapture -RepoDir $repoRoot -GitArgs $rmArgs
        if ($res.ExitCode -ne 0) {
            throw "移除 Worktree 失败（可能仍有未合并/未提交修改，确认后可加 -Force）：$($res.Stderr.Trim())"
        }
        $null = Invoke-GitCapture -RepoDir $repoRoot -GitArgs @('worktree', 'prune')
        if ($DeleteBranch) {
            $delFlag = if ($Force) { '-D' } else { '-d' }
            $null = Invoke-GitCapture -RepoDir $repoRoot -GitArgs @('branch', $delFlag, $branchName)
        }
        $removed += $wtRoot
    }
} else {
    $wtUmbrella = Join-Path $Project "work\alpha\worktrees\$Task"
    if (Test-Path -LiteralPath $wtUmbrella) {
        $children = @(Get-ChildItem -LiteralPath $wtUmbrella -Directory -Force -ErrorAction SilentlyContinue)
        foreach ($c in $children) {
            $srcRepo = Join-Path $Project $c.Name
            if (Test-Path -LiteralPath (Join-Path $srcRepo '.git')) {
                $rmArgs = @('worktree', 'remove')
                if ($Force) { $rmArgs += '--force' }
                $rmArgs += $c.FullName
                $res = Invoke-GitCapture -RepoDir $srcRepo -GitArgs $rmArgs
                if ($res.ExitCode -ne 0) {
                    throw "移除子仓库 Worktree 失败（$($c.FullName)）：$($res.Stderr.Trim())"
                }
                $null = Invoke-GitCapture -RepoDir $srcRepo -GitArgs @('worktree', 'prune')
                if ($DeleteBranch) {
                    $delFlag = if ($Force) { '-D' } else { '-d' }
                    $null = Invoke-GitCapture -RepoDir $srcRepo -GitArgs @('branch', $delFlag, $branchName)
                }
                $removed += $c.FullName
            }
        }
        foreach ($docName in @('AGENTS.md', 'CLAUDE.md', '.editorconfig')) {
            $p = Join-Path $wtUmbrella $docName
            if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
        }
        $workResidual = Join-Path $wtUmbrella 'work'
        if ($Force -and (Test-Path -LiteralPath $workResidual)) {
            Remove-Item -LiteralPath $workResidual -Recurse -Force
        }
        if (@(Get-ChildItem -LiteralPath $wtUmbrella -Force -ErrorAction SilentlyContinue).Count -eq 0) {
            Remove-Item -LiteralPath $wtUmbrella -Force
        }
    }
}

[ordered]@{ project = $Project; task = $Task; removed = $removed } | ConvertTo-Json -Depth 4
