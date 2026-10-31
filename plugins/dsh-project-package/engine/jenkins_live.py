"""Read-only Jenkins view feed, independent of project dependency resolution."""
import copy
import threading
import time
from urllib.parse import urlsplit, urlunsplit

import requests

from core.jenkins_client import JenkinsAuthenticationError
from core.monitor_secrets import reveal

COLORS = {"blue": "SUCCESS", "red": "FAILURE", "yellow": "UNSTABLE", "grey": "NOT_BUILT",
          "disabled": "DISABLED", "aborted": "ABORTED"}


def view_url(address):
    url = urlsplit(address)
    if url.scheme not in ("http", "https") or not url.netloc:
        raise ValueError("Jenkins 地址必须为 HTTP/HTTPS")
    path = url.path.rstrip("/").removesuffix("/builds")
    if "/view/" not in path:
        path += "/view/all"
    return urlunsplit((url.scheme, url.netloc, path, "", ""))


def read_builds(options, limit=12):
    base = view_url(options["jenkins_url"])
    auth = (options["jenkins_user"], reveal(options["jenkins_secret"])) \
        if options.get("jenkins_user") and options.get("jenkins_secret") else None
    tree = "jobs[name,url,color,lastBuild[number,url,building,result,timestamp,duration,estimatedDuration]]"
    try:
        with requests.get(base + "/api/json", params={"tree": tree}, auth=auth,
                          headers={"Accept": "application/json"}, timeout=(3, 10), allow_redirects=False) as response:
            if response.status_code in (401, 403):
                raise JenkinsAuthenticationError("Jenkins 需要认证，请在连接配置中填写用户名和 API Token")
            if response.status_code != 200:
                raise ValueError(f"Jenkins 请求失败（HTTP {response.status_code}）")
            payload = response.json()
    except requests.RequestException as exc:
        raise ValueError("无法连接 Jenkins，请检查地址和网络") from exc
    jobs = payload.get("jobs") if isinstance(payload, dict) else None
    if not isinstance(jobs, list):
        raise ValueError("Jenkins 返回的数据不是任务列表，请检查连接地址")
    builds = []
    for job in jobs:
        build = job.get("lastBuild") or {}
        if not build:
            continue
        building = bool(build.get("building"))
        builds.append({"jobName": job.get("name", ""), "number": build.get("number"),
                       "url": build.get("url") or job.get("url", ""), "building": building,
                       "result": "BUILDING" if building else build.get("result") or COLORS.get(job.get("color", "").removesuffix("_anime"), "UNKNOWN"),
                       **{field: build.get(field) or 0 for field in ("timestamp", "duration", "estimatedDuration")}})
    builds.sort(key=lambda build: (not build["building"], -build["timestamp"]))
    return {"builds": builds[:limit], "runningCount": sum(build["building"] for build in builds),
            "totalCount": len(builds), "fetchedAt": int(time.time() * 1000), "jenkinsUrl": base + "/builds"}


class JenkinsLive:
    def __init__(self):
        self.lock = threading.RLock()
        self.thread = None
        self.generation = 0
        self.last_poll = None
        self.data = {"builds": [], "runningCount": 0, "fetchedAt": 0, "error": "", "loading": False}

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.data)

    def reset(self):
        with self.lock:
            self.generation += 1
            self.last_poll = None
            self.data = {"builds": [], "runningCount": 0, "fetchedAt": 0, "error": "", "loading": False}

    def close(self):
        with self.lock:
            self.generation += 1
            self.last_poll = None
            self.data["loading"] = False

    def poll(self, options):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            if self.last_poll is not None and time.monotonic() - self.last_poll < 5:
                return
            self.last_poll = time.monotonic()
            self.data["loading"] = True
            generation = self.generation
            settings = dict(options)

            def work():
                try:
                    result = {**read_builds(settings), "error": "", "loading": False}
                except Exception as exc:
                    result = {"error": str(exc), "loading": False}
                with self.lock:
                    if generation == self.generation:
                        self.data.update(result)

            self.thread = threading.Thread(target=work, daemon=True, name="jenkins-live-read")
            self.thread.start()
