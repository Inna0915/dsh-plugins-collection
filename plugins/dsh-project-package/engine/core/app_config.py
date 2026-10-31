"""应用配置持久化与旧版临时配置迁移。"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from core.release_notes import DEFAULT_RELEASE_COUNT, DEFAULT_RELEASE_URL

MAX_RECENT_PROJECTS = 10
RELEASE_DEFAULTS: dict[str, Any] = {"url": DEFAULT_RELEASE_URL, "count": DEFAULT_RELEASE_COUNT}

SHELL_DEFAULTS: dict[str, Any] = {
    "enabled": True,
    "auto_shell": True,
    "test_version": False,
    "upload_dir": r"\\192.168.10.173\软件部\auto-package\work",
    "trigger_url": "http://172.18.10.47/auto/package/encrypt",
    "finish_dir": r"\\192.168.10.173\软件部\auto-package\finish",
}


def default_config_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    base = Path(local_app_data) if local_app_data else Path.home() / "AppData" / "Local"
    return base / "PackageTool" / "config.json"


def default_legacy_last_dir_path() -> Path:
    return Path(tempfile.gettempdir()) / "project_package_last_dir.txt"


def default_legacy_shell_path() -> Path:
    return Path(tempfile.gettempdir()) / "project_package_shell_cfg.json"


def default_legacy_release_path() -> Path:
    return Path(tempfile.gettempdir()) / "project_package_release_cfg.json"


@dataclass
class AppConfig:
    recent_projects: list[str] = field(default_factory=list)
    shell: dict[str, Any] = field(default_factory=lambda: dict(SHELL_DEFAULTS))
    release: dict[str, Any] = field(default_factory=lambda: dict(RELEASE_DEFAULTS))

    def to_dict(self) -> dict[str, Any]:
        return {
            "recent_projects": list(self.recent_projects),
            "shell": dict(self.shell),
            "release": dict(self.release),
        }


def _path_key(path: str) -> str:
    return os.path.normcase(os.path.normpath(path))


def _normalize_existing_directory(path: object) -> str | None:
    if not isinstance(path, str) or not path.strip():
        return None
    candidate = Path(path.strip()).expanduser()
    try:
        if not candidate.is_dir():
            return None
        return str(candidate.resolve())
    except OSError:
        return None


def normalize_recent_projects(
    paths: Iterable[object],
    limit: int = MAX_RECENT_PROJECTS,
) -> list[str]:
    """过滤无效目录并按输入顺序去重，最多保留 ``limit`` 个。"""
    result: list[str] = []
    seen: set[str] = set()
    for raw in paths:
        normalized = _normalize_existing_directory(raw)
        if normalized is None:
            continue
        key = _path_key(normalized)
        if key in seen:
            continue
        seen.add(key)
        result.append(normalized)
        if len(result) >= limit:
            break
    return result


def remember_project(recent_projects: Iterable[object], path: str) -> list[str]:
    """把有效目录放到最近记录首位；无效目录不会进入记录。"""
    return normalize_recent_projects([path, *recent_projects])


def _normalize_shell(data: object) -> dict[str, Any]:
    result = dict(SHELL_DEFAULTS)
    if not isinstance(data, dict):
        return result
    for key, default in SHELL_DEFAULTS.items():
        value = data.get(key)
        if isinstance(value, type(default)):
            result[key] = value
    return result


def _config_from_data(data: object) -> AppConfig:
    if not isinstance(data, dict):
        return AppConfig()
    recent = data.get("recent_projects", [])
    if not isinstance(recent, list):
        recent = []
    return AppConfig(
        recent_projects=normalize_recent_projects(recent),
        shell=_normalize_shell(data.get("shell")),
        release=_normalize_release(data.get("release")),
    )


def _normalize_release(data: object) -> dict[str, Any]:
    result = dict(RELEASE_DEFAULTS)
    if not isinstance(data, dict):
        return result
    url = data.get("url")
    count = data.get("count")
    if isinstance(url, str):
        result["url"] = url.strip()
    if type(count) is int and 1 <= count <= 50:
        result["count"] = count
    return result


def _read_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def save_config(config: AppConfig, config_path: Path | None = None) -> Path:
    """原子写入配置，返回实际配置路径。"""
    path = config_path or default_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        temp_path.write_text(
            json.dumps(config.to_dict(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        temp_path.replace(path)
    finally:
        try:
            temp_path.unlink(missing_ok=True)
        except OSError:
            pass
    return path


def load_config(
    config_path: Path | None = None,
    legacy_last_dir_path: Path | None = None,
    legacy_shell_path: Path | None = None,
    legacy_release_path: Path | None = None,
) -> AppConfig:
    """读取统一配置，并迁移旧目录、加壳和版本服务临时配置。"""
    path = config_path or default_config_path()
    legacy_release = legacy_release_path or default_legacy_release_path()
    if path.exists():
        data = _read_json(path)
        config = _config_from_data(data)
        if isinstance(data, dict) and "release" not in data:
            config.release = _normalize_release(_read_json(legacy_release))
            try:
                save_config(config, path)
            except OSError:
                pass
        return config

    legacy_last = legacy_last_dir_path or default_legacy_last_dir_path()
    legacy_shell = legacy_shell_path or default_legacy_shell_path()
    recent: list[object] = []
    try:
        recent.append(legacy_last.read_text(encoding="utf-8").strip())
    except (OSError, UnicodeError):
        pass

    shell = _normalize_shell(_read_json(legacy_shell))
    config = AppConfig(
        recent_projects=normalize_recent_projects(recent),
        shell=shell,
        release=_normalize_release(_read_json(legacy_release)),
    )
    try:
        save_config(config, path)
    except OSError:
        pass
    return config
