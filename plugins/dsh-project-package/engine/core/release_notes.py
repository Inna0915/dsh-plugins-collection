"""按当前 POM 版本登记项目提交，并生成供运行时读取的 project-releases.md。

与 Jenkins 使用相同的首父链版本边界：S 是本次版本起点，B 是 S 的首父提交，
登记 B..HEAD 内的非合并 feat/fix（因此包含从旧版本 feature 合入的提交）。
服务登记可重复、按内容去重；仅完整成功的响应写入资源，失败不复用上轮版本说明。
项目登记身份使用根 POM artifactId；包内资源与展示模块固定为 project。
"""
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from threading import Event

import requests

from core.git_log import _find_starter_dir
from core.pom_reader import read_root_pom, strip_snapshot

DEFAULT_RELEASE_URL = "http://172.18.10.25:8080/app/release-notes/release"
DEFAULT_RELEASE_COUNT = 5
PROJECT_RELEASE_RELPATH = "src/main/resources/version/project-releases.md"
_CHANGE_PATTERN = re.compile(r"^(feat|fix)(?:\([^)]*\))?!?(?::\s*|\s+)(.+)$")


class ReleaseCancelled(Exception):
    """用户取消准备工作；必须向上传播，不能当作服务故障继续构建。"""


def _check_cancel(cancel: Event | None) -> None:
    if cancel is not None and cancel.is_set():
        raise ReleaseCancelled("已终止版本说明生成")


def _git(project_dir: str, *args: str, cancel: Event | None = None) -> str:
    _check_cancel(cancel)
    result = subprocess.run(
        ["git", *args], cwd=project_dir, capture_output=True, text=True,
        encoding="utf-8", errors="strict", timeout=60,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    _check_cancel(cancel)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "无法读取 Git 版本历史")
    return result.stdout.strip()


def _historical_poms(project_dir, revisions, prefix, cancel):
    """Read immutable POM blobs in batches, avoiding one Git process per revision."""
    for offset in range(0, len(revisions), 32):
        _check_cancel(cancel)
        batch = revisions[offset:offset + 32]
        result = subprocess.run(['git', 'cat-file', '--batch'], cwd=project_dir,
                                input=''.join(f'{revision}:{prefix}pom.xml\n' for revision in batch).encode('utf-8'),
                                capture_output=True, timeout=60,
                                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0)
        _check_cancel(cancel)
        if result.returncode:
            raise RuntimeError('无法批量读取 Git 版本历史')
        position = 0
        for revision in batch:
            end = result.stdout.find(b'\n', position)
            header = result.stdout[position:end].split()
            if end < 0 or len(header) != 3 or header[1] != b'blob':
                raise ValueError(f'历史 POM {revision[:12]} 无法读取')
            size = int(header[2])
            position = end + 1
            content = result.stdout[position:position + size]
            if len(content) != size:
                raise ValueError('Git 历史 POM 响应不完整')
            position += size + 1
            yield revision, content.decode('utf-8')


def _pom_version(pom: str, historical: bool = False) -> str | None:
    """当前 POM 要求明文版本；历史 ${revision} 视为无版本，返回 None，不解析属性。"""
    root = ET.fromstring(pom)
    versions = root.findall("{*}version")
    if not versions and historical:
        parents = root.findall("{*}parent")
        if len(parents) == 1:
            versions = parents[0].findall("{*}version")
    if len(versions) != 1:
        raise ValueError("POM 无法确定唯一明文版本")
    value = (versions[0].text or "").strip()
    if historical and value == "${revision}":
        return None
    if not value or "${" in value:
        raise ValueError("版本 POM 暂不支持属性版本或空版本")
    return strip_snapshot(value)


def collect_version_changes(
    project_dir: str, cancel: Event | None = None,
) -> tuple[str, str, list[dict[str, str]]]:
    """返回 (项目 artifactId, POM 版本原文, 本版全部变更)，无可靠边界则拒绝登记。"""
    artifact, version = read_root_pom(project_dir)
    # project 是包内资源模块名；服务按 artifactId 隔离多个同版本号的项目。
    module = artifact.lower()
    if not artifact or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,99}", module):
        raise ValueError("根 POM artifactId 无法生成有效的项目模块名")
    current = _pom_version((Path(project_dir) / "pom.xml").read_text(encoding="utf-8-sig"))
    if current != strip_snapshot(version):
        raise ValueError("根 POM 必须使用项目自身的显式明文版本")
    metadata = _git(project_dir, 'rev-parse', '--is-shallow-repository', 'HEAD', '--show-prefix', cancel=cancel).splitlines()
    if metadata[0] == "true":
        raise ValueError("版本日志需要完整 Git 历史，当前是浅克隆")

    # 固定本轮 HEAD；同时支持 Maven 根目录位于 Git 仓库子目录的情况。
    head = metadata[1]
    prefix = metadata[2] if len(metadata) > 2 else ''
    revisions = _git(project_dir, "log", "--first-parent", "--format=%H", head,
                     "--", "pom.xml", cancel=cancel).splitlines()
    start = None
    for revision, historical in _historical_poms(project_dir, revisions, prefix, cancel):
        try:
            historical_version = _pom_version(historical, historical=True)
        except (ValueError, ET.ParseError) as exc:
            raise ValueError(f"历史 POM {revision[:12]} 无法确定版本：{exc}") from exc
        # 历史 ${revision} 是未登记版本，到此停止；不能跨过它混入更早的同号版本。
        if historical_version is None or historical_version != current:
            break
        start = revision
    if start is None:
        raise ValueError("未找到当前版本起点，请先提交 POM 版本变更")
    ancestry = _git(project_dir, "rev-list", "--parents", "-n", "1", start, cancel=cancel).split()
    commit_range = f"{ancestry[1]}..{head}" if len(ancestry) > 1 else head
    subjects = _git(project_dir, "log", "--no-merges", "--reverse", "--format=%s",
                    commit_range, cancel=cancel)
    changes: list[dict[str, str]] = []
    seen: set[str] = set()
    for line in subjects.splitlines():
        subject = line.strip()
        match = _CHANGE_PATTERN.fullmatch(subject)
        if match and subject not in seen:
            seen.add(subject)
            changes.append({"type": match.group(1), "content": subject})
    # 服务负责去掉一次 SNAPSHOT；不能先去一次再传入，防止特殊历史版本二次截断。
    return module, version, changes


