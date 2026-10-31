"""只读 Jenkins 状态；不向 Jenkins 提交构建。"""
from urllib.parse import quote, urlparse
import requests

DEFAULT_JENKINS = "http://172.18.10.25:9005"
RESULT_NAMES = {"SUCCESS": "成功", "FAILURE": "失败", "ABORTED": "已终止",
                "UNSTABLE": "不稳定", "NOT_BUILT": "未构建"}


class JenkinsAuthenticationError(ValueError):
    pass


def job_url(base: str, name: str) -> str:
    return base.rstrip("/") + "/" + "/".join("job/" + quote(part, safe="") for part in name.split("/")) + "/"


def read_job(base: str, name: str, auth=None) -> dict:
    if urlparse(base).scheme not in ("http", "https"):
        raise ValueError("Jenkins 地址必须为 HTTP/HTTPS")
    url = job_url(base, name)
    tree = "name,inQueue,color,lastBuild[number,building,result,timestamp,duration],lastSuccessfulBuild[number,timestamp]"
    try:
        with requests.get(url + "api/json", params={"tree": tree}, auth=auth,
                          timeout=(3, 10), allow_redirects=False) as response:
            if response.status_code in (401, 403):
                raise JenkinsAuthenticationError("Jenkins 认证失败，请检查连接配置")
            if response.status_code != 200:
                raise ValueError(f"Jenkins HTTP {response.status_code}")
            data = response.json()
    except requests.RequestException as exc:
        raise ValueError("Jenkins 连接失败或超时") from exc
    build = data.get("lastBuild") or {}
    status = "构建中" if build.get("building") else RESULT_NAMES.get(build.get("result"), "未构建")
    if data.get("inQueue"):
        status += " / 排队中"
    successful = data.get("lastSuccessfulBuild") or {}
    return {"job": name, "url": url, "status": status, "number": build.get("number"),
            "timestamp": build.get("timestamp", 0), "duration": build.get("duration", 0),
            "building": bool(build.get("building")), "success": successful.get("number")}
