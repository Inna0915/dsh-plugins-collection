"""Maven 解析清单与实际 WAR 清单。所有临时输出均在工具数据目录。"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import Event

from core.app_config import default_config_path
from core.maven_build import BuildCancelled, _terminate_process_tree, check_cancelled


@dataclass(frozen=True)
class Dependency:
    group: str
    artifact: str
    version: str
    extension: str = "jar"
    classifier: str = ""

    @property
    def key(self) -> str:
        return ":".join((self.group, self.artifact, self.version, self.extension, self.classifier))

    @classmethod
    def from_key(cls, key: str) -> Dependency:
        parts = key.split(":")
        if len(parts) != 5 or not all(parts[:4]):
            raise ValueError("无效依赖坐标")
        return cls(*parts)


@dataclass
class PackagedArtifact:
    dependency: Dependency
    sha256: str
    sha1: str
    entry: str


def monitor_home() -> Path:
    return default_config_path().parent / "monitor"


def project_poms(project: str) -> list[Path]:
    root = Path(project).resolve()
    pending, seen, paths = [root / "pom.xml"], set(), []
    while pending:
        path = pending.pop().resolve()
        if path in seen:
            continue
        seen.add(path)
        if not path.is_file():
            continue
        paths.append(path)
        xml = ET.fromstring(path.read_text(encoding="utf-8-sig"))
        for module in xml.findall("{*}modules/{*}module"):
            child = (path.parent / (module.text or "") / "pom.xml").resolve()
            if child.is_relative_to(root):
                pending.append(child)
    return sorted(paths)


def context_id(project: str, settings_paths: list[Path] = ()) -> str:
    digest = hashlib.sha256(os.path.normcase(str(Path(project).resolve())).encode())
    paths = project_poms(project)
    # 父 POM 影响属性、版本及依赖管理，纳入缓存键。
    parents = list(paths)
    seen = set(paths)
    while parents:
        path = parents.pop()
        xml = ET.fromstring(path.read_text(encoding="utf-8-sig"))
        parent = xml.find("{*}parent")
        if parent is not None:
            rel = parent.find("{*}relativePath")
            value = "../pom.xml" if rel is None else (rel.text or "")
            candidate = (path.parent / value).resolve() if value else None
            if candidate and candidate.is_file() and candidate not in seen:
                seen.add(candidate)
                parents.append(candidate)
                paths.append(candidate)
    paths += [Path(project) / ".mvn" / x for x in ("maven.config", "jvm.config")]
    paths += list(settings_paths)
    for path in sorted(set(paths)):
        if path.is_file():
            digest.update(str(path).encode())
            digest.update(path.read_bytes())
    result = subprocess.run(["git", "symbolic-ref", "--quiet", "HEAD"], cwd=project,
                            capture_output=True, timeout=5,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    digest.update(result.stdout if result.returncode == 0 else b"detached")
    for key in ("MAVEN_ARGS", "MAVEN_OPTS", "JAVA_HOME", "JAVA_TOOL_OPTIONS"):
        digest.update(os.environ.get(key, "").encode())
    return digest.hexdigest()


def parse_dependency_tree(output: str, reactor: set[tuple[str, str]]) -> list[Dependency]:
    found = {}
    for line in output.splitlines():
        line = re.sub(r"\x1b\[[0-9;]*m", "", line)
        line = re.sub(r"^\[INFO\]\s*", "", line).strip()
        match = re.match(r"^\d+\s+([^\s]+)", line)
        if not match:
            continue
        parts = match.group(1).split(":")
        if len(parts) not in (4, 5, 6):
            continue
        group, artifact, kind = parts[:3]
        if len(parts) == 6:
            classifier, version, scope = parts[3:]
        else:
            classifier, version = "", parts[3]
            scope = parts[4] if len(parts) == 5 else ""
        if kind != "jar" or scope not in ("compile", "runtime") or (group, artifact) in reactor:
            continue
        dep = Dependency(group, artifact, version, kind, classifier)
        found[dep.key] = dep
    return list(found.values())


def resolve_dependencies(project: str, cancel: Event) -> list[Dependency]:
    executable = shutil.which("mvn")
    if not executable:
        raise RuntimeError("未找到 Maven")
    reactor = set()
    for path in project_poms(project):
        xml = ET.fromstring(path.read_text(encoding="utf-8-sig"))
        group = xml.findtext("{*}groupId") or xml.findtext("{*}parent/{*}groupId") or ""
        reactor.add((group, xml.findtext("{*}artifactId") or ""))
    cmd = [executable, "-B", "org.apache.maven.plugins:maven-dependency-plugin:3.8.1:tree",
           "-DoutputType=tgf", "-Dscope=runtime", "-Dstyle.color=never"]
    check_cancelled(cancel)
    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} \
        if os.name == "nt" else {"start_new_session": True}
    proc = subprocess.Popen(cmd, cwd=project, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            encoding="utf-8", errors="replace", **kwargs)
    try:
        deadline = time.monotonic() + 120
        while True:
            check_cancelled(cancel)
            if time.monotonic() > deadline:
                raise TimeoutError("依赖解析超过 120 秒，请检查 Maven 仓库连接")
            try:
                output, _ = proc.communicate(timeout=.25)
                break
            except subprocess.TimeoutExpired:
                pass
        if proc.returncode:
            raise RuntimeError(f"Maven 依赖解析失败（exit {proc.returncode}），可先正常构建后重试")
        return parse_dependency_tree(output, reactor)
    finally:
        _terminate_process_tree(proc)
        if proc.stdout:
            proc.stdout.close()


def jar_coordinates(content: bytes, filename: str) -> Dependency | None:
    with zipfile.ZipFile(io.BytesIO(content)) as jar:
        candidates = []
        for name in jar.namelist():
            if not re.fullmatch(r"META-INF/maven/[^/]+/[^/]+/pom.properties", name):
                continue
            props = {}
            for line in jar.read(name).decode("utf-8-sig").splitlines():
                if "=" in line and not line.lstrip().startswith("#"):
                    key, value = line.split("=", 1)
                    props[key.strip()] = value.strip()
            if all(props.get(key) for key in ("groupId", "artifactId", "version")):
                dep = Dependency(props["groupId"], props["artifactId"], props["version"])
                if Path(filename).name.startswith(dep.artifact + "-"):
                    candidates.append(dep)
        return candidates[0] if len(candidates) == 1 else None


def read_war(war_path: str | Path, dependencies: list[Dependency], cancel: Event) -> dict[str, dict]:
    before = Path(war_path).stat()
    artifacts = {}
    with zipfile.ZipFile(war_path) as war:
        for entry in war.infolist():
            check_cancelled(cancel)
            if not entry.filename.startswith("WEB-INF/lib/") or not entry.filename.endswith(".jar"):
                continue
            if not any(Path(entry.filename).name.startswith(d.artifact + "-") for d in dependencies):
                continue
            if entry.file_size > 512 * 1024 * 1024:
                continue
            content = war.read(entry)
            try:
                dep = jar_coordinates(content, entry.filename)
            except (zipfile.BadZipFile, UnicodeError):
                continue
            if dep is None:
                continue
            matches = [d for d in dependencies if d.group == dep.group and d.artifact == dep.artifact
                       and d.version == dep.version and Path(entry.filename).name ==
                       f"{d.artifact}-{d.version}{'-' + d.classifier if d.classifier else ''}.jar"]
            if len(matches) != 1:
                continue
            dep = matches[0]
            if dep.key in artifacts:
                raise ValueError(f"WAR 存在重复依赖：{dep.artifact}")
            artifacts[dep.key] = {"sha256": hashlib.sha256(content).hexdigest(),
                                  "sha1": hashlib.sha1(content).hexdigest(), "entry": entry.filename}
    after = Path(war_path).stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError("WAR 在核验过程中发生变化，请重新核验")
    return artifacts


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def save_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)