def _response_markdown(response: requests.Response, module: str, count: int) -> str:
    """同时校验 HTTP、业务码、模块与列表/正文一致性，错误页不可成为资源内容。"""
    if response.status_code != 200:
        raise ValueError(f"版本服务 HTTP {response.status_code}")
    result = response.json()
    if not isinstance(result, dict) or result.get("code") != 200:
        raise ValueError("版本服务未返回成功的业务响应")
    data = result.get("data")
    if (not isinstance(data, dict) or data.get("moduleName") != module
            or not isinstance(data.get("releases"), list) or len(data["releases"]) > count
            or not isinstance(data.get("markdown"), str)):
        raise ValueError("版本服务返回的模块、数量或 Markdown 格式不符合契约")
    markdown = data["markdown"].strip()
    if bool(data["releases"]) != bool(markdown):
        raise ValueError("版本列表与 Markdown 内容不一致")
    return markdown


def _project_display_markdown(markdown: str, artifact: str) -> str:
    """把服务返回的项目标题转为 project，正文和版本原文不变。

    服务用 artifactId 作为 moduleName 并转义其中的点、下划线、连字符。
    只替换行首的完整二级标题前缀，防止误改提交正文或相似项目名。
    """
    escaped_artifact = "".join("\\" + char if char in "._-" else char for char in artifact)
    prefix = f"## {escaped_artifact} "
    return "\n".join("## project " + line[len(prefix):] if line.startswith(prefix) else line
                     for line in markdown.splitlines())


def generate_project_releases(
    project_dir: str,
    service_url: str = DEFAULT_RELEASE_URL,
    count: int = DEFAULT_RELEASE_COUNT,
    cancel: Event | None = None,
    on_log=None,
) -> tuple[str, Path, list[str]]:
    """先清空旧资源，再分批登记；一般失败记录警告，取消或无法清空资源则阻止构建。

    HTTP 每次连接/读取超时为 3/30 秒。取消后不再发下一批或写入结果；已登记的
    条目不回滚，后续重报由服务去重。版本历史以当前 POM 为上限，默认返回 5 版。
    """
    target = _find_starter_dir(project_dir) / PROJECT_RELEASE_RELPATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("", encoding="utf-8")
    logs: list[str] = []
    def log(text):
        logs.append(text)
        if on_log:
            on_log(text)
    try:
        _check_cancel(cancel)
        if type(count) is not int or not 1 <= count <= 50:
            raise ValueError("版本数量必须在 1 至 50 之间")
        if not service_url.strip():
            raise ValueError("版本服务地址为空")
        module, version, changes = collect_version_changes(project_dir, cancel)
        log(f"[INFO] [project] 登记身份 {module}，当前版本 {version}，本版 feat/fix {len(changes)} 条")
        markdown = ""
        with requests.Session() as session:
            # 空变更也需请求：服务只查询已有历史，不会登记空版本。
            for offset in range(0, max(1, len(changes)), 500):
                _check_cancel(cancel)
                response = session.post(
                    service_url.strip().rstrip("/") + "/record",
                    json={"moduleName": module, "version": version, "count": count,
                          "changes": changes[offset:offset + 500]},
                    timeout=(3, 30), allow_redirects=False,
                )
                try:
                    markdown = _response_markdown(response, module, count)
                finally:
                    response.close()
        _check_cancel(cancel)
        markdown = _project_display_markdown(markdown, module)
    except ReleaseCancelled:
        raise
    except (OSError, ValueError, RuntimeError, ET.ParseError, subprocess.SubprocessError,
            requests.RequestException) as exc:
        _check_cancel(cancel)
        log(f"[WARN] 项目版本说明生成失败，继续构建：{exc}")
        return "", target, logs
    # 写入失败必须阻止打包，不能把可能写了一半的资源当作成功结果继续使用。
    target.write_text(markdown + "\n" if markdown else "", encoding="utf-8")
    log(f"[INFO] 项目版本说明已写入 {target}" if markdown
                else "[INFO] 版本服务暂无项目版本说明")
    return markdown, target, logs
