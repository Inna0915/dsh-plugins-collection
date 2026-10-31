"""版本说明组合模块。

将「项目说明」（git 日志，模块名固定为 ``project``）与「产品说明」（产品 jar 包内）
合并为统一的「版本说明」：
  - 「版本信息」区块：各产品 ``version/{module}-version.md`` 的版本号
  - 任一模块有版本说明时只展示版本说明；全部没有时才按日期合并旧记录
"""
from datetime import date
from pathlib import Path

from core.jar_reader import _DATE_PATTERN, _Entry, collect_product_notes
from core.pom_reader import read_root_pom, strip_snapshot
from core.notes_display import default_scope, scoped_release

VERSION_NOTES_FILENAME = "版本说明.md"
PROJECT_MODULE = "project"


def _parse_project_entries(project_md: str) -> list[_Entry]:
    """将 git 生成的原始项目说明（日期行 + 2 空格消息行）解析为条目，模块名固定为 project。"""
    entries: list[_Entry] = []
    if not project_md:
        return entries
    current: date | None = None
    for line in project_md.splitlines():
        if not line.strip():
            continue
        stripped = line.strip()
        if _DATE_PATTERN.match(stripped):
            try:
                current = date.fromisoformat(stripped)
            except ValueError:
                current = None
            continue
        if line.startswith("  ") and current is not None:
            entries.append(_Entry(current, PROJECT_MODULE, stripped))
    return entries


def _render_versions(versions: dict[str, str]) -> str:
    """渲染「版本信息」区块：每模块一行 ``- **[module]** 版本号``。"""
    if not versions:
        return "（未读取到版本号）"
    return "\n".join(f"- **[{module}]** {ver}" for module, ver in versions.items())


def _render_history(entries: list[_Entry]) -> str:
    """渲染「更新记录」区块：所有条目按日期倒序分组，每条 ``- **[module]** 描述``。"""
    if not entries:
        return "（无更新记录）"

    by_date: dict[date, list[_Entry]] = {}
    for e in sorted(entries, key=lambda x: x.date, reverse=True):
        by_date.setdefault(e.date, []).append(e)

    lines: list[str] = []
    for dt, group in by_date.items():
        lines.append(f"### {dt}")
        lines.append("")
        for e in group:
            scope = {"project": "project", "fms": "warehouse"}.get(e.module, "")
            lines.append(f"- **[{e.module}]** {default_scope(e.description, scope)}")
        lines.append("")
    return "\n".join(lines).rstrip()


def _assemble(versions: dict[str, str], entries: list[_Entry], releases: list[str] | None = None) -> str:
    # 服务 Markdown 已包含「## 模块 版本 / ### 新增功能」层级，保留原样，不再套日期标题。
    parts: list[str] = [
        "# 版本说明",
        "",
        "## 版本信息",
        "",
        _render_versions(versions),
        "",
    ]
    if releases:
        parts.append("\n\n".join(releases))
    else:
        parts.extend(["## 更新记录", "", _render_history(entries)])
    return "\n".join(parts).rstrip() + "\n"


def build_project_preview(project_md: str, project_version: str = "", project_releases: str = "") -> str:
    """仅含项目说明的预览（产品说明待构建后补充），用于打包前先行展示。"""
    versions = {PROJECT_MODULE: project_version} if project_version else {}
    releases = [scoped_release(project_releases.strip(), "project")] if project_releases.strip() else []
    return _assemble(versions, [] if releases else _parse_project_entries(project_md), releases)


def build_version_notes(
    project_dir: str,
    project_md: str,
    project_version: str = "",
    project_releases: str = "",
) -> tuple[str, list[str]]:
    """
    合并项目说明与产品说明为统一「版本说明」Markdown。

    :return: ``(markdown, logs)``，logs 为读取产品 jar 的过程日志
    """
    project_releases = project_releases.strip()
    products = collect_product_notes(project_dir, bool(project_releases))
    logs = products.logs

    # 项目版本号：优先复用 project-version.md 写入值，保证本地版本说明与包内版本文件一致。
    versions: dict[str, str] = {}
    project_label = project_version.strip()
    if not project_label:
        _artifact, version = read_root_pom(project_dir)
        project_label = strip_snapshot(version)
    if project_label:
        versions["project"] = project_label
        logs.append(f"[INFO] [project] {project_label}")
    else:
        logs.append("[WARN] [project] 未能解析项目版本号")
    versions.update(products.versions)

    releases = ([scoped_release(project_releases, "project")] if project_releases else []) + [
        scoped_release(text, "warehouse" if module == "fms" else "")
        for module, text in products.releases.items()
    ]
    if releases:
        logs.append("[INFO] 使用版本说明，所有模块均不展示旧日期记录")
        return _assemble(versions, [], releases), logs
    logs.append("[INFO] 所有模块均无版本说明，使用旧日期记录")
    entries = _parse_project_entries(project_md) + products.entries
    return _assemble(versions, entries), logs


def write_version_notes(
    war_dir: Path | str,
    content: str,
    filename: str = VERSION_NOTES_FILENAME,
) -> Path:
    """在 WAR 同级目录写入版本说明 Markdown，返回文件路径。"""
    target = Path(war_dir) / filename
    target.write_text(content, encoding="utf-8")
    return target
