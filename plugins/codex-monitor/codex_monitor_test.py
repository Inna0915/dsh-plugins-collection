import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).with_name('codex_monitor.py')
SPEC = importlib.util.spec_from_file_location('codex_monitor', MODULE_PATH)
codex_monitor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(codex_monitor)


class RefreshHandler(BaseHTTPRequestHandler):
    requests = []

    def do_GET(self):
        body = json.dumps({
            'sessions': [
                {
                    'sessionId': 'running-session',
                    'status': 'running',
                    'title': 'Build Monitor',
                    'cwd': r'M:\master\workspace\deepseek'
                },
                {
                    'sessionId': 'completed-session',
                    'status': 'turn_completed',
                    'title': 'Completed Work',
                    'cwd': r'M:\master\workspace\deepseek'
                },
                {
                    'sessionId': 'unknown-review-session',
                    'status': 'unknown',
                    'reviewable': True,
                    'title': 'Review Unknown',
                    'cwd': r'M:\master\workspace\AI'
                },
                {
                    'sessionId': 'unknown-record-session',
                    'status': 'unknown',
                    'reviewable': False,
                    'title': 'Record Unknown',
                    'cwd': r'M:\master\workspace\AI'
                },
                {
                    'sessionId': 'record-session',
                    'status': 'record',
                    'title': 'Recorded Work',
                    'cwd': r'M:\master\workspace\deepseek'
                }
            ],
            'generatedAt': '2026-09-03T01:00:00.000Z',
            'refreshing': False,
            'window': {'days': 7, 'limit': 30}
        }).encode('utf-8')
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        size = int(self.headers.get('content-length', '0'))
        payload = json.loads(self.rfile.read(size).decode('utf-8'))
        type(self).requests.append((self.path, payload))
        body = json.dumps({
            'accepted': True,
            'scope': 'session' if payload.get('sessionId') else 'default'
        }).encode('utf-8')
        self.send_response(202)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        pass


class CodexMonitorCliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        RefreshHandler.requests = []
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), RefreshHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def invoke(self, *arguments):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with mock.patch.object(sys, 'argv', ['codex_monitor.py', '--base', self.base, *arguments]):
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                codex_monitor.main()
        return json.loads(stdout.getvalue()), stderr.getvalue()

    def test_refresh_default_window(self):
        result, error = self.invoke('refresh')
        self.assertEqual(error, '')
        self.assertEqual(result['scope'], 'default')
        self.assertEqual(RefreshHandler.requests[-1], ('/codex-monitor/refresh', {}))

    def test_refresh_one_session(self):
        session_id = '01a058d0-0aa1-7f31-b751-8ce3e264e7bb'
        result, error = self.invoke('refresh', session_id)
        self.assertEqual(error, '')
        self.assertEqual(result['scope'], 'session')
        self.assertEqual(
            RefreshHandler.requests[-1],
            ('/codex-monitor/refresh', {'sessionId': session_id}))

    def test_refresh_namespaced_sessions(self):
        for session_id in ['dsh:session-example', 'kimi:session_example', 'kimi-cli:legacy', 'claude:example']:
            result, error = self.invoke('refresh', session_id)
            self.assertEqual(error, '')
            self.assertEqual(result['scope'], 'session')
            self.assertEqual(RefreshHandler.requests[-1], ('/codex-monitor/refresh', {'sessionId': session_id}))

    def test_namespaced_session_rejects_paths(self):
        for session_id in ['dsh:../../secret', 'claude:C:/private', 'kimi:', 'DSH:example']:
            self.assertIsNone(codex_monitor.SESSION_ID_PATTERN.fullmatch(session_id))

    def test_list_status_uses_board_lanes(self):
        expected = {
            'running': ['running-session'],
            'review': ['completed-session', 'unknown-review-session'],
            'record': ['unknown-record-session', 'record-session']
        }
        for status, session_ids in expected.items():
            with self.subTest(status=status):
                result, error = self.invoke('list', '--status', status)
                self.assertEqual(error, '')
                self.assertEqual(
                    [session['sessionId'] for session in result['sessions']],
                    session_ids)
                self.assertEqual(result['count'], len(session_ids))

    def test_list_filters_cwd_and_title_case_insensitively(self):
        result, error = self.invoke(
            'list', '--cwd', r'WORKSPACE\DEEPSEEK', '--keyword', 'build')
        self.assertEqual(error, '')
        self.assertEqual(result['count'], 1)
        self.assertEqual(result['sessions'][0]['sessionId'], 'running-session')
        self.assertEqual(result['window'], {'days': 7, 'limit': 30})

    def test_invalid_session_id_is_rejected_before_http(self):
        previous_count = len(RefreshHandler.requests)
        with mock.patch.object(
                sys, 'argv', ['codex_monitor.py', '--base', self.base, 'refresh', 'invalid']):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaisesRegex(SystemExit, '1'):
                    codex_monitor.main()
        self.assertEqual(len(RefreshHandler.requests), previous_count)


class CodexMonitorHookTest(unittest.TestCase):
    def test_hook_refreshes_default_window_without_forwarding_session_id(self):
        session_id = '01a064d1-d9d1-78c0-b5bb-02152c9b07a5'
        event = {
            'hook_event_name': 'UserPromptSubmit',
            'session_id': session_id
        }
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            capture = root / 'arguments.txt'
            fake_python = root / 'python.cmd'
            fake_python.write_text(
                '@echo off\n'
                '> "%CODEX_MONITOR_TEST_CAPTURE%" echo %*\n'
                'exit /b 0\n',
                encoding='ascii')
            env = os.environ.copy()
            env['CODEX_MONITOR_PYTHON'] = str(fake_python)
            env['CODEX_MONITOR_TEST_CAPTURE'] = str(capture)

            completed = subprocess.run(
                [
                    'pwsh.exe', '-NoLogo', '-NoProfile', '-NonInteractive',
                    '-File', str(MODULE_PATH.with_name('codex-monitor-hook.ps1'))
                ],
                input=json.dumps(event),
                capture_output=True,
                text=True,
                encoding='utf-8',
                env=env,
                check=False)

            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(completed.stdout, '{}')
            arguments = capture.read_text(encoding='ascii').strip()
            self.assertRegex(arguments, r'codex_monitor\.py --timeout 2 --quiet refresh$')
            self.assertNotIn(session_id, arguments)


if __name__ == '__main__':
    unittest.main()
