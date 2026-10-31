"""git 日志提取与版本说明生成模块。"""
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from core.pom_reader import read_root_pom, strip_snapshot

VERSION_RELPATH = "src/main/resources/version/project.md"
PROJECT_VERSION_RELPATH = "src/main/resources/version/project-version.md"


def _find_starter_dir(project_dir: str) -> Path:
    """
    在项目根目录下找名称以 '-starter' 结尾的一级子目录。
    找到则返回该子目录路径，否则返回项目根目录（兜底）。
    """
    from core.project_layout import selected_target
    selected = selected_target(project_dir)
    if selected is not None:
        return selected
    root = Path(project_dir)
    candidates = [p for p in root.iterdir() if p.is_dir() and p.name.endswith("-starter")]
    if candidates:
        return candidates[0]
    return root


def _extract_commits(project_dir: str) -> tuple[list[tuple[str, str]], str]:
    """提取近一个月 feat/fix 提交，返回 (commits, warning)。warning 为空表示成功。"""
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    result = subprocess.run(
        [
            "git", "log",
            "--since=1 month ago",
            "--pretty=format:%ad|||%s",
            "--date=format:%Y-%m-%d",
        ],
        cwd=project_dir,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=flags,
        timeout=60,
    )
    if result.returncode != 0:
        return [], (result.stderr.strip() or "git log 执行失败（请确认目录是 git 仓库）")
    commits: list[tuple[str, str]] = []
    for line in result.stdout.splitlines():
        parts = line.split("|||", 1)
        if len(parts) == 2:
            date, msg = parts[0].strip(), parts[1].strip()
            if msg.startswith(("feat", "fix")):
                commits.append((date, msg))
    # 按日期逆序
    commits.sort(key=lambda x: x[0], reverse=True)
    return commits, ""


def format_project_version(version: str, ts: str) -> str:
    """生成 project-version.md 的一行版本号：去 -SNAPSHOT 后追加时间戳。"""
    base = strip_snapshot(version)
    return f"{base}-{ts}" if base else ""


def generate_version_md(project_dir: str) -> tuple[str, Path, Path, str]:
    """
    生成版本说明 Markdown 内容，写入 <starter模块>/src/main/resources/version/project.md；
    同时写入 <starter模块>/src/main/resources/version/project-version.md。

    返回 (写入的 project.md 内容, project.md 路径, project-version.md 路径, project-version.md 内容)；
    若无提交记录则内容为空字符串，但仍会写入 project-version.md。
    若 git log 失败则抛 RuntimeError。
    """
    commits, warning = _extract_commits(project_dir)
    if warning:
        raise RuntimeError(warning)

    starter_dir = _find_starter_dir(project_dir)
    version_target = starter_dir / PROJECT_VERSION_RELPATH
    version_target.parent.mkdir(parents=True, exist_ok=True)
    _artifact, version = read_root_pom(project_dir)
    ts = datetime.now().strftime("%Y%m%d%H%M")
    project_version = format_project_version(version, ts)
    version_target.write_text(project_version + "\n", encoding="utf-8")

    target = starter_dir / VERSION_RELPATH
    if not commits:
        return "", target, version_target, project_version

    # 按日期分组，保持逆序
    date_map: dict[str, list[str]] = defaultdict(list)
    for date, msg in commits:
        date_map[date].append(msg)

    lines: list[str] = []
    for date in sorted(date_map.keys(), reverse=True):
        lines.append(date)
        for msg in date_map[date]:
            lines.append(f"  {msg}")

    content = "\n".join(lines) + "\n"

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")

    return content, target, version_target, project_version
