"""环境检测模块：检查 git / mvn / python 是否已安装。"""
import shutil
import subprocess
import sys
from dataclasses import dataclass


@dataclass
class EnvStatus:
    name: str
    available: bool
    version: str = ""


def _get_version(cmd: list[str]) -> str:
    try:
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=5,
            creationflags=flags,
        )
        return (result.stdout + result.stderr).strip().splitlines()[0]
    except Exception:
        return ""


def check_env() -> list[EnvStatus]:
    """检测 git、mvn、python 是否可用，返回状态列表。"""
    items = [
        ("git",    ["git",    "--version"]),
        ("mvn",    ["mvn",    "--version"]),
        ("python", ["python", "--version"]),
    ]
    results: list[EnvStatus] = []
    for name, version_cmd in items:
        found = shutil.which(name) is not None
        version = _get_version(version_cmd) if found else ""
        results.append(EnvStatus(name=name, available=found, version=version))
    return results
