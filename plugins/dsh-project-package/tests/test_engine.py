import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch, Mock

from discovery import discover, project_info
from core.app_config import AppConfig
from core.project_layout import set_target
from core.shell_deploy import find_war
from service import PackageService
from maven_preflight import running_maven


def pom(root, artifact="demo", packaging="pom", modules=()):
    root.mkdir(parents=True, exist_ok=True)
    text = '<project><modelVersion>4.0.0</modelVersion><groupId>test</groupId><artifactId>'+artifact+'</artifactId><version>1.0-SNAPSHOT</version><packaging>'+packaging+'</packaging><modules>'+''.join('<module>'+m+'</module>' for m in modules)+'</modules></project>'
    (root / "pom.xml").write_text(text, encoding="utf-8")


def business_project(root, artifact="fms-p275", stem="fms-project", declared=True):
    names = [stem + "-module", stem + "-starter"]
    pom(root, artifact, modules=names if declared else [])
    pom(root / names[0], names[0], "jar")
    pom(root / names[1], names[1], "war")


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_nested_reactor_and_multiple_outputs(self):
        project = self.root / "repo"
        business_project(project)
        pom(project, "fms-p275", modules=["fms-project-module", "fms-project-starter", "two"])
        pom(project / "two", "two", "war")
        pom(self.root / "node_modules" / "ignored")
        result = discover([{"path": str(self.root), "title": "Workspace"}, {"path": str(project / "fms-project-starter")}], [])
        self.assertEqual([p["path"] for p in result["projects"]], [str(project)])
        self.assertEqual(len(result["projects"][0]["targets"]), 2)

    def test_invalid_pom_not_a_project(self):
        (self.root / "pom.xml").write_text("not xml")
        self.assertEqual(discover([{"path": str(self.root)}], [str(self.root)])["projects"], [])

    def test_multiple_repos_not_flattened_into_one(self):
        business_project(self.root / "a", "fms-project-269")
        business_project(self.root / "b", "wms-p277", "wms-p277")
        result = discover([{"path": str(self.root)}], [])
        self.assertEqual({p["artifact"] for p in result["projects"]}, {"fms-project-269", "wms-p277"})

    def test_libraries_demos_and_recent_libraries_are_filtered(self):
        for name, packaging in [("fms-parent", "pom"), ("fms-front", "jar"), ("gaia-demo", "war"), ("gaia-starter", "jar"), ("wms-p999", "pom")]:
            pom(self.root / name, name, packaging)
        business_project(self.root / "valid")
        result = discover([{"path": str(self.root)}], [str(self.root / "gaia-demo")])
        self.assertEqual([p["artifact"] for p in result["projects"]], ["fms-p275"])
        self.assertEqual(project_info(self.root / "gaia-demo")["targets"][0]["artifact"], "gaia-demo")

    def test_metadata_root_infers_real_modules_and_child_workspace_resolves_to_root(self):
        project = self.root / "wms-p329"
        business_project(project, "wms-p329", "wms-p329", declared=False)
        result = discover([{"path": str(project / "wms-p329-starter")}], [])
        self.assertEqual(len(result["projects"]), 1)
        info = result["projects"][0]
        self.assertEqual(info["path"], str(project))
        self.assertEqual(info["targets"][0]["artifact"], "wms-p329-starter")
        self.assertEqual(info["buildPaths"], [str(project), str(project / "wms-p329-module"), str(project / "wms-p329-starter")])

    def test_project_template_and_nested_business_project_remain_available(self):
        pom(self.root, "workspace-parent")
        business_project(self.root / "template", "wms-project-base", "wms-project")
        self.assertEqual(discover([{"path": str(self.root)}], [])["projects"][0]["artifact"], "wms-project-base")

    def test_explicit_target_excludes_protected_war(self):
        pom(self.root, modules=["one", "two"])
        pom(self.root / "one", "one", "war")
        pom(self.root / "two", "two", "war")
        target = self.root / "two" / "target"
        target.mkdir()
        (target / "a.war").write_bytes(b"WAR")
        (target / "a.protect.war").write_bytes(b"PROTECT")
        set_target(str(self.root), str(self.root / "two"))
        self.assertEqual(find_war(str(self.root)), target / "a.war")
        with self.assertRaises(ValueError):
            set_target(str(self.root), str(self.root.parent))


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        pom(self.root, "project", "war")
        self.config = AppConfig()
        self.config.shell["enabled"] = False
        self.patches = [patch("service.load_config", return_value=self.config), patch("service.save_config"),
                        patch("service.load_json", return_value=[]), patch("service.save_json"),
                        patch('service.running_maven', return_value=[]),
                        patch.object(PackageService, "inspect_git")]
        for p in self.patches:
            p.start()
        self.service = PackageService()
        self.service.select(str(self.root))

    def tearDown(self):
        self.service.stop()
        if self.service.operation:
            self.service.operation.join(5)
        for p in reversed(self.patches):
            p.stop()
        self.temp.cleanup()

    def test_bootstrap_does_not_resolve_or_poll_dependencies(self):
        with patch("service.DependencyMonitor") as monitor:
            self.service.scan([{"path": str(self.root)}])
            monitor.assert_not_called()

    def test_reset_requires_explicit_confirmation(self):
        with self.assertRaisesRegex(ValueError, "确认"):
            self.service.start("reset", {})

    def test_same_project_mutations_are_exclusive(self):
        started = threading.Event()
        def blocked(*_):
            started.set()
            self.service.cancel.wait(3)
        with patch.object(self.service, "build", side_effect=blocked):
            self.service.start("build", {})
            self.assertTrue(started.wait(1))
            with self.assertRaises(ValueError):
                self.service.start("pull", {})
            with self.assertRaises(ValueError):
                self.service.select(str(self.root))
            self.service.stop()
            self.service.operation.join(3)
            self.assertEqual(self.service.tasks[0]["status"], "cancelled")

    def test_existing_maven_rejects_start_with_pid_and_project(self):
        with patch('service.running_maven', return_value=[{'pid': 12345, 'project': 'D:/existing-project'}]), \
             patch.object(self.service, 'build') as build:
            with self.assertRaisesRegex(ValueError, 'PID 12345 · D:/existing-project'):
                self.service.start('build', {})
        build.assert_not_called()
        self.assertIsNone(self.service.active)
        self.assertEqual(self.service.tasks, [])

    def test_start_does_not_wait_for_background_monitor(self):
        release_monitor, started = threading.Event(), threading.Event()
        monitor = threading.Thread(target=lambda: release_monitor.wait(10))
        self.service.monitor_thread = monitor
        monitor.start()
        def build(*_):
            started.set()
            self.service.cancel.wait(5)
        try:
            with patch.object(self.service, 'build', side_effect=build):
                before = time.monotonic()
                self.service.start('build', {})
                self.assertTrue(started.wait(1), 'start waited for the unrelated monitor')
                self.assertLess(time.monotonic() - before, 1)
                self.assertTrue(monitor.is_alive())
                self.assertTrue(self.service.monitor_cancel.is_set())
                self.service.stop()
                self.service.operation.join(3)
        finally:
            release_monitor.set()
            monitor.join(3)

    @unittest.skipUnless(os.name == 'nt', 'Windows process tree')
    def test_stop_interrupts_preparation_and_reaps_its_child(self):
        import psutil
        from core.maven_build import _terminate_process_tree
        native_popen, original_log = subprocess.Popen, self.service.log
        started, roots, children = threading.Event(), [], []
        code = ("import json,subprocess,sys,time; json.loads(sys.stdin.readline()); "
                "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']); "
                "print(json.dumps({'type':'log','text':'CHILD_PID='+str(child.pid)}),flush=True);time.sleep(60)")
        def spawn(command, **kwargs):
            if '--prepare' in command:
                proc = native_popen([sys.executable, '-u', '-c', code], **kwargs)
                roots.append(proc)
                return proc
            return native_popen(command, **kwargs)
        def log(task, text, channel='build'):
            original_log(task, text, channel)
            if text.startswith('CHILD_PID='):
                children.append(psutil.Process(int(text.split('=', 1)[1])))
                started.set()
        try:
            with patch('service.subprocess.Popen', side_effect=spawn), \
                 patch.object(self.service, 'log', side_effect=log), \
                 patch('service.run_build') as maven:
                self.service.start('build', {})
                self.assertTrue(started.wait(10), 'preparation did not start')
                before = time.monotonic()
                self.service.stop()
                response_ms = (time.monotonic() - before) * 1000
                self.assertLess(response_ms, 300)
                self.service.operation.join(3)
                complete_ms = (time.monotonic() - before) * 1000
                self.assertFalse(self.service.operation.is_alive(), 'preparation remained blocked')
                self.assertEqual(self.service.tasks[0]['status'], 'cancelled')
                self.assertIsNone(self.service.active)
                maven.assert_not_called()
                self.assertEqual(len(children), 1)
                children[0].wait(timeout=3)
                self.assertFalse(children[0].is_running(), 'preparation child survived cancellation')
                print(f'Preparation cancel: response={response_ms:.1f}ms; complete={complete_ms:.1f}ms; descendants=0')
        finally:
            self.service.stop()
            for proc in roots:
                _terminate_process_tree(proc)
            if self.service.operation:
                self.service.operation.join(5)



    def test_build_uses_original_stages_and_exports_notes(self):
        target = self.root / "target"
        target.mkdir()
        war = target / "demo.war"
        war.write_bytes(b"WAR")
        def fake_build(project, on_line, on_finish, **kwargs):
            self.assertEqual(project, str(self.root))
            on_line("BUILD SUCCESS")
            on_finish(0)
            return lambda: None
        with patch.object(self.service, 'prepare_versions', return_value=('legacy', '1.0-202610281200', 'releases')), \
             patch("service.run_build", side_effect=fake_build), \
             patch("service.build_version_notes", return_value=("# Combined", [])), \
             patch("service.context_id", side_effect=ValueError("No monitor context")):
            self.service.start("build", {})
            self.service.operation.join(5)
        task = self.service.tasks[0]
        self.assertEqual(task["status"], "succeeded", task["logs"])
        self.assertEqual(Path(task["artifacts"]["notes"]).read_text(encoding="utf-8"), "# Combined")
        self.assertEqual(task["artifacts"]["war"], str(war))
        self.assertEqual(task["markdown"], "# Combined")

    def test_state_returns_task_details_only_for_active_and_focused_tasks(self):
        def record(task_id):
            return {"id": task_id, "kind": "build", "status": "succeeded", "artifacts": {},
                    "logs": [{"time": 1, "text": task_id + " 日志", "channel": "build"}], "markdown": "# " + task_id}
        self.service.tasks = [record("newer"), record("older")]
        by_id = lambda state: {task["id"]: task for task in state["tasks"]}
        summary = by_id(self.service.state())
        self.assertTrue(all(t["detailOmitted"] and t["logs"] == [] and t["markdown"] == "" for t in summary.values()))
        focused = by_id(self.service.dispatch("state", {"focus": "older"}))
        self.assertEqual(focused["older"]["logs"][0]["text"], "older 日志")
        self.assertEqual(focused["older"]["markdown"], "# older")
        self.assertNotIn("detailOmitted", focused["older"])
        self.assertTrue(focused["newer"]["detailOmitted"])
        self.assertEqual(self.service.tasks[0]["logs"][0]["text"], "newer 日志", "摘要不能改动任务记录")
        # 焦点对其他操作返回的状态同样生效；运行中的任务始终带详情。
        self.service.active = "newer"
        try:
            detailed = by_id(self.service.dispatch("monitor", {}))
            self.assertNotIn("detailOmitted", detailed["newer"])
            self.assertNotIn("detailOmitted", detailed["older"])
        finally:
            self.service.active = None
        self.assertTrue(all(t.get("detailOmitted") for t in self.service.dispatch("state", {"focus": ""})["tasks"]))

    def test_config_validation_and_secrets_not_returned(self):
        with self.assertRaises(ValueError):
            self.service.save_settings({"release": {"url": "file:///etc", "count": 5}})
        self.service.options["jenkins_secret"] = "encrypted"
        self.assertEqual(self.service.state()["monitorOptions"]["jenkins_secret"], "")

    def test_inferred_modules_build_in_order_and_stop_on_failure(self):
        business_project(self.root, "wms-p329", "wms-p329", declared=False)
        self.service.select(str(self.root))
        paths = []
        def fake_build(project, on_line, on_finish, **kwargs):
            paths.append(project)
            on_finish(1 if len(paths) == 2 else 0)
            return lambda: None
        with patch.object(self.service, 'prepare_versions', return_value=('legacy', '1.0-202610281200', 'releases')), \
             patch("service.context_id", side_effect=ValueError("No monitor context")), \
             patch("service.run_build", side_effect=fake_build):
            self.service.start("build", {})
            self.service.operation.join(5)
        self.assertEqual(paths, [str(self.root), str(self.root / "wms-p329-module")])
        self.assertEqual(self.service.tasks[0]["status"], "failed")

    def test_closing_panel_cancels_monitor_not_build(self):
        self.service.close_panel()
        self.assertTrue(self.service.monitor_cancel.is_set())
        self.assertFalse(self.service.cancel.is_set())

    def test_unknown_artifact_not_arbitrary_file_access(self):
        with self.assertRaises(ValueError):
            self.service.artifact("not-a-task", "notes")


