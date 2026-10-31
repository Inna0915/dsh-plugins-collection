"""监控状态组合：Jenkins 变化触发核验，实际 WAR 内容决定是否已包含。"""
from __future__ import annotations

import fnmatch
import hashlib
import time
from pathlib import Path
from threading import Event

from core.dependency_inventory import (Dependency, context_id, load_json, monitor_home,
                                       read_war, resolve_dependencies, save_json)
from core.jenkins_client import DEFAULT_JENKINS, JenkinsAuthenticationError, read_job
from core.maven_build import check_cancelled
from core.maven_repository import (AuthenticationError, Repository, read_repositories,
                                    remote_artifact, settings_paths)
from core.monitor_secrets import reveal

# Explicit producer allowlist from Gaia's Jenkinsfile, not a gaia-* prefix match.
GAIA_RULES = [
    f"com.ykeey.gaia:{artifact}:*=gaia"
    for artifact in (
        "gaia-boot", "gaia-service-api", "gaia-service", "gaia-module",
        "gaia-service-matrix", "gaia-service-opc", "gaia-service-zebra",
        "gaia-service-redis", "gaia-service-distributed", "gaia-service-monitor",
        "gaia-service-alarm", "gaia-service-mongodb",
    )
] + ["com.ykeey.gaia:gaia-front:*=gaia-front"]
RULES_REVISION = 1

DEFAULT_RULES = [
    "com.cyzn.fms:fms-warehouse:*=fms",
    "com.cyzn.fms:fms-platform:*=fms",
    "com.cyzn.fms:fms-common:*=fms",
    "com.cyzn.fms:fms-front:*=fms-front",
    "com.ykeey.wms:wms-platform:10.*=wms-10",
    "com.ykeey.wms:wms-common:10.*=wms-10",
    "com.ykeey.wms:wms-warehouse:10.*=wms-10",
    "com.ykeey.wms:wms-front:*=wms-front",
] + GAIA_RULES


def default_options() -> dict:
    return {"jenkins_url": DEFAULT_JENKINS, "jenkins_user": "", "jenkins_secret": "",
            "repository_id": "", "repository_url": "", "repository_user": "",
            "repository_secret": "", "rules": DEFAULT_RULES.copy(),
            "rules_revision": RULES_REVISION}


def load_options() -> dict:
    options = default_options()
    saved = load_json(monitor_home() / "config.json", {})
    if isinstance(saved, dict):
        options.update({k: v for k, v in saved.items() if k in options and isinstance(v, type(options[k]))})
        revision = saved.get("rules_revision", 0)
        if not isinstance(revision, int) or revision < RULES_REVISION:
            # Upgrade only new Gaia defaults; never restore deleted FMS/WMS rules
            # or introduce overlapping defaults for a user-defined Gaia coordinate.
            existing = set()
            for line in options["rules"]:
                try:
                    existing.update((group, artifact) for group, artifact, _, _ in parse_rules([line]))
                except (ValueError, AttributeError):
                    continue  # Keep invalid user text for the normal config validation.
            options["rules"] = list(options["rules"])
            for line in GAIA_RULES:
                group, artifact, _, _ = parse_rules([line])[0]
                if (group, artifact) not in existing:
                    options["rules"].append(line)
            options["rules_revision"] = RULES_REVISION
    return options


def parse_rules(lines: list[str]) -> list[tuple[str, str, str, str]]:
    rules = []
    for line in lines:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.strip().split("=", 1)
        coordinates = parts[0].split(":")
        if len(parts) != 2 or len(coordinates) != 3 or not all(coordinates) or not parts[1].strip():
            raise ValueError("关联格式：groupId:artifactId:版本规则=Jenkins任务")
        rules.append((*coordinates, parts[1].strip()))
    return rules


def mapped_job(dep: Dependency, rules) -> str:
    matches = {job for group, artifact, version, job in rules
               if dep.group == group and dep.artifact == artifact
               and fnmatch.fnmatchcase(dep.version, version)}
    return matches.pop() if len(matches) == 1 else ""


