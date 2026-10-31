"""从 starter 模块的 target/app/WEB-INF/lib 中读取产品版本说明。"""
import re
import zipfile
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

# (jar glob 模式, jar 内版本说明文件路径, 模块名)
# 版本号文件 = 版本说明文件名加 -version 后缀（Jenkins 打包发布后自动生成），
# 例如 version/wms.md → version/wms-version.md
PRODUCT_JARS: list[tuple[str, str, str]] = [
    ("wms-front-*.jar",    "version/wms-front.md", "wms-front"),
    # wms-10 后端统一在 wms-platform 中生成版本说明与版本号。
    ("wms-platform-*.jar", "version/wms.md",       "wms"),
    ("fms-front-*.jar",    "version/fms-front.md", "fms-front"),
    # FMS 后端发布资源由 fms-warehouse 携带，不是 fms-platform。
    ("fms-warehouse-*.jar", "version/fms.md",       "fms"),
]

_DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class _Entry:
    date: date
    module: str
    description: str


@dataclass
class ProductNotes:
    """产品资源的读取结果；版本说明与日期记录分开，供组合层选择一种展示模式。"""
    entries: list[_Entry] = field(default_factory=list)
    versions: dict[str, str] = field(default_factory=dict)
    releases: dict[str, str] = field(default_factory=dict)
    logs: list[str] = field(default_factory=list)


def _find_starter_dir(project_dir: str) -> Path | None:
    """找项目根目录下名称以 '-starter' 结尾的一级子目录。"""
    from core.project_layout import selected_target
    selected = selected_target(project_dir)
    if selected is not None:
        return selected
    root = Path(project_dir)
    candidates = [p for p in root.iterdir() if p.is_dir() and p.name.endswith("-starter")]
    return candidates[0] if candidates else None


def _read_zip_entry(jar_path: Path, entry: str) -> str:
    """读取 jar 内指定条目，失败时返回空字符串。"""
    try:
        with zipfile.ZipFile(jar_path, "r") as zf:
            if entry in zf.namelist():
                return zf.read(entry).decode("utf-8-sig")
    except (zipfile.BadZipFile, OSError, UnicodeError, RuntimeError, NotImplementedError):
        pass
    return ""


def _parse_module(module: str, text: str) -> list[_Entry]:
    """将版本文件文本解析为 _Entry 列表（参照 Jenkins 生成格式）。"""
    entries: list[_Entry] = []
    current_date: date | None = None
    for line in text.splitlines():
        if not line or not line.strip():
            continue
        stripped = line.strip()
        if _DATE_PATTERN.match(stripped):
            try:
                current_date = date.fromisoformat(stripped)
            except ValueError:
                current_date = None
            continue
        if line.startswith("  ") and current_date is not None:
            entries.append(_Entry(current_date, module, stripped))
    return entries


def _first_nonblank(text: str) -> str:
    """取文本首个非空行（trim）；无内容返回空串。用于解析一行版本号。"""
    if not text:
        return ""
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def collect_product_notes(project_dir: str, project_has_releases: bool = False) -> ProductNotes:
    """先读所有产品的版本资源；项目或任一产品有版本说明时，全局不加载日期记录。

    缺失、空白或无法读取的 releases 资源不算启用版本说明。版本号始终独立读取，
    产品范围和顺序仍由 PRODUCT_JARS 决定，资源文件名由旧说明文件派生。
    """
    starter = _find_starter_dir(project_dir)
    lib_dir = (starter / "target" / "app" / "WEB-INF" / "lib") if starter else None

    result = ProductNotes()
    logs = result.logs
    sources: list[tuple[Path, str, str]] = []
    families: set[str] = set()
    if lib_dir is not None and lib_dir.is_dir():
        families = {
            jar.name.split("-", 1)[0]
            for jar in lib_dir.glob("*.jar")
            if jar.name.startswith(("wms-", "fms-"))
        }

    for glob_pattern, md_entry, module in PRODUCT_JARS:
        # 只报告当前项目实际使用的产品家族，混合依赖则同时读取。
        if families and glob_pattern.split("-", 1)[0] not in families:
            continue
        if lib_dir is None or not lib_dir.is_dir():
            logs.append(f"[WARN] [{module}] 未找到 -starter 模块或 lib 目录不存在")
            continue

        matches = [
            p for p in lib_dir.glob(glob_pattern)
            if not any(t in p.name for t in ("-sources", "-javadoc", "-tests"))
        ]
        if not matches:
            logs.append(f"[WARN] [{module}] lib 中未找到 {glob_pattern}")
            continue

        jar_path = matches[0]
        sources.append((jar_path, md_entry, module))
        release_entry = md_entry.removesuffix(".md") + "-releases.md"
        markdown = _read_zip_entry(jar_path, release_entry).strip()
        if markdown:
            result.releases[module] = markdown
            logs.append(f"[INFO] [{module}] 已读取 {release_entry}")

        # 版本号：与版本说明同名加 -version 后缀（version/wms.md → version/wms-version.md）
        version_entry = md_entry.removesuffix(".md") + "-version.md"
        version = _first_nonblank(_read_zip_entry(jar_path, version_entry))
        if version:
            result.versions[module] = version
            logs.append(f"[INFO] [{module}] 版本号 {version}")
        else:
            logs.append(f"[WARN] [{module}] {jar_path.name} 中无 {version_entry}")

    if not project_has_releases and not result.releases:
        for jar_path, md_entry, module in sources:
            content = _read_zip_entry(jar_path, md_entry)
            if content:
                entries = _parse_module(module, content)
                if entries:
                    logs.append(f"[INFO] [{module}] {jar_path.name}  解析到 {len(entries)} 条记录")
                    result.entries.extend(entries)
                else:
                    logs.append(f"[WARN] [{module}] {jar_path.name}  版本说明解析无结果")
            else:
                logs.append(f"[WARN] [{module}] {jar_path.name} 中无 {md_entry}")
    return result


def collect_product_data(project_dir: str) -> tuple[list[_Entry], dict[str, str], list[str]]:
    """保留旧读取接口；需要版本说明的调用方使用 collect_product_notes。"""
    result = collect_product_notes(project_dir)
    return result.entries, result.versions, result.logs

