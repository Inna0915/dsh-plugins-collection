"""UI-independent PackageTool workflow and lazy DSH session state."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from discovery import discover, project_info, key
from jenkins_live import JenkinsLive
from project_cache import cached_discover
from git_status import inspect_repository
from maven_preflight import running_maven
from core.app_config import load_config, save_config, remember_project, default_config_path
from core.git_repo import (refresh_remote_branches, switch_to_remote_branch,
                           pull_repository, reset_repository_to_upstream)
from core.maven_build import run_build, BuildCancelled, check_cancelled, _terminate_process_tree
from core.pom_reader import read_root_pom, strip_snapshot
from core.shell_deploy import find_war, build_packaged_name
from core.version_notes import build_project_preview, build_version_notes, write_version_notes
from core.dependency_monitor import DependencyMonitor, load_options, parse_rules
from core.dependency_inventory import context_id, monitor_home, save_json, load_json
from core.maven_repository import settings_paths
from core.monitor_secrets import protect
from core.project_layout import set_target


def valid_url(value, optional=False):
    if optional and not value:
        return
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.username or parsed.password or parsed.query:
        raise ValueError("服务地址必须是无账号密码、无查询参数的 HTTP/HTTPS 地址")


class PackageService:
    def __init__(self):
        self.lock = threading.RLock()
        self.config = load_config()
        self.options = load_options()
        self.projects = []
        self.warnings = []
        self.selected = None
        self.git = None
        self.git_loading = False
        self.git_cache = {}
        self.git_generation = 0
        self.git_pending = None
        self.git_thread = None
        self.projects_cached = False
        self.branches = []
        self.environment = [{"name": name, "available": bool(__import__("shutil").which(name))}
                            for name in ("git", "mvn", "java")]
        self.environment.append({"name": "打包引擎", "available": True, "version": "PackageTool 1.6.1"})
        self.history_path = default_config_path().parent / "dsh-project-package" / "history.json"
        history = load_json(self.history_path, [])
        self.tasks = history[:20] if isinstance(history, list) else []
        for task in self.tasks:
            if task.get("status") in ("running", "cancelling"):
                task.update(status="interrupted", phase="上次任务已中断", ended=time.time())
        self.active = None
        self.cancel = threading.Event()
        self.stop_build = None
        self.operation = None
        self.monitor = None
        self.monitor_thread = None
        self.monitor_cancel = threading.Event()
        self.monitor_result = {}
        self.monitor_error = ""
        self.monitor_visible = False
        self.monitor_generation = 0
        self.last_monitor = 0.
        self.jenkins_live = JenkinsLive()

    def public_options(self):
        return {k: ("" if k.endswith("secret") else v) for k, v in self.options.items()}

    def state(self):
        with self.lock:
            return copy.deepcopy({"projects": self.projects, "warnings": self.warnings,
                "selected": self.selected, "git": self.git, "gitLoading": self.git_loading, "branches": self.branches,
                "projectsCached": self.projects_cached,
                "environment": self.environment, "config": self.config.to_dict(),
                "monitorOptions": self.public_options(), "tasks": self.tasks,
                "activeTask": self.active, "monitor": self.monitor_result,
                "monitorError": self.monitor_error,
                "monitorBusy": bool(self.monitor_thread and self.monitor_thread.is_alive()),
                "jenkinsLive": self.jenkins_live.snapshot()})

    def scan(self, workspaces, force=False):
        result, cached = cached_discover(self.history_path.with_name('projects.json'), workspaces, self.config.recent_projects, force)
        with self.lock:
            self.projects, self.warnings = result["projects"], result["warnings"]
            self.projects_cached = cached
        return self.state()

    def select(self, project, target=None):
        if self.active:
            raise ValueError("请等待当前任务完成后切换项目")
        info = project_info(project)
        targets = info["targets"]
        target = target or (targets[0]["path"] if len(targets) == 1 else "")
        if target and key(target) not in {key(t["path"]) for t in targets}:
            raise ValueError("请选择当前项目的产物模块")
        info["target"] = target
        self.monitor_cancel.set()
        self.monitor_generation += 1
        self.monitor, self.monitor_result, self.monitor_error = None, {}, ""
        self.last_monitor = 0
        with self.lock:
            self.selected = info
            self.branches = []
            self.config.recent_projects = remember_project(self.config.recent_projects, project)
            save_config(self.config)
            if not any(key(x["path"]) == key(project) for x in self.projects):
                self.projects.append({**info, "workspace": "手动选择"})
        self.inspect_git(background=True)
        return self.state()

    def read_git(self, project):
        try:
            result = asdict(inspect_repository(project))
            result["root"] = str(result["root"])
            result["dirty"] = result["changed_count"] > 0
            result["error"] = ""
        except Exception as exc:
            result = {"error": str(exc)}
        return result

    def inspect_git(self, background=False):
        if not self.selected:
            return
        with self.lock:
            project = self.selected['path']
            self.git_generation += 1
            generation = self.git_generation
            self.git_loading = True
            self.git = copy.deepcopy(self.git_cache.get(key(project)))
            self.git_pending = (project, generation) if background else None
            if background:
                if self.git_thread and self.git_thread.is_alive():
                    return
                self.git_thread = threading.Thread(target=self.refresh_git_loop, daemon=True, name='project-git-read')
                self.git_thread.start()
                return
        self.apply_git(project, generation, self.read_git(project))

    def apply_git(self, project, generation, result):
        with self.lock:
            self.git_cache[key(project)] = result
            if len(self.git_cache) > 30:
                self.git_cache.pop(next(iter(self.git_cache)))
            if generation == self.git_generation:
                self.git, self.git_loading = result, False

    def refresh_git_loop(self):
        while True:
            with self.lock:
                pending, self.git_pending = self.git_pending, None
                if pending is None:
                    self.git_thread = None
                    return
            project, generation = pending
            self.apply_git(project, generation, self.read_git(project))

    def save_settings(self, data):
        if self.active:
            raise ValueError("当前任务期间不能修改配置")
        release = dict(data.get("release", self.config.release))
        valid_url(release.get("url", ""))
        if type(release.get("count")) is not int or not 1 <= release["count"] <= 50:
            raise ValueError("最近版本数须为 1～50")
        shell = {**self.config.shell, **data.get("shell", {})}
        for field in ("enabled", "auto_shell", "test_version"):
            if not isinstance(shell[field], bool):
                raise ValueError("加壳选项格式错误")
        valid_url(shell.get("trigger_url", ""), optional=not shell["enabled"])
        options = dict(self.options)
        for name, value in data.get("monitorOptions", {}).items():
            if name not in options:
                continue
            if name.endswith("secret"):
                if value:
                    options[name] = protect(value)
            else:
                options[name] = value
        valid_url(options["jenkins_url"])
        valid_url(options["repository_url"], optional=True)
        parse_rules(options["rules"])
        self.monitor_cancel.set()
        self.monitor_generation += 1
        self.monitor = None
        self.monitor_result = {}
        self.last_monitor = 0
        with self.lock:
            self.config.release, self.config.shell = release, shell
            self.options = options
            save_config(self.config)
            save_json(monitor_home() / "config.json", options)
        self.jenkins_live.reset()
        return self.state()

    def log(self, task, text, channel="build"):
        with self.lock:
            task["logs"].append({"time": time.time(), "text": str(text), "channel": channel})
            task["logs"] = task["logs"][-1600:]

    def phase(self, task, text):
        with self.lock:
            task["phase"] = text

    def persist(self):
        with self.lock:
            save_json(self.history_path, self.tasks[:20])

    def start(self, kind, data):
        if kind not in ("build", "shell", "fetch", "pull", "switch", "reset"):
            raise ValueError("不支持的任务")
        if kind == 'build' and not self.active:
            existing = running_maven()
            if existing:
                detail = '\n'.join(f"PID {item['pid']} · {item['project'] or '目录未知'}" for item in existing)
                raise ValueError('发现已有 Maven 构建，本次启动已中止。请先处理已有构建：\n' + detail)
        with self.lock:
            if self.active:
                raise ValueError("当前已有任务运行")
            if not self.selected:
                raise ValueError("请先选择项目")
            if kind in ("build", "shell") and not self.selected["target"]:
                raise ValueError("项目有多个产物模块，请先选择")
            if kind == "reset" and data.get("confirmed") is not True:
                raise ValueError("重置到远端需要明确确认")
            task = {"id": uuid.uuid4().hex, "kind": kind, "project": self.selected["path"],
                    "name": self.selected["artifact"], "target": self.selected.get("target", ""),
                    "status": "running", "phase": "准备中", "started": time.time(),
                    "ended": None, "logs": [], "markdown": "", "artifacts": {},
                    "branch": (self.git or {}).get("branch", "")}
            self.tasks.insert(0, task)
            self.tasks = self.tasks[:20]
            self.active = task["id"]
            self.cancel = threading.Event()
            config = copy.deepcopy(self.config.to_dict())
            self.monitor_cancel.set()
            self.monitor_generation += 1
            self.monitor = None
            task['logs'].append({'time': time.time(), 'text': '[INFO] 已接收任务，开始准备', 'channel': 'build'})
        self.persist()
        self.operation = threading.Thread(target=self._run, args=(task, config, data), daemon=True)
        self.operation.start()
        return self.state()

    def _run(self, task, config, data):
        try:
            check_cancelled(self.cancel)
            if task["target"]:
                set_target(task["project"], task["target"])
            if task["kind"] == "build":
                self.build(task, config)
            elif task["kind"] == "shell":
                war = find_war(task["project"])
                if war is None:
                    raise ValueError("没有找到 WAR，请先构建")
                self.shell(task, config, war)
            else:
                self.phase(task, "执行 Git 操作")
                actions = {"fetch": refresh_remote_branches, "pull": pull_repository,
                           "reset": reset_repository_to_upstream}
                if task["kind"] == "switch":
                    result = switch_to_remote_branch(task["project"], str(data.get("branch", "")))
                else:
                    result = actions[task["kind"]](task["project"])
                self.log(task, result.output, "git")
                if hasattr(result, "branches"):
                    self.branches = list(result.branches)
                if not result.success:
                    raise RuntimeError(f"Git 操作失败（{result.returncode}）")
                self.monitor = None
                self.monitor_result = {}
                if self.selected:
                    updated = project_info(self.selected["path"])
                    self.selected.update({"version": updated["version"], "targets": updated["targets"]})
            check_cancelled(self.cancel)
            with self.lock:
                task.update(status="succeeded", phase="已完成")
        except BuildCancelled:
            with self.lock:
                task.update(status="cancelled", phase="已取消")
        except Exception as exc:
            with self.lock:
                if self.cancel.is_set():
                    task.update(status='cancelled', phase='已取消')
                else:
                    self.log(task, str(exc), "error")
                    task.update(status="failed", phase=str(exc))
        finally:
            self.stop_build = None
            with self.lock:
                task["ended"] = time.time()
                self.active = None
            self.persist()
            if self.monitor_visible:
                self.inspect_git(background=True)

    def build(self, task, config):
        project = task["project"]
        self.phase(task, "生成版本说明")
        legacy, project_version, releases = self.prepare_versions(task, config)
        task["markdown"] = build_project_preview(legacy, project_version, releases)
        check_cancelled(self.cancel)
        try:
            build_context = context_id(project, settings_paths(project))
        except Exception:
            build_context = None
        self.phase(task, "Maven 构建中")
        deadline = time.monotonic() + 3600
        for build_path in project_info(project).get("buildPaths", [project]):
            check_cancelled(self.cancel)
            self.log(task, f"[INFO] 构建目录：{build_path}")
            done, result = threading.Event(), []
            def finish(code):
                result.append(code)
                done.set()
            self.stop_build = run_build(build_path, lambda line: self.log(task, line), finish, cancel_event=self.cancel)
            timed_out = False
            while not done.wait(.2):
                if time.monotonic() >= deadline:
                    timed_out = True
                    self.stop_build()
                elif self.cancel.is_set():
                    self.stop_build()
            self.stop_build = None
            if timed_out:
                raise TimeoutError("Maven 构建超过 60 分钟，已终止进程树")
            check_cancelled(self.cancel)
            if not result or result[0] != 0:
                raise RuntimeError(f"Maven 构建失败（{result[0] if result else -1}）")
        self.phase(task, "整理版本说明与产物")
        combined, logs = build_version_notes(project, legacy, project_version, releases)
        for line in logs:
            self.log(task, line)
        task["markdown"] = combined
        war = find_war(project)
        artifact, version = read_root_pom(project)
        ts = project_version.rsplit("-", 1)[-1] if project_version else datetime.now().strftime("%Y%m%d%H%M")
        task["packagedStem"] = build_packaged_name(war.stem if war else artifact, artifact,
                                                  strip_snapshot(version), ts, config["shell"]["test_version"])
        out_dir = war.parent if war else Path(task["target"]) / "target"
        out_dir.mkdir(parents=True, exist_ok=True)
        notes = write_version_notes(out_dir, combined, task["packagedStem"] + ".md")
        task["artifacts"]["notes"] = str(notes)
        if war:
            task["artifacts"]["war"] = str(war)
        else:
            jars = sorted(out_dir.glob("*.jar"), key=lambda p: p.stat().st_mtime, reverse=True)
            if jars:
                task["artifacts"]["jar"] = str(jars[0])
        self.persist()
        if war and build_context:
            try:
                current = context_id(project, settings_paths(project))
                if current != build_context:
                    raise ValueError("构建期间项目配置发生变化，本次产物未更新核验基线")
                self.phase(task, "核验包内依赖")
                if not self.monitor or self.monitor.context != current:
                    self.monitor = DependencyMonitor(project, self.options)
                self.monitor_result = self.monitor.poll(self.cancel, force=True, war=str(war))
                self.monitor_error = ""
            except BuildCancelled:
                raise
            except Exception as exc:
                self.monitor_error = str(exc)
                self.log(task, "依赖核验未完成：" + str(exc), "monitor")
        check_cancelled(self.cancel)
        if war and config["shell"]["enabled"] and config["shell"]["auto_shell"]:
            self.shell(task, config, war)

    def prepare_versions(self, task, config):
        """A disposable helper makes Git/HTTP preparation immediately cancellable."""
        check_cancelled(self.cancel)
        command = [sys.executable, '--prepare'] if getattr(sys, 'frozen', False) else [sys.executable, '-B', str(Path(__file__).with_name('worker.py')), '--prepare']
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == 'nt' else {'start_new_session': True}
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding='utf-8', errors='replace', **kwargs)
        finished = threading.Event()
        deadline = time.monotonic() + 240
        def guard():
            while not finished.wait(.05):
                if self.cancel.is_set() or time.monotonic() >= deadline:
                    _terminate_process_tree(proc)
                    return
        guardian = threading.Thread(target=guard, daemon=True)
        guardian.start()
        prepared = None
        try:
            proc.stdin.write(json.dumps({'project': task['project'], 'target': task['target'], 'release': config['release']}, ensure_ascii=False) + '\n')
            proc.stdin.close()
            for line in proc.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    self.log(task, line.rstrip())
                    continue
                if message.get('type') == 'phase':
                    self.phase(task, message['text'])
                    self.log(task, '[INFO] ' + message['text'])
                elif message.get('type') == 'log':
                    self.log(task, message['text'])
                elif message.get('type') == 'prepared':
                    prepared = message
                elif message.get('type') == 'error':
                    raise RuntimeError(message['text'])
            proc.wait(timeout=5)
            check_cancelled(self.cancel)
            if time.monotonic() >= deadline:
                raise TimeoutError('版本说明准备超过 240 秒，已终止所属进程')
            if not prepared or proc.returncode != 0:
                raise RuntimeError('版本说明准备失败，请查看日志')
            return prepared['legacy'], prepared['projectVersion'], prepared['releases']
        finally:
            finished.set()
            _terminate_process_tree(proc)
            guardian.join(6)
            if proc.stdout:
                proc.stdout.close()

    def shell(self, task, config, war):
        options = config["shell"]
        if not options["enabled"]:
            raise ValueError("请先启用加壳")
        if not all(options[k] for k in ("upload_dir", "finish_dir", "trigger_url")):
            raise ValueError("请填写完整加壳配置")
        self.phase(task, "加壳中")
        artifact, version = read_root_pom(task["project"])
        command = [sys.executable, "--shell"] if getattr(sys, "frozen", False) else [sys.executable, "-B", str(Path(__file__).with_name("worker.py")), "--shell"]
        kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace", **kwargs)
        finished = threading.Event()
        deadline = time.monotonic() + 720
        def guard():
            while not finished.wait(.2):
                if self.cancel.is_set() or time.monotonic() >= deadline:
                    _terminate_process_tree(proc)
                    return
        guardian = threading.Thread(target=guard, daemon=True)
        guardian.start()
        result = None
        try:
            proc.stdin.write(json.dumps({"war_path": str(war), "upload_dir": options["upload_dir"],
                "trigger_url": options["trigger_url"], "finish_dir": options["finish_dir"],
                "name": artifact, "version": strip_snapshot(version), "test_version": options["test_version"],
                "packaged_stem": task.get("packagedStem", "")}, ensure_ascii=False) + "\n")
            proc.stdin.close()
            for line in proc.stdout:
                try:
                    message = json.loads(line)
                except ValueError:
                    self.log(task, line.rstrip(), "shell")
                    continue
                if message.get("type") == "log":
                    self.log(task, message["text"], "shell")
                elif message.get("type") == "result":
                    result = message
            proc.wait(timeout=5)
            check_cancelled(self.cancel)
            if time.monotonic() >= deadline:
                raise TimeoutError("加壳操作超过 12 分钟，已停止本地处理")
            if not result or result["code"] != 0:
                raise RuntimeError("加壳失败，请查看加壳日志")
            task["artifacts"]["protected"] = result["path"]
        finally:
            finished.set()
            _terminate_process_tree(proc)
            guardian.join(6)
            if proc.stdout:
                proc.stdout.close()

    def stop(self):
        with self.lock:
            self.cancel.set()
            self.monitor_cancel.set()
            task = next((t for t in self.tasks if t["id"] == self.active), None)
            if task:
                task.update(status="cancelling", phase="正在终止当前步骤与所属进程")
                self.log(task, '[INFO] 已接收终止请求')
                if task["kind"] == "shell" or any(x["channel"] == "shell" for x in task["logs"]):
                    self.log(task, "已取消本地等待；已触发的远端加壳可能仍在执行。", "shell")
        return self.state()

    def poll_monitor(self, force=False, resolve=False):
        self.monitor_visible = True
        if not self.selected or self.active or (self.monitor_thread and self.monitor_thread.is_alive()):
            return self.state()
        if not force and time.monotonic() - self.last_monitor < 10:
            return self.state()
        generation, project = self.monitor_generation, self.selected["path"]
        self.monitor_cancel = cancel = threading.Event()
        self.last_monitor = time.monotonic()
        def work():
            try:
                current = context_id(project, settings_paths(project))
                monitor = self.monitor
                if not monitor or monitor.context != current:
                    monitor = DependencyMonitor(project, self.options)
                result = monitor.poll(cancel, force=force, resolve=resolve)
                if not cancel.is_set() and generation == self.monitor_generation:
                    with self.lock:
                        self.monitor, self.monitor_result, self.monitor_error = monitor, result, ""
            except BuildCancelled:
                pass
            except Exception as exc:
                if not cancel.is_set() and generation == self.monitor_generation:
                    with self.lock:
                        self.monitor_error = str(exc)
        self.monitor_thread = threading.Thread(target=work, daemon=True)
        self.monitor_thread.start()
        return self.state()

    def close_panel(self):
        self.monitor_visible = False
        self.monitor_cancel.set()
        self.jenkins_live.close()
        with self.lock:
            self.git_generation += 1
            self.git_pending = None
            self.git_loading = False

    def acknowledge(self):
        if self.monitor_thread and self.monitor_thread.is_alive():
            raise ValueError("请等待核验完成")
        if self.monitor:
            self.monitor.acknowledge(self.monitor_result.get("events", []))
            self.monitor_result["events"], self.monitor_result["notifications"] = [], []
        return self.state()

    def artifact(self, task_id, kind):
        task = next((t for t in self.tasks if t["id"] == task_id), None)
        value = task and task.get("artifacts", {}).get(kind)
        if not value or not Path(value).is_file():
            raise ValueError("产物不存在，请重新打包")
        return str(Path(value).resolve())

    def dispatch(self, operation, data):
        if operation == "state":
            return self.state()
        if operation == "scan":
            return self.scan(data.get("workspaces", []), data.get("force", False))
        if operation == "select":
            return self.select(data["project"], data.get("target"))
        if operation == "settings":
            return self.save_settings(data)
        if operation == "start":
            return self.start(data["kind"], data)
        if operation == "cancel":
            return self.stop()
        if operation == "monitor":
            return self.poll_monitor(data.get("force", False), data.get("resolve", False))
        if operation == "jenkins":
            self.jenkins_live.poll(self.options)
            return self.state()
        if operation == "acknowledge":
            return self.acknowledge()
        if operation == "close":
            self.close_panel()
            return {"busy": bool(self.active)}
        if operation == "artifact":
            return {"path": self.artifact(data["taskId"], data["kind"])}
        raise ValueError("未知操作")
