"""Bounded, local-only Maven discovery. No subprocess or network requests."""
from __future__ import annotations

import os
import re
import time
import xml.etree.ElementTree as ET
from pathlib import Path

IGNORED = {".git", ".svn", "node_modules", "target", "build", "dist", ".idea", ".gradle", ".venv", "venv", ".task-temp", "work", "__pycache__"}
PROJECT_ROOT = re.compile(r"^[a-z][a-z0-9]*-(?:p\d+|project(?:-[a-z0-9][a-z0-9.-]*)?)$")
PROJECT_MODULE = re.compile(r"^(.+-(?:project|p\d+))-module$")
# Each workspace gets its own directory budget so one large workspace cannot
# starve the others; the shared deadline only bounds the whole scan.
MAX_DIRECTORIES_PER_ROOT = 1800
SCAN_SECONDS = 12


def pom_info(directory: Path) -> dict | None:
    pom = directory / "pom.xml"
    try:
        if not pom.is_file() or pom.stat().st_size > 2_000_000:
            return None
        root = ET.fromstring(pom.read_text(encoding="utf-8-sig"))
        if root.tag.split("}")[-1] != "project":
            return None
        artifact = (root.findtext("{*}artifactId") or "").strip()
        if not artifact:
            return None
        return {
            "path": str(directory.resolve()), "artifact": artifact,
            "version": (root.findtext("{*}version") or root.findtext("{*}parent/{*}version") or "").strip(),
            "packaging": (root.findtext("{*}packaging") or "jar").strip(),
            "modules": [(x.text or "").strip() for x in root.findall("{*}modules/{*}module") if (x.text or "").strip()],
        }
    except (OSError, UnicodeError, ET.ParseError):
        return None


def key(path: str | Path) -> str:
    return os.path.normcase(str(Path(path).resolve()))


def project_pairs(modules: list[dict]) -> list[tuple[dict, dict]]:
    """Business module + deployable starter; a library or demo WAR alone is insufficient."""
    by_artifact = {m["artifact"]: m for m in modules}
    pairs = []
    for module in modules:
        match = PROJECT_MODULE.fullmatch(module["artifact"])
        starter = by_artifact.get(match[1] + "-starter") if match else None
        if starter and starter["packaging"] == "war":
            pairs.append((module, starter))
    return pairs


def project_info(directory: str | Path) -> dict:
    directory = Path(directory).resolve()
    info = pom_info(directory)
    if info is None:
        raise ValueError("目录没有有效的 Maven pom.xml")
    pending = [info]
    modules = []
    seen = set()
    while pending and len(seen) < 200:
        current = pending.pop(0)
        if key(current["path"]) in seen:
            continue
        seen.add(key(current["path"]))
        modules.append(current)
        for child in current["modules"]:
            child_path = (Path(current["path"]) / child).resolve()
            if not child_path.is_relative_to(directory):
                continue
            child_info = pom_info(child_path)
            if child_info:
                pending.append(child_info)
    # Some existing projects (e.g. P329) have a metadata-only root POM.
    # Only infer a complete, named business pair in its immediate real directories.
    if not info["modules"] and info["packaging"] == "pom" and PROJECT_ROOT.fullmatch(info["artifact"]):
        children = []
        for child in sorted(directory.iterdir()):
            if child.is_dir() and not child.is_symlink() and not getattr(child, "is_junction", lambda: False)():
                child_info = pom_info(child)
                if child_info:
                    children.append(child_info)
        pairs = project_pairs(children)
        if pairs:
            inferred = [m for pair in pairs for m in pair]
            modules.extend(inferred)
            info["buildPaths"] = [info["path"], *[m["path"] for m in inferred]]
    info["businessProject"] = info["packaging"] == "pom" and bool(project_pairs(modules))
    targets = [m for m in modules if m["packaging"] == "war"]
    if not targets:
        targets = [m for m in modules if Path(m["path"]).name.endswith("-starter")]
    if not targets:
        targets = [info]
    info["targets"] = [{k: m[k] for k in ("path", "artifact", "packaging")} for m in targets]
    info["modulePaths"] = [m["path"] for m in modules]
    return info


def discover(workspaces: list[dict], recent: list[str], max_depth: int = 3) -> dict:
    found = {}
    warnings = []
    visited = set()
    deadline = time.monotonic() + SCAN_SECONDS
    roots = [(w.get("path", ""), w.get("title", "工作区")) for w in workspaces]
    roots += [(path, "最近项目") for path in recent]
    for raw, title in roots:
        if not raw:
            continue
        root = Path(raw)
        if not root.is_dir():
            continue
        root = root.resolve()
        # An opened Maven child can resolve to a declaring ancestor, up to its Git root.
        candidate = root
        for parent in list(root.parents)[:5]:
            if (candidate / ".git").exists():
                break
            parent_info = pom_info(parent)
            if parent_info:
                try:
                    aggregate = project_info(parent)
                    if key(root) in {key(p) for p in aggregate["modulePaths"]}:
                        candidate = parent
                except (OSError, ValueError):
                    pass
            if (parent / ".git").exists():
                break
        pending = [(candidate, 0)]
        budget = MAX_DIRECTORIES_PER_ROOT
        while pending:
            directory, depth = pending.pop(0)
            canonical = key(directory)
            if canonical in visited:
                continue
            if budget <= 0 or time.monotonic() > deadline:
                warnings.append(f"工作区「{title}」较大，本次识别已达上限；可输入具体项目目录继续识别。")
                break
            budget -= 1
            visited.add(canonical)
            pom = pom_info(directory)
            if pom:
                try:
                    info = project_info(directory)
                    info["workspace"] = title
                    if info["businessProject"]:
                        found[canonical] = info
                        continue
                except (OSError, ValueError):
                    pass
                # A business project root is always a pom aggregator. Below a jar/war
                # module there are only sources and build output.
                if pom["packaging"] != "pom":
                    continue
            if depth >= max_depth:
                continue
            try:
                # Inside a Maven aggregator only directories with their own POM can be
                # a project; plain folders (sources, docs, plans) are not walked.
                pending.extend((p, depth + 1) for p in sorted(directory.iterdir())
                               if p.name not in IGNORED and not p.name.startswith(".")
                               and (not pom or (p / "pom.xml").is_file())
                               and p.is_dir() and not p.is_symlink() and not getattr(p, "is_junction", lambda: False)())
            except OSError:
                warnings.append(f"目录无法读取：{directory}")
    # A registered child and its registered reactor should not appear as duplicate projects.
    children = {key(p) for info in found.values() for p in info["modulePaths"] if key(p) != key(info["path"])}
    return {"projects": [v for k, v in found.items() if k not in children], "warnings": list(dict.fromkeys(warnings))}
