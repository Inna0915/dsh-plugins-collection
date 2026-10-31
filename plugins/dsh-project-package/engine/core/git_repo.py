"""Git 仓库检测及打包前更新/重置操作。"""
from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

INSPECT_TIMEOUT_SECONDS = 15
OPERATION_TIMEOUT_SECONDS = 120
PACKAGE_GENERATED_FILE_SUFFIXES = (
    ("src", "main", "resources", "version", "project.md"),
    ("src", "main", "resources", "version", "project-version.md"),
    ("src", "main", "resources", "version", "project-releases.md"),
)


class GitRepositoryError(RuntimeError):
    """Git 仓库操作错误。"""


class NotGitRepositoryError(GitRepositoryError):
    """所选目录不属于 Git 仓库。"""


class GitNoUpstreamError(GitRepositoryError):
    """当前分支没有 upstream。"""


class GitCommandTimeoutError(GitRepositoryError):
    """Git 命令执行超时。"""


class GitDirtyWorktreeError(GitRepositoryError):
    """工作区存在本地改动，不能切换分支。"""


class GitRemoteBranchError(GitRepositoryError):
    """远端分支不存在或与本地分支配置冲突。"""


@dataclass(frozen=True)
class GitCommandResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def output(self) -> str:
        return "\n".join(part for part in (self.stdout.strip(), self.stderr.strip()) if part)


@dataclass(frozen=True)
class GitRepository:
    root: Path
    branch: str
    upstream: str
    ahead: int
    behind: int
    changed_count: int

    @property
    def dirty(self) -> bool:
        return self.changed_count > 0


@dataclass(frozen=True)
class GitOperationResult:
    returncode: int
    output: str

    @property
    def success(self) -> bool:
        return self.returncode == 0


@dataclass(frozen=True)
class GitBranchesResult:
    returncode: int
    output: str
    branches: tuple[str, ...] = ()

    @property
    def success(self) -> bool:
        return self.returncode == 0


def _terminate_process_tree(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except (OSError, subprocess.TimeoutExpired):
            proc.kill()
    else:
        proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def _run_git(
    path: Path | str,
    args: list[str],
    timeout: int = INSPECT_TIMEOUT_SECONDS,
) -> GitCommandResult:
    cmd = ["git", "-C", str(path), *args]
    flags = 0
    if sys.platform == "win32":
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            creationflags=flags,
        )
    except FileNotFoundError as exc:
        raise GitRepositoryError("未找到 git 命令，请检查环境配置") from exc

    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        _terminate_process_tree(proc)
        raise GitCommandTimeoutError(f"Git 命令执行超时（>{timeout}s）: {' '.join(args)}") from exc
    finally:
        if proc.poll() is None:
            _terminate_process_tree(proc)
    return GitCommandResult(proc.returncode, stdout, stderr)


def _required_output(path: Path | str, args: list[str], error: str) -> str:
    result = _run_git(path, args)
    if result.returncode != 0:
        raise GitRepositoryError(result.output or error)
    return result.stdout.strip()


def _repository_root(path: Path | str) -> Path:
    candidate = Path(path)
    if not candidate.is_dir():
        raise NotGitRepositoryError("项目目录不存在")
    root_result = _run_git(candidate, ["rev-parse", "--show-toplevel"])
    if root_result.returncode != 0:
        raise NotGitRepositoryError("未检测到 Git 仓库")
    return Path(root_result.stdout.strip())


def inspect_repository(path: Path | str) -> GitRepository:
    root = _repository_root(path)

    branch_result = _run_git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])
    if branch_result.returncode == 0:
        branch = branch_result.stdout.strip()
    else:
        commit = _required_output(root, ["rev-parse", "--short", "HEAD"], "无法读取当前提交")
        branch = f"detached@{commit}"

    upstream_result = _run_git(
        root,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )
    upstream = upstream_result.stdout.strip() if upstream_result.returncode == 0 else ""

    ahead = 0
    behind = 0
    if upstream:
        counts = _run_git(root, ["rev-list", "--left-right", "--count", f"HEAD...{upstream}"])
        if counts.returncode == 0:
            parts = counts.stdout.split()
            if len(parts) == 2:
                ahead, behind = int(parts[0]), int(parts[1])

    status = _required_output(
        root,
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        "无法读取工作区状态",
    )
    changed_count = len(status.splitlines()) if status else 0
    return GitRepository(root, branch, upstream, ahead, behind, changed_count)


