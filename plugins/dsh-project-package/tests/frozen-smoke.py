import json
import os
import subprocess
import tempfile
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "engine"))
from process_job import install_owned_subprocesses
install_owned_subprocesses()
with tempfile.TemporaryDirectory(prefix="frozen-smoke-", dir=root / ".task-temp") as temporary:
    env = dict(os.environ, LOCALAPPDATA=temporary, TEMP=temporary, TMP=temporary)
    project = Path(temporary) / "project"
    project.mkdir()
    (project / "pom.xml").write_text('<project><artifactId>fms-p275</artifactId><version>1.0-SNAPSHOT</version><packaging>pom</packaging><modules><module>fms-project-module</module><module>fms-project-starter</module></modules></project>')
    for name, packaging in [("fms-project-module", "jar"), ("fms-project-starter", "war")]:
        (project / name).mkdir()
        (project / name / "pom.xml").write_text(f'<project><artifactId>{name}</artifactId><packaging>{packaging}</packaging></project>')
    messages = [{"id":1,"operation":"scan","data":{"workspaces":[{"path":str(project),"title":"Fixture"}]}},
                {"id":2,"operation":"state"}, {"id":3,"operation":"shutdown"}]
    result = subprocess.run([str(root / "runtime" / "PackageEngine.exe")],input="\n".join(json.dumps(m) for m in messages)+"\n",
                            capture_output=True, text=True, encoding="utf-8",timeout=30,env=env)
    assert result.returncode == 0, result.stderr
    responses = [json.loads(line) for line in result.stdout.splitlines()]
    assert responses[0]["type"] == "ready", responses
    assert responses[1]["ok"] and responses[1]["value"]["projects"][0]["artifact"] == "fms-p275", responses
    assert responses[2]["ok"] and responses[2]["value"]["activeTask"] is None, responses
    reopened = subprocess.run([str(root / "runtime" / "PackageEngine.exe")],input="\n".join(json.dumps(m) for m in messages)+"\n",
                              capture_output=True, text=True, encoding="utf-8",timeout=30,env=env)
    assert reopened.returncode == 0, reopened.stderr
    restored = [json.loads(line) for line in reopened.stdout.splitlines()]
    assert restored[1]["value"]["projectsCached"] is True, restored
    shell_data = {"war_path":str(Path(temporary)/"missing.war"),"upload_dir":str(Path(temporary)/"missing-upload"),
                  "trigger_url":"http://127.0.0.1:1/never-contacted","finish_dir":str(Path(temporary)/"finish")}
    shell_result = subprocess.run([str(root / "runtime" / "PackageEngine.exe"),"--shell"],input=json.dumps(shell_data)+"\n",
                                  capture_output=True,text=True,encoding="utf-8",timeout=20,env=env)
    shell_messages = [json.loads(line) for line in shell_result.stdout.splitlines()]
    assert shell_result.returncode == 0 and shell_messages[-1]["code"] == -1, shell_result.stderr
    for command in [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'feat: fixture release']]:
        subprocess.run(['git', *command], cwd=project, env=env, check=True, capture_output=True, timeout=20)
    records = []
    class ReleaseHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            records.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            body = json.dumps({'code': 200, 'data': {'moduleName': 'fms-p275', 'releases': [{}],
                'markdown': '## fms\\-p275 1.0\nfeat: fixture release'}}).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    server = HTTPServer(('127.0.0.1', 0), ReleaseHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        prepare_data = {'project': str(project), 'target': str(project / 'fms-project-starter'),
                        'release': {'url': f'http://127.0.0.1:{server.server_port}/release', 'count': 5}}
        prepare = subprocess.run([str(root / 'runtime' / 'PackageEngine.exe'), '--prepare'], input=json.dumps(prepare_data)+'\n',
                                 capture_output=True, text=True, encoding='utf-8', timeout=60, env=env)
        prepared = [json.loads(line) for line in prepare.stdout.splitlines()]
        assert prepare.returncode == 0 and prepared[-1]['type'] == 'prepared', (prepared, prepare.stderr)
        assert len(records) == 1 and records[0]['changes'] == [{'type': 'feat', 'content': 'feat: fixture release'}], records
        assert '## project 1.0' in prepared[-1]['releases'], prepared
        assert prepared[-1]['projectVersion'].startswith('1.0-'), prepared
        version_dir = project / 'fms-project-starter' / 'src/main/resources/version'
        assert all((version_dir / name).is_file() for name in ['project.md', 'project-version.md', 'project-releases.md'])
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(3)
    print('Frozen engine: startup, discovery, cached reopen, preparation helper/three version resources, state and shutdown passed. Local fixture HTTP only; no production services called.')
