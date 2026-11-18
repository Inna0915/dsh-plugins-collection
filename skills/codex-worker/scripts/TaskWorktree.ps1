#Requires -Version 7

function Invoke-GitCapture {
    param(
        [Parameter(Mandatory)][string]$RepoDir,
        [Parameter(Mandatory)][string[]]$GitArgs
    )
    $psi = [Diagnostics.ProcessStartInfo]::new('git')
    $psi.WorkingDirectory = $RepoDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $psi.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    foreach ($a in @('-C', $RepoDir) + $GitArgs) {
        $psi.ArgumentList.Add($a)
    }
    $proc = [Diagnostics.Process]::Start($psi)
    try {
        $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
        $stderrTask = $proc.StandardError.ReadToEndAsync()
        if (-not $proc.WaitForExit(30000)) {
            $proc.Kill($true)
            throw "git command timed out in ${RepoDir}: git $($GitArgs -join ' ')"
        }
        [Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask), 5000) | Out-Null
        return [pscustomobject]@{
            ExitCode = $proc.ExitCode
            Stdout   = $stdoutTask.Result
            Stderr   = $stderrTask.Result
        }
    } finally {
        $proc.Dispose()
    }
}

function Get-PathHashSuffix {
    param([Parameter(Mandatory)][string]$PathText)
    $bytes = [Text.Encoding]::UTF8.GetBytes($PathText.ToLowerInvariant())
    $hash = [Security.Cryptography.SHA256]::HashData($bytes)
    return ([Convert]::ToHexString($hash)).Substring(0, 16)
}

function Ensure-SingleRepoWorktree {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string]$WorktreePath,
        [Parameter(Mandatory)][string]$BranchName
    )
    $mutexName = 'Local\WorkerGitWt-' + (Get-PathHashSuffix -PathText $RepoRoot)
    $mutex = [Threading.Mutex]::new($false, $mutexName)
    $acquired = $false
    try {
        try {
            $acquired = $mutex.WaitOne(30000)
        } catch [Threading.AbandonedMutexException] {
            $acquired = $true
        }
        if (-not $acquired) {
            throw "等待仓库 Worktree 锁超时：$RepoRoot"
        }

        $null = Invoke-GitCapture -RepoDir $RepoRoot -GitArgs @('worktree', 'prune')
        $headRes = Invoke-GitCapture -RepoDir $RepoRoot -GitArgs @('rev-parse', 'HEAD')
        if ($headRes.ExitCode -ne 0) {
            throw "无法读取仓库 HEAD（$RepoRoot）：$($headRes.Stderr.Trim())"
        }
        $baseHead = $headRes.Stdout.Trim()

        $dotGitPath = Join-Path $WorktreePath '.git'
        if (Test-Path -LiteralPath $dotGitPath) {
            $curBranchRes = Invoke-GitCapture -RepoDir $WorktreePath -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
            $curBranch = if ($curBranchRes.ExitCode -eq 0) { $curBranchRes.Stdout.Trim() } else { $BranchName }
            return [ordered]@{
                repo     = $RepoRoot
                worktree = (Resolve-Path -LiteralPath $WorktreePath).Path
                branch   = $curBranch
                baseHead = $baseHead
                reused   = $true
            }
        }

        if ((Test-Path -LiteralPath $WorktreePath) -and @(Get-ChildItem -LiteralPath $WorktreePath -Force -ErrorAction SilentlyContinue).Count -gt 0) {
            throw "目标 Worktree 路径已存在非空非 Git 目录，拒绝覆盖：$WorktreePath"
        }

        $wtParent = Split-Path -Parent $WorktreePath
        New-Item -ItemType Directory -Force -Path $wtParent | Out-Null

        $refCheck = Invoke-GitCapture -RepoDir $RepoRoot -GitArgs @('show-ref', '--verify', '--quiet', "refs/heads/$BranchName")
        $effectiveBranch = $BranchName
        if ($refCheck.ExitCode -ne 0) {
            $addRes = Invoke-GitCapture -RepoDir $RepoRoot -GitArgs @('worktree', 'add', '-b', $BranchName, $WorktreePath, 'HEAD')
            if ($addRes.ExitCode -ne 0) {
                throw "创建 Git Worktree 失败（$RepoRoot -> $WorktreePath）：$($addRes.Stderr.Trim())"
            }
        } else {
            $addRes = Invoke-GitCapture -RepoDir $RepoRoot -GitArgs @('worktree', 'add', $WorktreePath, $BranchName)
            if ($addRes.ExitCode -ne 0) {
                $detachRes = Invoke-GitCapture -RepoDir $RepoRoot -GitArgs @('worktree', 'add', '--detach', $WorktreePath, 'HEAD')
                if ($detachRes.ExitCode -ne 0) {
                    throw "创建 Git Worktree 失败（$RepoRoot -> $WorktreePath）：$($detachRes.Stderr.Trim())"
                }
                $effectiveBranch = 'HEAD (detached)'
            }
        }

        return [ordered]@{
            repo     = $RepoRoot
            worktree = (Resolve-Path -LiteralPath $WorktreePath).Path
            branch   = $effectiveBranch
            baseHead = $baseHead
            reused   = $false
        }
    } finally {
        if ($acquired) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}

