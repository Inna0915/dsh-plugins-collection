"""Compact read-only Git inspection for the project switch UI."""
from pathlib import Path

from core.git_repo import GitRepository, GitRepositoryError, _repository_root, _run_git


def parse_status(root, output):
    branch, oid, upstream, ahead, behind, changed = '', '', '', 0, 0, 0
    records = iter(output.split('\0'))
    for record in records:
        if record.startswith('# branch.head '):
            branch = record.removeprefix('# branch.head ')
        elif record.startswith('# branch.oid '):
            oid = record.removeprefix('# branch.oid ')
        elif record.startswith('# branch.upstream '):
            upstream = record.removeprefix('# branch.upstream ')
        elif record.startswith('# branch.ab '):
            plus, minus = record.removeprefix('# branch.ab ').split()
            ahead, behind = int(plus[1:]), int(minus[1:])
        elif record.startswith(('1 ', '2 ', 'u ', '? ')):
            changed += 1
            if record.startswith('2 '):
                next(records, None)  # Rename/copy source filename is a separate NUL record.
    if branch == '(detached)':
        branch = 'detached@' + oid[:7]
    return GitRepository(Path(root), branch, upstream, ahead, behind, changed)


def inspect_repository(path):
    root = _repository_root(path)
    status = _run_git(root, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z'])
    if status.returncode != 0:
        raise GitRepositoryError(status.output or '无法读取工作区状态')
    return parse_status(root, status.stdout)