class MavenPreflightTests(unittest.TestCase):
    def process(self, pid, arguments, parents=(), name='java.exe'):
        process = Mock()
        process.pid = pid
        process.info = {'name': name, 'pid': pid}
        process.cmdline.return_value = arguments
        process.parents.return_value = [Mock(pid=value) for value in parents]
        process.cwd.return_value = 'D:/fallback'
        return process

    def test_detects_maven_only_and_excludes_owned_resolver(self):
        launcher = 'org.codehaus.plexus.classworlds.launcher.Launcher'
        processes = [self.process(10, ['java', '-Dmaven.multiModuleProjectDirectory=D:/project', launcher]),
                     self.process(11, ['java', 'org.apache.maven.wrapper.MavenWrapperMain']),
                     self.process(12, ['java', launcher], parents=[99]),
                     self.process(13, ['java', '-jar', 'business-service.jar']),
                     self.process(14, ['node', launcher], name='node.exe')]
        with patch('maven_preflight.psutil.process_iter', return_value=processes):
            found = running_maven(owner_pid=99)
        self.assertEqual(found, [{'pid': 10, 'project': 'D:/project'}, {'pid': 11, 'project': 'D:/fallback'}])

    def test_exited_process_does_not_fail_preflight(self):
        import psutil
        process = self.process(10, [])
        process.cmdline.side_effect = psutil.NoSuchProcess(10)
        with patch('maven_preflight.psutil.process_iter', return_value=[process]):
            self.assertEqual(running_maven(), [])


@unittest.skipUnless(os.name == "nt", "Windows Job Object")
class ProcessTests(unittest.TestCase):
    def test_successful_parent_exit_reaps_orphan_child(self):
        import psutil
        code = "import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);print(p.pid,flush=True)"
        result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0)
        pid = int(result.stdout.strip())
        deadline = time.monotonic() + 3
        while psutil.pid_exists(pid) and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertFalse(psutil.pid_exists(pid), "child survived its command")

    def test_worker_protocol_ready_shutdown_and_no_children(self):
        worker = Path(__file__).resolve().parents[1] / "engine" / "worker.py"
        proc = subprocess.Popen([sys.executable, "-B", str(worker)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, encoding="utf-8")
        try:
            out, err = proc.communicate(json.dumps({"id": 1, "operation": "state"})+"\n"+
                                       json.dumps({"id": 2, "operation": "shutdown"})+"\n", timeout=15)
            messages = [json.loads(line) for line in out.splitlines()]
            self.assertEqual(messages[0]["type"], "ready", err)
            self.assertTrue(messages[1]["ok"], messages)
            self.assertEqual(proc.returncode, 0, err)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)
