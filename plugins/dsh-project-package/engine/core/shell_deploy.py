"""加壳流程模块：复制 WAR 到上传目录 → HTTP GET 触发（阻塞）→ 从完成目录获取结果。"""
import shutil
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

import requests


def find_war(project_dir: str) -> Optional[Path]:
    """在项目根目录的 -starter 子模块 target/ 下查找最新 WAR 文件。"""
    from core.project_layout import selected_target
    root = Path(project_dir)
    selected = selected_target(project_dir)
    if selected is not None:
        target = selected / "target"
        wars = [p for p in target.glob("*.war") if not p.name.endswith(".protect.war")]
        return max(wars, key=lambda p: p.stat().st_mtime) if wars else None
    try:
        starter_dirs = [p for p in root.iterdir() if p.is_dir() and p.name.endswith("-starter")]
    except OSError:
        return None
    search_dirs = starter_dirs if starter_dirs else [root]
    for d in search_dirs:
        target = d / "target"
        if target.is_dir():
            wars = list(target.glob("*.war"))
            if wars:
                return max(wars, key=lambda p: p.stat().st_mtime)
    return None


def build_packaged_name(
    src_stem: str,
    name: str,
    version: str,
    ts: str,
    test_version: bool = False,
) -> str:
    """构造上传/加壳产物的基础文件名（不含扩展名）：``名称-版本号-时间戳``。

    - ``name`` 为空时回退到 WAR 文件原 stem；
    - ``version`` 为空时省略该段。
    - ``test_version`` 为 True 时增加 ``test-`` 前缀。
    """
    base = name or src_stem
    if test_version and not base.startswith("test-"):
        base = f"test-{base}"
    parts = [base] + ([version] if version else []) + [ts]
    return "-".join(parts)


def run_shell(
    war_path: str,
    upload_dir: str,
    trigger_url: str,
    finish_dir: str,
    on_log: Callable[[str], None],
    on_finish: Callable[[int, Optional[str]], None],
    name: str = "",
    version: str = "",
    test_version: bool = False,
    packaged_stem: str = "",
) -> None:
    """在后台线程执行加壳流程。on_finish(returncode, output_path|None)。

    name/version 用于产物命名：``名称-版本号-时间戳.war``。
    """
    thread = threading.Thread(
        target=_worker,
        args=(
            war_path,
            upload_dir,
            trigger_url,
            finish_dir,
            on_log,
            on_finish,
            name,
            version,
            test_version,
            packaged_stem,
        ),
        daemon=True,
    )
    thread.start()


def _worker(
    war_path: str,
    upload_dir: str,
    trigger_url: str,
    finish_dir: str,
    on_log: Callable[[str], None],
    on_finish: Callable[[int, Optional[str]], None],
    name: str = "",
    version: str = "",
    test_version: bool = False,
    packaged_stem: str = "",
) -> None:
    try:
        src = Path(war_path)
        ts = datetime.now().strftime("%Y%m%d%H%M")
        new_stem = packaged_stem or build_packaged_name(src.stem, name, version, ts, test_version)
        new_name = f"{new_stem}.war"

        # 1. 复制到上传目录（含时间戳重命名）
        upload_path = Path(upload_dir) / new_name
        on_log(f"[INFO] 复制到上传目录: {upload_path}")
        shutil.copy2(str(src), str(upload_path))
        on_log("[INFO] 文件已复制，等待加壳服务响应…")

        # 2. HTTP GET 触发（阻塞直到加壳完成）
        on_log(f"[INFO] 触发加壳: {trigger_url}")
        try:
            resp = requests.get(trigger_url, timeout=600)
            resp.raise_for_status()
        except requests.Timeout:
            on_log("[ERROR] 加壳服务超时未响应（>600s）")
            on_finish(-1, None)
            return
        except requests.ConnectionError:
            on_log(f"[ERROR] 无法连接到加壳服务: {trigger_url}")
            on_finish(-1, None)
            return
        except requests.HTTPError as exc:
            on_log(f"[ERROR] 加壳服务返回错误: {exc}")
            on_finish(-1, None)
            return
        if resp.text:
            for line in resp.text.splitlines():
                on_log(line)
        on_log(f"[INFO] 加壳完成（HTTP {resp.status_code}），查找结果文件…")

        # 3. 从 finish 目录按上传文件名精确查找结果
        finish_path = Path(finish_dir)
        result_file = finish_path / new_name
        if not result_file.exists():
            on_log(f"[ERROR] finish 目录中未找到结果文件: {new_name}")
            on_finish(-1, None)
            return

        # 4. 复制到 WAR 同级目录，重命名为 <名称-版本号-时间戳>.protect.war
        out_path = src.parent / f"{new_stem}.protect.war"
        shutil.copy2(str(result_file), str(out_path))
        on_log(f"[SUCCESS] 已保存至: {out_path}")
        on_finish(0, str(out_path))

    except Exception as exc:
        on_log(f"[ERROR] 加壳异常: {exc}")
        on_finish(-1, None)
