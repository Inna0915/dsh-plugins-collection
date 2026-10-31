"""普通 Maven 打包、实时日志和可取消的进程生命周期。"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import threading
from typing import Callable

class BuildCancelled(Exception):
    pass


def check_cancelled(cancel: threading.Event) -> None:
    if cancel.is_set():
        raise BuildCancelled("已取消")


def _terminate_process_tree(proc: subprocess.Popen[str]) -> None:
    if proc.poll() is not None:
        return
    try:
        owned_terminate = getattr(type(proc), "terminate_tree", None)
        if owned_terminate is not None and owned_terminate(proc):
            pass
        elif sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                timeout=5, creationflags=subprocess.CREATE_NO_WINDOW,
            )
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except (OSError, subprocess.TimeoutExpired):
        if proc.poll() is None:
            proc.kill()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def run_build(
    project_dir: str,
    on_line: Callable[[str], None],
    on_finish: Callable[[int], None],
    *,
    cancel_event: threading.Event | None = None,
) -> Callable[[], None]:
    """沿用 Maven settings 和本地仓库；不会清理缓存或覆盖仓库选择。"""
    cancel = cancel_event if cancel_event is not None else threading.Event()
    state_lock = threading.Lock()
    processes: list[subprocess.Popen[str]] = []

    def stop() -> None:
        cancel.set()
        # 与“检查取消并创建进程”互斥，消除停止发生在 Popen 注册前的窗口。
        with state_lock:
            proc = processes[0] if processes else None
        if proc is not None:
            _terminate_process_tree(proc)

    def worker() -> None:
        returncode = -1
        proc = None
        try:
            check_cancelled(cancel)
            env = os.environ.copy()
            mvn_path = shutil.which("mvn")
            if not mvn_path:
                raise FileNotFoundError("未找到 Maven")
            try:
                check_cancelled(cancel)
                on_line("[INFO] 普通 Maven 构建：使用现有仓库配置，检查 SNAPSHOT 更新")
                cmd = [mvn_path, "-B", "-U",
                       "clean", "install", "-Dmaven.test.skip=true"]
                # 保留证书/代理等既有 JVM 配置，仅追加输出编码。
                env["JAVA_TOOL_OPTIONS"] = (env.get("JAVA_TOOL_OPTIONS", "")
                    + " -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8").strip()
                kwargs: dict = {}
                if sys.platform == "win32":
                    kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
                else:
                    kwargs["start_new_session"] = True
                with state_lock:
                    check_cancelled(cancel)
                    proc = subprocess.Popen(
                        cmd, cwd=project_dir, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        text=True, encoding="utf-8", errors="replace", env=env, **kwargs,
                    )
                    processes.append(proc)
                on_line(f"[INFO] Maven 进程 PID：{proc.pid}")
                for line in proc.stdout:
                    if line.startswith(("Picked up JAVA_TOOL_OPTIONS:", "Picked up _JAVA_OPTIONS:",
                                        "NOTE: Picked up JDK_JAVA_OPTIONS:")):
                        on_line("[INFO] 已加载 JVM 环境参数（省略参数值）")
                    else:
                        on_line(line.rstrip())
                returncode = proc.wait(timeout=5)
                if cancel.is_set():
                    returncode = -1
                on_line(f"[INFO] Maven 结束，返回码：{returncode}")
            finally:
                if proc is not None:
                    _terminate_process_tree(proc)
                    if proc.stdout is not None:
                        proc.stdout.close()
        except Exception as exc:
            returncode = -1
            if isinstance(exc, BuildCancelled):
                message = "[INFO] 打包已取消，未继续构建"
            elif isinstance(exc, FileNotFoundError) and proc is None:
                message = f"[ERROR] Maven 或必要文件不存在：{exc}"
            else:
                message = f"[ERROR] Maven 构建失败：{exc}"
            try:
                on_line(message)
            except Exception:
                pass  # UI 已关闭时仍须回收构建进程。
        finally:
            on_finish(returncode)

    threading.Thread(target=worker, daemon=True).start()
    return stop
