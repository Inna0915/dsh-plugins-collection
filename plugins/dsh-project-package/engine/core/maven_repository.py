"""沿用 Maven 仓库配置，查询指定坐标的远端身份及校验值。"""
from __future__ import annotations

import os
import re
import shlex
import shutil
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event
from urllib.parse import quote, urlparse

import requests

from core.dependency_inventory import Dependency
from core.maven_build import check_cancelled


class RepositoryError(RuntimeError):
    pass


class AuthenticationError(RepositoryError):
    pass


@dataclass
class Repository:
    id: str
    url: str
    auth: tuple[str, str] | None = field(default=None, repr=False)
    proxies: dict = field(default_factory=dict, repr=False)

    @property
    def identity(self):
        return self.id + "|" + self.url.rstrip("/")


def settings_paths(project: str) -> list[Path]:
    mvn = shutil.which("mvn")
    paths = [Path(mvn).resolve().parent.parent / "conf/settings.xml"] if mvn else []
    paths.append(Path.home() / ".m2/settings.xml")
    config = Path(project) / ".mvn/maven.config"
    tokens = shlex.split(config.read_text(encoding="utf-8-sig"), posix=True) if config.is_file() else []
    tokens += shlex.split(os.environ.get("MAVEN_ARGS", ""), posix=True)
    for i, token in enumerate(tokens):
        slot = 0 if token in ("-gs", "--global-settings") else 1
        if token in ("-s", "--settings", "-gs", "--global-settings") and i + 1 < len(tokens):
            path = Path(tokens[i + 1])
            path = path if path.is_absolute() else Path(project) / path
            while len(paths) < 2:
                paths.insert(0, Path("__missing_settings__"))
            paths[slot] = path
        elif token.startswith(("--settings=", "--global-settings=")):
            slot = 0 if token.startswith("--global") else 1
            path = Path(token.split("=", 1)[1])
            paths[slot] = path if path.is_absolute() else Path(project) / path
    return paths


def _expanded(value: str) -> str:
    def replace(match):
        key = match.group(1)
        if key == "user.home":
            return str(Path.home())
        return os.environ.get(key[4:], match.group()) if key.startswith("env.") else match.group()
    return re.sub(r"\$\{([^}]+)\}", replace, value)


def _values(node) -> dict[str, str]:
    return {child.tag.rsplit("}", 1)[-1]: _expanded(child.text or "").strip() for child in node}


def read_repositories(project: str) -> list[Repository]:
    servers, mirrors, repositories, profiles = {}, {}, {}, {}
    active = set()
    proxies = {}
    for path in settings_paths(project):
        if not path.is_file():
            continue
        try:
            xml = ET.fromstring(path.read_text(encoding="utf-8-sig"))
        except (UnicodeError, ET.ParseError) as exc:
            raise RepositoryError(f"无法读取 Maven 配置：{path.name}") from exc
        for node in xml.findall("{*}servers/{*}server"):
            values = _values(node)
            servers[values.get("id", "")] = values
        for node in xml.findall("{*}mirrors/{*}mirror"):
            values = _values(node)
            mirrors[values.get("id", "")] = values
        for node in xml.findall("{*}profiles/{*}profile"):
            profiles[node.findtext("{*}id", "")] = node
        active.update(n.text for n in xml.findall("{*}activeProfiles/{*}activeProfile"))
        for node in xml.findall("{*}proxies/{*}proxy"):
            values = _values(node)
            if values.get("active", "true") == "false":
                continue
            protocol = values.get("protocol", "http")
            credentials = ""
            if values.get("username"):
                credentials = quote(values["username"], safe="") + ":" + quote(values.get("password", ""), safe="") + "@"
            proxies[protocol] = f"{protocol}://{credentials}{values.get('host', '')}:{values.get('port', '8080')}"
            # nonProxyHosts is applied per target below.
            proxies["_non_proxy_hosts"] = values.get("nonProxyHosts", "")
    for key, profile in profiles.items():
        if key in active or profile.findtext("{*}activation/{*}activeByDefault") == "true":
            for node in profile.findall("{*}repositories/{*}repository"):
                values = _values(node)
                if node.findtext("{*}snapshots/{*}enabled", "true") != "false":
                    repositories[values.get("id", "")] = values
    # mirrorOf=* 是当前环境的唯一有效远端；否则交由用户在已配置源中选定。
    wildcard = next((v for v in mirrors.values() if v.get("mirrorOf") == "*"), None)
    candidates = [wildcard] if wildcard else list(mirrors.values()) + list(repositories.values())
    result = []
    seen = set()
    for values in candidates:
        if not values or not values.get("url") or values.get("blocked") == "true":
            continue
        repo_id, url = values["id"], values["url"].rstrip("/")
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or parsed.query:
            continue
        if (repo_id, url) in seen:
            continue
        seen.add((repo_id, url))
        server = servers.get(repo_id, {})
        username, password = server.get("username", ""), server.get("password", "")
        auth = (username, password) if username and password else None
        if auth and (password.startswith("{") or "${" in password or "${" in username):
            auth = None
        target_proxies = {k: v for k, v in proxies.items() if not k.startswith("_")}
        for pattern in proxies.get("_non_proxy_hosts", "").split("|"):
            if pattern and re.fullmatch(re.escape(pattern).replace(r"\*", ".*"), parsed.hostname or "", re.I):
                target_proxies = {"http": None, "https": None}
        result.append(Repository(repo_id, url, auth, target_proxies))
    return result