def list_remote_branches(path: Path | str) -> list[str]:
    """读取本地 remote refs，排除 remote HEAD，不执行网络请求。"""
    root = _repository_root(path)
    result = _run_git(
        root,
        ["for-each-ref", "--format=%(refname:short)%00%(symref)", "refs/remotes"],
    )
    if result.returncode != 0:
        raise GitRepositoryError(result.output or "无法读取远端分支")
    branches: set[str] = set()
    for line in result.stdout.splitlines():
        short_name, _separator, symbolic_target = line.partition("\0")
        short_name = short_name.strip()
        if short_name and not symbolic_target and not short_name.endswith("/HEAD"):
            branches.add(short_name)
    return sorted(branches, key=str.casefold)


def refresh_remote_branches(path: Path | str) -> GitBranchesResult:
    """执行 fetch/prune 并返回刷新后的远端分支。"""
    root = _repository_root(path)
    fetch = _run_git(
        root,
        ["fetch", "--prune"],
        timeout=OPERATION_TIMEOUT_SECONDS,
    )
    output = _render_step("git fetch --prune", fetch)
    if fetch.returncode != 0:
        return GitBranchesResult(fetch.returncode, output)
    return GitBranchesResult(0, output, tuple(list_remote_branches(root)))


def _local_branch_for_remote(root: Path, remote_branch: str) -> str:
    remotes = _required_output(root, ["remote"], "未配置 Git remote").splitlines()
    matches = [remote for remote in remotes if remote_branch.startswith(f"{remote}/")]
    if not matches:
        raise GitRemoteBranchError(f"无法识别远端分支所属 remote: {remote_branch}")
    remote = max(matches, key=len)
    local_branch = remote_branch[len(remote) + 1:]
    if not local_branch or local_branch == "HEAD":
        raise GitRemoteBranchError(f"无效的远端分支: {remote_branch}")
    return local_branch


def switch_to_remote_branch(path: Path | str, remote_branch: str) -> GitOperationResult:
    """在工作区完全干净时切换到远端分支对应的本地跟踪分支。"""
    repository = inspect_repository(path)
    if repository.dirty:
        raise GitDirtyWorktreeError(
            f"工作区存在 {repository.changed_count} 项改动，请先重置到远端；"
            "如仍有其他未跟踪文件，请手动清理"
        )

    remote_branches = list_remote_branches(repository.root)
    if remote_branch not in remote_branches:
        raise GitRemoteBranchError(f"远端分支不存在，请先刷新: {remote_branch}")
    if repository.upstream == remote_branch:
        return GitOperationResult(0, f"[INFO] 当前已在 {remote_branch}，无需切换")

    local_branch = _local_branch_for_remote(repository.root, remote_branch)
    local_ref = f"refs/heads/{local_branch}"
    local_exists = _run_git(
        repository.root,
        ["show-ref", "--verify", "--quiet", local_ref],
    )
    if local_exists.returncode not in (0, 1):
        raise GitRepositoryError(local_exists.output or f"无法检查本地分支: {local_branch}")

    if local_exists.returncode == 0:
        upstream = _required_output(
            repository.root,
            ["for-each-ref", "--format=%(upstream:short)", local_ref],
            f"无法读取本地分支 upstream: {local_branch}",
        )
        if upstream != remote_branch:
            configured = upstream or "未设置"
            raise GitRemoteBranchError(
                f"本地分支 {local_branch} 的 upstream 为 {configured}，"
                f"与 {remote_branch} 不一致，请在工具外处理"
            )
        args = ["switch", local_branch]
        command = f"git switch {local_branch}"
    else:
        args = ["switch", "--track", "-c", local_branch, remote_branch]
        command = f"git switch --track -c {local_branch} {remote_branch}"

    result = _run_git(repository.root, args, timeout=OPERATION_TIMEOUT_SECONDS)
    return GitOperationResult(result.returncode, _render_step(command, result))