def comparison(packaged: dict | None, remote: dict, previous: dict | None = None) -> tuple[str, bool]:
    if not packaged:
        return "待打包核验", False
    algorithm = remote["algorithm"]
    if packaged.get(algorithm) == remote["checksum"]:
        return "已包含远端制品", False
    verified = packaged.get("verified_remote") or {}
    if verified.get("repository") == remote["repository"] and verified.get("identity") != remote["identity"]:
        import re
        def order(value):
            match = re.search(r"(\d{8}\.\d{6})-(\d+)$", value)
            return (match.group(1), int(match.group(2))) if match else None
        old, new = order(verified.get("identity", "")), order(remote["identity"])
        if old and new and new > old:
            return "有新 SNAPSHOT，尚未打入", True
        return "远端发布记录变化，请核对", True
    return "与远端不一致（可能为本地构建包）", True


class DependencyMonitor:
    def __init__(self, project: str, options: dict, home: Path | None = None):
        self.project = project
        self.options = options
        self.home = home or monitor_home()
        self.context = context_id(project, settings_paths(project))
        self.path = self.home / "projects" / f"{self.context}.json"
        self.state = load_json(self.path, {})
        if not isinstance(self.state, dict):
            self.state = {}
        self.rules = parse_rules(options["rules"])
        self.dependencies = [Dependency.from_key(k) for k in self.state.get("dependencies", [])]
        self.jobs = {}
        self.last_remote = 0.
        self.errors = {}
        self.auth_blocked = False
        self.failures = 0
        self.next_retry = 0.
        self.initial = True
        self.jenkins_auth_blocked = set()
        self.publication_checks = []

    def save(self):
        save_json(self.path, self.state)

    def acknowledge(self, event_ids):
        acknowledged = set(self.state.get("acknowledged", []))
        acknowledged.update(event_ids)
        self.state["acknowledged"] = sorted(acknowledged)[-500:]
        self.save()

    def _repository(self) -> Repository:
        options = self.options
        repos = read_repositories(self.project)
        repo_id = options["repository_id"]
        selected = [r for r in repos if r.id == repo_id] if repo_id else repos
        if options["repository_url"]:
            existing = next((r for r in selected if r.url.rstrip("/") == options["repository_url"].rstrip("/")), None)
            repo = existing or Repository(repo_id or "manual", options["repository_url"].rstrip("/"))
        elif len(selected) == 1:
            repo = selected[0]
        else:
            raise ValueError("请选择有效的 Maven 仓库（关联配置）")
        if options["repository_user"] and options["repository_secret"]:
            repo.auth = (options["repository_user"], reveal(options["repository_secret"]))
        return repo

    def poll(self, cancel: Event, force=False, resolve=False, war: str | None = None) -> dict:
        check_cancelled(cancel)
        if force:
            self.auth_blocked = False
            self.jenkins_auth_blocked.clear()
            self.next_retry = 0
        if resolve or not self.dependencies:
            self.dependencies = resolve_dependencies(self.project, cancel)
            self.state["dependencies"] = [d.key for d in self.dependencies]
            self.state["resolved_at"] = time.time()
        tracked = [d for d in self.dependencies if mapped_job(d, self.rules)]
        if war:
            artifacts = read_war(war, tracked, cancel)
            old = self.state.get("packaged", {})
            for key, artifact in artifacts.items():
                if old.get(key, {}).get("sha256") == artifact["sha256"] and old[key].get("verified_remote"):
                    artifact["verified_remote"] = old[key]["verified_remote"]
            self.state["packaged"] = artifacts
            self.state["war"] = {"path": war, "built_at": time.time()}
            force = True
        successful_change = False
        auth = (self.options["jenkins_user"], reveal(self.options["jenkins_secret"])) \
            if self.options["jenkins_user"] and self.options["jenkins_secret"] else None
        for job in sorted({mapped_job(d, self.rules) for d in tracked}):
            check_cancelled(cancel)
            if job in self.jenkins_auth_blocked:
                continue
            try:
                status = read_job(self.options["jenkins_url"], job, auth)
                if status["success"] is not None and status["success"] != self.jobs.get(job, {}).get("success"):
                    successful_change = True
                self.jobs[job] = status
            except JenkinsAuthenticationError as exc:
                self.jenkins_auth_blocked.add(job)
                self.jobs[job] = {"job": job, "status": str(exc), "url": "", "number": None}
            except Exception as exc:
                self.jobs[job] = {"job": job, "status": str(exc), "url": "", "number": None}
        now = time.time()
        if successful_change and not self.initial:
            self.publication_checks = [now + 5, now + 20, now + 50]
        publication_due = bool(self.publication_checks and now >= self.publication_checks[0])
        self.publication_checks = [deadline for deadline in self.publication_checks if deadline > now]
        refresh = force or successful_change or publication_due or now - self.last_remote >= 60
        remote = self.state.setdefault("remote", {})
        packaged = self.state.setdefault("packaged", {})
        if refresh and not self.auth_blocked and now >= self.next_retry:
            self.errors = {}
            try:
                repo = self._repository()
                for dep in tracked:
                    check_cancelled(cancel)
                    try:
                        current = dict(remote_artifact(dep, repo, cancel))
                        current["checked_at"] = time.time()
                        remote[dep.key] = current
                        artifact = packaged.get(dep.key)
                        if artifact and artifact.get(current["algorithm"]) == current["checksum"]:
                            artifact["verified_remote"] = dict(current)
                    except AuthenticationError as exc:
                        self.auth_blocked = True
                        raise exc
                    except Exception as exc:
                        check_cancelled(cancel)
                        self.errors[dep.key] = str(exc)
                self.last_remote = now
            except Exception as exc:
                check_cancelled(cancel)
                self.errors = {d.key: str(exc) for d in tracked}
            if self.errors:
                self.failures += 1
                self.next_retry = now + min(60, 15 * 2 ** min(2, self.failures - 1))
                self.last_remote = 0
            else:
                self.failures = 0
                self.next_retry = 0
        rows, notifications, event_ids = [], [], []
        acknowledged = set(self.state.get("acknowledged", []))
        observed = set(self.state.get("observed", []))
        for dep in tracked:
            current = remote.get(dep.key)
            artifact = packaged.get(dep.key)
            error = self.errors.get(dep.key)
            state, different = comparison(artifact, current) if current else ("等待远端核验", False)
            if self.state.get("war") and not artifact:
                state = "本次 WAR 未找到可核验的对应依赖"
            if error:
                state, different = "无法核验：" + error, False
            event = ""
            if current and different:
                event = hashlib.sha256((dep.key + current["repository"] + current["identity"] + current["checksum"]).encode()).hexdigest()
                if event not in acknowledged:
                    event_ids.append(event)
                if not self.initial and event not in observed and event not in acknowledged:
                    notifications.append(dep.artifact + "：" + state)
                observed.add(event)
            job = mapped_job(dep, self.rules)
            rows.append({"dependency": dep.key, "artifact": dep.artifact, "version": dep.version,
                         "job": job, "jenkins": self.jobs.get(job, {}), "remote": current or {},
                         "state": state, "different": different, "event": event,
                         "packaged": artifact or {}})
        self.state["observed"] = sorted(observed)[-500:]
        check_cancelled(cancel)
        self.save()
        self.initial = False
        unassociated = [d for d in self.dependencies if d.group.startswith(("com.cyzn", "com.ykeey", "com.foeris"))
                        and not mapped_job(d, self.rules)]
        return {"rows": rows, "events": event_ids, "notifications": notifications,
                "context": self.context, "war": self.state.get("war"),
                "next_poll_seconds": min(10, max(1, self.publication_checks[0] - time.time())) if self.publication_checks else 10,
                "unassociated": [d.key for d in unassociated]}