function Resolve-WorkerWorkspace {
    param(
        [Parameter(Mandatory)][string]$Project,
        [string]$Dir,
        [Parameter(Mandatory)][string]$Task,
        [Parameter(Mandatory)][string]$Mode,
        [ValidateSet('auto', 'required', 'off')][string]$WorktreeMode = 'auto',
        [string]$PreviousCwd,
        [switch]$DryRun
    )

    function Map-SubDir([string]$BaseFrom, [string]$BaseTo, [string]$SubPath) {
        if (-not $SubPath) { return '' }
        $rel = [IO.Path]::GetRelativePath($BaseFrom, $SubPath)
        if ($rel -eq '.') { return $BaseTo }
        return Join-Path $BaseTo $rel
    }

    if ($PreviousCwd -and (Test-Path -LiteralPath $PreviousCwd -PathType Container)) {
        $resolvedPrev = (Resolve-Path -LiteralPath $PreviousCwd).Path
        $isIsolated = -not [string]::Equals($resolvedPrev, $Project, [StringComparison]::OrdinalIgnoreCase)
        return [ordered]@{
            used             = $isIsolated
            topology         = if ($isIsolated) { 'resumed-worktree' } else { 'in-place' }
            reason           = 'session-resume'
            sourceProject    = $Project
            effectiveProject = $resolvedPrev
            effectiveDir     = (Map-SubDir -BaseFrom $Project -BaseTo $resolvedPrev -SubPath $Dir)
            worktreeRoot     = if ($isIsolated) { $resolvedPrev } else { $null }
            branch           = $null
            repos            = @()
        }
    }

    if ($WorktreeMode -eq 'off') {
        return [ordered]@{
            used             = $false
            topology         = 'in-place'
            reason           = 'disabled'
            sourceProject    = $Project
            effectiveProject = $Project
            effectiveDir     = $Dir
            worktreeRoot     = $null
            branch           = $null
            repos            = @()
        }
    }

    if ($Mode -eq 'read-only' -and $WorktreeMode -eq 'auto') {
        return [ordered]@{
            used             = $false
            topology         = 'in-place'
            reason           = 'read-only'
            sourceProject    = $Project
            effectiveProject = $Project
            effectiveDir     = $Dir
            worktreeRoot     = $null
            branch           = $null
            repos            = @()
        }
    }

    $gitAvailable = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
    if (-not $gitAvailable) {
        if ($WorktreeMode -eq 'required') { throw '未找到 git 命令，无法启用 Worktree 隔离。' }
        return [ordered]@{
            used             = $false
            topology         = 'in-place'
            reason           = 'git-missing'
            sourceProject    = $Project
            effectiveProject = $Project
            effectiveDir     = $Dir
            worktreeRoot     = $null
            branch           = $null
            repos            = @()
        }
    }

    # Topology A: Project itself is inside or at the root of a Git repository
    $topRes = Invoke-GitCapture -RepoDir $Project -GitArgs @('rev-parse', '--show-toplevel')
    if ($topRes.ExitCode -eq 0 -and $topRes.Stdout.Trim()) {
        $candidateRoot = $topRes.Stdout.Trim()
        if (Test-Path -LiteralPath $candidateRoot -PathType Container) {
            $repoRoot = (Resolve-Path -LiteralPath $candidateRoot).Path
            $headCheck = Invoke-GitCapture -RepoDir $repoRoot -GitArgs @('rev-parse', '--verify', 'HEAD')
            if ($headCheck.ExitCode -ne 0) {
                if ($WorktreeMode -eq 'required') { throw "Git 仓库尚无初始提交，无法创建 Worktree：$repoRoot" }
                return [ordered]@{
                    used             = $false
                    topology         = 'in-place'
                    reason           = 'unborn-head'
                    sourceProject    = $Project
                    effectiveProject = $Project
                    effectiveDir     = $Dir
                    worktreeRoot     = $null
                    branch           = $null
                    repos            = @()
                }
            }

            $repoLeaf = Split-Path -Leaf $repoRoot
            $repoParent = Split-Path -Parent $repoRoot
            $wtRoot = [IO.Path]::GetFullPath((Join-Path $repoParent ".worktrees\$repoLeaf\$Task"))
            $branchName = "worker/$Task"

            $repoEntries = @()
            if ($DryRun) {
                $repoEntries += [ordered]@{
                    repo     = $repoRoot
                    worktree = $wtRoot
                    branch   = $branchName
                    baseHead = $headCheck.Stdout.Trim()
                    reused   = (Test-Path -LiteralPath (Join-Path $wtRoot '.git'))
                }
            } else {
                $entry = Ensure-SingleRepoWorktree -RepoRoot $repoRoot -WorktreePath $wtRoot -BranchName $branchName
                $wtRoot = $entry.worktree
                $branchName = $entry.branch
                $repoEntries += $entry
            }

            $effProj = Map-SubDir -BaseFrom $repoRoot -BaseTo $wtRoot -SubPath $Project
            $effDir = Map-SubDir -BaseFrom $Project -BaseTo $effProj -SubPath $Dir
            return [ordered]@{
                used             = $true
                topology         = 'single-repo'
                reason           = 'isolated'
                sourceProject    = $Project
                effectiveProject = $effProj
                effectiveDir     = $effDir
                worktreeRoot     = $wtRoot
                branch           = $branchName
                repos            = $repoEntries
            }
        }
    }

    # Topology B: Multi-repo umbrella directory (e.g. D:\dev\code\fms269 containing fms, fms-front, fms-p269)
    $skipNames = @('.git', '.worktrees', 'work', 'node_modules', '.idea', '.vscode')
    $childRepos = @(
        Get-ChildItem -LiteralPath $Project -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -notin $skipNames -and (Test-Path -LiteralPath (Join-Path $_.FullName '.git'))
        } |
        Where-Object {
            (Invoke-GitCapture -RepoDir $_.FullName -GitArgs @('rev-parse', '--verify', 'HEAD')).ExitCode -eq 0
        }
    )

    if ($childRepos.Count -gt 0) {
        $wtUmbrella = [IO.Path]::GetFullPath((Join-Path $Project "work\alpha\worktrees\$Task"))
        $branchName = "worker/$Task"
        $repoEntries = @()

        if ($DryRun) {
            foreach ($cr in $childRepos) {
                $headSha = (Invoke-GitCapture -RepoDir $cr.FullName -GitArgs @('rev-parse', 'HEAD')).Stdout.Trim()
                $childWt = Join-Path $wtUmbrella $cr.Name
                $repoEntries += [ordered]@{
                    repo     = $cr.FullName
                    worktree = $childWt
                    branch   = $branchName
                    baseHead = $headSha
                    reused   = (Test-Path -LiteralPath (Join-Path $childWt '.git'))
                }
            }
        } else {
            New-Item -ItemType Directory -Force -Path $wtUmbrella | Out-Null
            foreach ($docName in @('AGENTS.md', 'CLAUDE.md', '.editorconfig')) {
                $srcDoc = Join-Path $Project $docName
                $dstDoc = Join-Path $wtUmbrella $docName
                if ((Test-Path -LiteralPath $srcDoc -PathType Leaf) -and -not (Test-Path -LiteralPath $dstDoc)) {
                    Copy-Item -LiteralPath $srcDoc -Destination $dstDoc -Force
                }
            }
            foreach ($cr in $childRepos) {
                $childWt = Join-Path $wtUmbrella $cr.Name
                $repoEntries += (Ensure-SingleRepoWorktree -RepoRoot $cr.FullName -WorktreePath $childWt -BranchName $branchName)
            }
        }

        $effProj = $wtUmbrella
        $effDir = Map-SubDir -BaseFrom $Project -BaseTo $effProj -SubPath $Dir
        return [ordered]@{
            used             = $true
            topology         = 'umbrella-multi-repo'
            reason           = 'isolated'
            sourceProject    = $Project
            effectiveProject = $effProj
            effectiveDir     = $effDir
            worktreeRoot     = $wtUmbrella
            branch           = $branchName
            repos            = $repoEntries
        }
    }

    # Topology C: Plain non-git directory
    if ($WorktreeMode -eq 'required') {
        throw "目录 $Project 既不是 Git 仓库也不包含子 Git 仓库，无法创建隔离 Worktree（可传 -NoWorktree 或 -WorktreeMode off）。"
    }
    return [ordered]@{
        used             = $false
        topology         = 'non-git'
        reason           = 'no-git-repo'
        sourceProject    = $Project
        effectiveProject = $Project
        effectiveDir     = $Dir
        worktreeRoot     = $null
        branch           = $null
        repos            = @()
    }
}