def _require_upstream(path: Path | str) -> GitRepository:
    repository = inspect_repository(path)
    if not repository.upstream:
        raise GitNoUpstreamError(f"当前分支 {repository.branch} 未设置 upstream")
    return repository


def _render_step(command: str, result: GitCommandResult) -> str:
    lines = [f"$ {command}"]
    if result.output:
        lines.append(result.output)
    return "\n".join(lines)


def pull_repository(path: Path | str) -> GitOperationResult:
    repository = _require_upstream(path)
    result = _run_git(
        repository.root,
        ["pull", "--ff-only"],
        timeout=OPERATION_TIMEOUT_SECONDS,
    )
    return GitOperationResult(result.returncode, _render_step("git pull --ff-only", result))


def _is_package_generated_file(git_path: str) -> bool:
    path = PurePosixPath(git_path)
    if path.is_absolute() or ".." in path.parts:
        return False
    return any(
        len(path.parts) >= len(suffix) and path.parts[-len(suffix):] == suffix
        for suffix in PACKAGE_GENERATED_FILE_SUFFIXES
    )


def _clean_untracked_package_generated_files(root: Path) -> GitOperationResult:
    command = "git ls-files --others --exclude-standard -z"
    listed = _run_git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
    output = [f"$ {command}"]
    if listed.returncode != 0:
        if listed.output:
            output.append(listed.output)
        return GitOperationResult(listed.returncode, "\n".join(output))

    root_absolute = root.absolute()
    removed: list[str] = []
    for git_path in listed.stdout.split("\0"):
        if not git_path or not _is_package_generated_file(git_path):
            continue
        relative = PurePosixPath(git_path)
        candidate = root.joinpath(*relative.parts)
        try:
            candidate.absolute().relative_to(root_absolute)
        except ValueError:
            return GitOperationResult(1, "\n".join([*output, f"[ERROR] 非法生成文件路径: {git_path}"]))
        if not (candidate.is_file() or candidate.is_symlink()):
            continue
        try:
            candidate.unlink()
        except OSError as exc:
            return GitOperationResult(
                1,
                "\n".join([*output, f"[ERROR] 无法清理打包生成文件 {git_path}: {exc}"]),
            )
        removed.append(git_path)

    if removed:
        output.extend(f"[INFO] 已清理打包生成文件: {path}" for path in removed)
    else:
        output.append("[INFO] 未发现需要清理的未跟踪打包生成文件")
    return GitOperationResult(0, "\n".join(output))


def reset_repository_to_upstream(path: Path | str) -> GitOperationResult:
    repository = _require_upstream(path)
    fetch = _run_git(repository.root, ["fetch"], timeout=OPERATION_TIMEOUT_SECONDS)
    output = [_render_step("git fetch", fetch)]
    if fetch.returncode != 0:
        return GitOperationResult(fetch.returncode, "\n".join(output))

    refreshed = _require_upstream(repository.root)
    reset = _run_git(
        refreshed.root,
        ["reset", "--hard", refreshed.upstream],
        timeout=OPERATION_TIMEOUT_SECONDS,
    )
    output.append(_render_step(f"git reset --hard {refreshed.upstream}", reset))
    if reset.returncode != 0:
        return GitOperationResult(reset.returncode, "\n".join(output))

    cleanup = _clean_untracked_package_generated_files(refreshed.root)
    output.append(cleanup.output)
    if not cleanup.success:
        return GitOperationResult(cleanup.returncode, "\n".join(output))

    final_state = inspect_repository(refreshed.root)
    if final_state.dirty:
        output.append(f"[WARN] 重置后仍有 {final_state.changed_count} 项其他改动，请手动处理")
    else:
        output.append("[INFO] 工作区已清理干净")
    return GitOperationResult(0, "\n".join(output))