def _request(session, url: str, repo: Repository, cancel: Event, method="GET", optional=False):
    check_cancelled(cancel)
    try:
        response = session.request(method, url, auth=repo.auth, proxies=repo.proxies,
                                   timeout=(3, 10), allow_redirects=False, stream=True)
    except requests.RequestException as exc:
        raise RepositoryError("仓库连接失败或超时") from exc
    if response.status_code in (401, 403):
        response.close()
        raise AuthenticationError("仓库认证失败，请检查 Maven server 或连接配置")
    if optional and response.status_code in (404, 405):
        response.close()
        return None
    if response.status_code != 200:
        code = response.status_code
        response.close()
        raise RepositoryError(f"仓库 HTTP {code}，发布待确认")
    return response


def _small_text(response, cancel: Event, limit=65536) -> str:
    try:
        chunks, size = [], 0
        for chunk in response.iter_content(4096):
            check_cancelled(cancel)
            size += len(chunk)
            if size > limit:
                raise RepositoryError("仓库响应超出预期大小")
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8-sig")
    finally:
        response.close()


def remote_artifact(dep: Dependency, repo: Repository, cancel: Event, session=None, _attempt=0) -> dict:
    owns_session = session is None
    session = session or requests.Session()
    try:
        for value in (dep.group, dep.artifact, dep.version, dep.extension, dep.classifier):
            if value and not re.fullmatch(r"[A-Za-z0-9_.-]+", value):
                raise RepositoryError("依赖坐标包含不支持的字符")
        base = repo.url.rstrip("/") + "/" + dep.group.replace(".", "/") + f"/{dep.artifact}/{dep.version}/"
        identity, updated = dep.version, ""
        if dep.version.endswith("-SNAPSHOT"):
            response = _request(session, base + "maven-metadata.xml", repo, cancel)
            try:
                xml = ET.fromstring(_small_text(response, cancel))
            except (ET.ParseError, UnicodeError) as exc:
                raise RepositoryError("远端 metadata 无效") from exc
            for tag, expected in (("groupId", dep.group), ("artifactId", dep.artifact), ("version", dep.version)):
                if xml.findtext(tag) != expected:
                    raise RepositoryError("远端 metadata 坐标不匹配")
            versions = xml.findall("versioning/snapshotVersions/snapshotVersion")
            matching = [v for v in versions if v.findtext("extension") == dep.extension
                        and v.findtext("classifier", "") == dep.classifier]
            if matching:
                selected = max(matching, key=lambda v: v.findtext("updated", ""))
                identity = selected.findtext("value", "")
                updated = selected.findtext("updated", "")
            elif not versions:
                timestamp = xml.findtext("versioning/snapshot/timestamp", "")
                number = xml.findtext("versioning/snapshot/buildNumber", "")
                identity = dep.version[:-len("SNAPSHOT")] + timestamp + "-" + number
            else:
                raise RepositoryError("远端尚未发布对应类型的制品")
            pattern = re.escape(dep.version[:-len("SNAPSHOT")]) + r"\d{8}\.\d{6}-\d+"
            if not re.fullmatch(pattern, identity):
                raise RepositoryError("远端 SNAPSHOT 身份无效")
        filename = f"{dep.artifact}-{identity}{'-' + dep.classifier if dep.classifier else ''}.{dep.extension}"
        url = base + filename
        checksum, algorithm = "", ""
        for algorithm in ("sha256", "sha1"):
            response = _request(session, url + "." + algorithm, repo, cancel, optional=True)
            if response is None:
                continue
            tokens = _small_text(response, cancel, 4096).strip().split()
            checksum = tokens[0] if tokens else ""
            if not re.fullmatch(r"[a-fA-F0-9]{" + str(64 if algorithm == "sha256" else 40) + "}", checksum):
                raise RepositoryError("远端校验值格式无效")
            break
        if not checksum:
            raise RepositoryError("仓库未提供 SHA-256/SHA-1，无法核验")
        response = _request(session, url, repo, cancel, method="HEAD", optional=True)
        if response is None:
            # 流式 GET 仅验证可访问，立即关闭，不下载完整产品。
            response = _request(session, url, repo, cancel)
        response.close()
        if dep.version.endswith("-SNAPSHOT"):
            response = _request(session, base + "maven-metadata.xml", repo, cancel)
            try:
                latest = ET.fromstring(_small_text(response, cancel))
            except (ET.ParseError, UnicodeError) as exc:
                raise RepositoryError("发布期间 metadata 无效") from exc
            latest_entries = [v for v in latest.findall("versioning/snapshotVersions/snapshotVersion")
                              if v.findtext("extension") == dep.extension and v.findtext("classifier", "") == dep.classifier]
            if latest_entries:
                latest_identity = max(latest_entries, key=lambda v: v.findtext("updated", "")).findtext("value")
            else:
                latest_identity = dep.version[:-len("SNAPSHOT")] + latest.findtext("versioning/snapshot/timestamp", "") + "-" + latest.findtext("versioning/snapshot/buildNumber", "")
            if latest_identity != identity:
                if _attempt >= 1:
                    raise RepositoryError("制品正在持续发布，稍后重新核验")
                return remote_artifact(dep, repo, cancel, session, _attempt + 1)
        return {"repository": repo.identity, "identity": identity, "updated": updated,
                "algorithm": algorithm, "checksum": checksum.lower(), "url": url}
    finally:
        if owns_session:
            session.close()
