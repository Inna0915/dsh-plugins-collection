"""解析项目根目录 pom.xml，提取 artifactId 与 version（用于项目版本信息与 WAR 命名）。"""
import xml.etree.ElementTree as ET
from pathlib import Path

_SNAPSHOT = "-SNAPSHOT"


def read_root_pom(project_dir: str) -> tuple[str, str]:
    """
    解析 ``<project_dir>/pom.xml``，返回 ``(artifactId, version)``。

    - 命名空间无关（兼容带/不带 xmlns 的 pom）。
    - ``version`` 缺省（继承父 pom）时回退到 ``<parent><version>``。
    - 文件不存在或解析失败返回 ``("", "")``。
    """
    pom = Path(project_dir) / "pom.xml"
    if not pom.is_file():
        return "", ""
    try:
        root = ET.parse(pom).getroot()
    except ET.ParseError:
        return "", ""

    artifact = (root.findtext("{*}artifactId") or "").strip()
    version = (root.findtext("{*}version") or "").strip()
    if not version:
        version = (root.findtext("{*}parent/{*}version") or "").strip()
    return artifact, version


def strip_snapshot(version: str) -> str:
    """去掉版本号末尾的 ``-SNAPSHOT``。"""
    if version and version.endswith(_SNAPSHOT):
        return version[: -len(_SNAPSHOT)]
    return version
