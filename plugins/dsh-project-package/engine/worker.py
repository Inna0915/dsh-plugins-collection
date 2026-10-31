"""NDJSON transport. No GUI import or Tk initialization."""
import json
import sys
from process_job import own_process_tree, install_owned_subprocesses


def send(value):
    print(json.dumps(value, ensure_ascii=False, default=str), flush=True)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    own_process_tree()
    install_owned_subprocesses()
    if '--prepare' in sys.argv:
        from core.git_log import generate_version_md
        from core.release_notes import generate_project_releases
        from core.project_layout import set_target
        try:
            data = json.loads(sys.stdin.readline())
            set_target(data['project'], data['target'])
            send({'type': 'phase', 'text': '读取 Git 提交并生成版本资源'})
            legacy, _, _, version = generate_version_md(data['project'])
            send({'type': 'phase', 'text': '生成项目版本记录与说明'})
            releases, _, _ = generate_project_releases(data['project'], data['release']['url'], data['release']['count'],
                                                       on_log=lambda text: send({'type': 'log', 'text': text}))
            send({'type': 'prepared', 'legacy': legacy, 'projectVersion': version, 'releases': releases})
        except Exception as exc:
            send({'type': 'error', 'text': str(exc)})
            sys.exit(1)
        return
    if "--shell" in sys.argv:
        from core.shell_deploy import _worker
        data = json.loads(sys.stdin.readline())
        _worker(**data, on_log=lambda text: send({"type": "log", "text": text}),
                on_finish=lambda code, path: send({"type": "result", "code": code, "path": path}))
        return
    from service import PackageService
    service = PackageService()
    send({"type": "ready"})
    try:
        for line in sys.stdin:
            request = {}
            try:
                request = json.loads(line)
                if request["operation"] == "shutdown":
                    service.stop()
                    break
                result = service.dispatch(request["operation"], request.get("data", {}))
                send({"id": request["id"], "ok": True, "value": result})
            except Exception as exc:
                send({"id": request.get("id"), "ok": False, "error": str(exc)})
    finally:
        service.close_panel()
        service.stop()
        if service.operation:
            service.operation.join(5)
        # Job handle closes with the worker, cleaning all outstanding descendants.


if __name__ == "__main__":
    main()
