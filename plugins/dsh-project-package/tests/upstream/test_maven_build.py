"""异步 Maven 的命令、锁交接、错误和取消；不运行业务构建。"""
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import Mock, patch

from core.maven_build import run_build


class MavenBuildTest(unittest.TestCase):
    def setUp(self):
        self.native_environment = os.environ.copy()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name) / "project with spaces"
        self.project.mkdir()
        self.repo = Path(self.temp.name) / "app with spaces" / "maven-repository"
        for patcher in (
            patch("core.maven_build.shutil.which", return_value="mvn.cmd"),
            patch.dict(os.environ, {"JAVA_TOOL_OPTIONS": "-Dexisting=true"}, clear=True),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        self.done = Event()
        self.results = []
        self.lines = []
        self.proc = Mock()
        self.proc.stdout = io.StringIO("building\n")
        self.proc.wait.return_value = 0
        self.proc.poll.return_value = 0

    def finish(self, result):
        self.results.append(result)
        self.done.set()

    def wait(self):
        self.assertTrue(self.done.wait(5), "构建线程未在 5 秒内完成")
        self.assertEqual(len(self.results), 1)

    def test_command_uses_existing_repository_and_preserves_jvm_options(self):
        with patch("core.maven_build.subprocess.Popen", return_value=self.proc) as popen:
            run_build(str(self.project), self.lines.append, self.finish)
            self.wait()
        cmd = popen.call_args.args[0]
        self.assertFalse(any(arg.startswith("-Dmaven.repo.local=") for arg in cmd))
        self.assertEqual(cmd[-3:], ["clean", "install", "-Dmaven.test.skip=true"])
        self.assertIn("-U", cmd)
        self.assertFalse(popen.call_args.kwargs.get("shell", False))
        self.assertIn("-Dexisting=true", popen.call_args.kwargs["env"]["JAVA_TOOL_OPTIONS"])
        self.assertIn("building", self.lines)
        self.assertEqual(self.results, [0])
        self.assertTrue(self.proc.stdout.closed)

    def test_missing_maven_does_not_create_cache(self):
        with patch("core.maven_build.shutil.which", return_value=None), \
                patch("core.maven_build.subprocess.Popen") as popen:
            run_build(str(self.project), self.lines.append, self.finish)
            self.wait()
        popen.assert_not_called()
        self.assertFalse(self.repo.exists())

    def test_existing_offline_config_is_left_to_maven(self):
        (self.project / ".mvn").mkdir()
        (self.project / ".mvn" / "maven.config").write_text("--offline", encoding="utf-8")
        with patch("core.maven_build.subprocess.Popen", return_value=self.proc) as popen:
            run_build(str(self.project), self.lines.append, self.finish)
            self.wait()
        popen.assert_called_once()
        self.assertEqual(self.results, [0])

    def test_pre_cancelled_build_never_initializes_cache(self):
        cancel = Event()
        cancel.set()
        with patch("core.maven_build.subprocess.Popen") as popen:
            run_build(str(self.project), self.lines.append, self.finish, cancel_event=cancel)
            self.wait()
        popen.assert_not_called()
        self.assertFalse(self.repo.exists())

    def test_cancel_after_cleanup_before_spawn(self):
        cancel = Event()

        def log(line):
            if "普通 Maven" in line:
                cancel.set()

        with patch("core.maven_build.subprocess.Popen") as popen:
            run_build(str(self.project), log, self.finish, cancel_event=cancel)
            self.wait()
        popen.assert_not_called()
        self.assertEqual(self.results, [-1])

    def test_maven_nonzero_exit_is_not_retried(self):
        self.proc.wait.return_value = 17
        self.proc.poll.return_value = 17
        with patch("core.maven_build.subprocess.Popen", return_value=self.proc) as popen:
            run_build(str(self.project), self.lines.append, self.finish)
            self.wait()
        self.assertEqual(popen.call_count, 1)
        self.assertEqual(self.results, [17])

    def test_jvm_environment_echo_does_not_expose_values(self):
        self.proc.stdout = io.StringIO(
            "Picked up JAVA_TOOL_OPTIONS: -Dpassword=secret\n"
            "Picked up _JAVA_OPTIONS: -Dpassword=secret\n"
            "NOTE: Picked up JDK_JAVA_OPTIONS: -Dpassword=secret\n"
        )
        with patch("core.maven_build.subprocess.Popen", return_value=self.proc):
            run_build(str(self.project), self.lines.append, self.finish)
            self.wait()
        self.assertNotIn("secret", "\n".join(self.lines))

    def test_start_failure_unlocks_cache(self):
        with patch("core.maven_build.subprocess.Popen", side_effect=OSError("cannot start")):
            run_build(str(self.project), self.lines.append, self.finish)
            self.wait()
        self.assertEqual(self.results, [-1])

    def test_callback_failure_still_cleans_process_and_unlocks(self):
        def log(line):
            if line == "building":
                raise RuntimeError("UI gone")

        with patch("core.maven_build.subprocess.Popen", return_value=self.proc), \
                patch("core.maven_build._terminate_process_tree") as terminate:
            run_build(str(self.project), log, self.finish)
            self.wait()
        terminate.assert_called_once_with(self.proc)
        self.assertTrue(self.proc.stdout.closed)
        self.assertEqual(self.results, [-1])

    @unittest.skipUnless(os.name == "nt", "Windows process tree")
    def test_stop_reaps_real_process_tree_before_releasing_cache(self):
        import ctypes
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        kernel.TerminateProcess.restype = wintypes.BOOL
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        child_exited_before_fallback = []
        native_popen = subprocess.Popen
        started = Event()
        child_handles = []
        roots = []
        code = (
            "import subprocess,sys,time; "
            "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
            "print('CHILD_PID='+str(child.pid),flush=True); time.sleep(60)"
        )

        def start(cmd, **kwargs):
            if cmd[0] == "mvn.cmd":
                proc = native_popen([sys.executable, "-u", "-c", code], **kwargs)
                roots.append(proc)
                return proc
            return native_popen(cmd, **kwargs)

        def log(line):
            if line.startswith("CHILD_PID="):
                # 在子进程仍存活时持有内核句柄，清理不再使用可能复用的旧 PID。
                handle = kernel.OpenProcess(0x00100001, False, int(line.split("=", 1)[1]))
                if handle:
                    child_handles.append(handle)
                started.set()

        with patch.dict(os.environ, self.native_environment, clear=True), \
                patch("core.maven_build.subprocess.Popen", side_effect=start):
            stop = run_build(str(self.project), log, self.finish)
            try:
                self.assertTrue(started.wait(10), "child did not start")
            finally:
                stop()
                self.assertTrue(self.done.wait(15), "cancel did not finish")
                for handle in child_handles:
                    try:
                        exited = kernel.WaitForSingleObject(handle, 3000) == 0
                        child_exited_before_fallback.append(exited)
                        if not exited:
                            kernel.TerminateProcess(handle, 1)
                            kernel.WaitForSingleObject(handle, 5000)
                    finally:
                        kernel.CloseHandle(handle)
        self.assertEqual(self.results, [-1])
        self.assertIsNotNone(roots[0].poll())
        self.assertEqual(len(child_handles), 1)
        self.assertEqual(child_exited_before_fallback, [True])


if __name__ == "__main__":
    unittest.main()
