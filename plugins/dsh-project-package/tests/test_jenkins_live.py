import threading
import unittest
from unittest.mock import MagicMock, patch

from jenkins_live import JenkinsLive, read_builds, view_url
from core.jenkins_client import JenkinsAuthenticationError


class JenkinsFeedTests(unittest.TestCase):
    def response(self, payload, status=200):
        response = MagicMock()
        response.__enter__.return_value = response
        response.status_code = status
        response.json.return_value = payload
        return response

    def test_view_address_supports_context_path_and_original_builds_url(self):
        self.assertEqual(view_url('https://ci.test/jenkins/'), 'https://ci.test/jenkins/view/all')
        self.assertEqual(view_url('https://ci.test/view/team/builds?ignored=1'), 'https://ci.test/view/team')
        with self.assertRaises(ValueError):
            view_url('file:///tmp/jenkins')

    def test_running_first_and_count_before_display_limit(self):
        jobs = [{"name": f"job-{i}", "color": "blue", "lastBuild": {"number": i, "building": i < 15, "timestamp": i * 1000}} for i in range(17)]
        jobs.append({"name": "never-built"})
        with patch('jenkins_live.requests.get', return_value=self.response({"jobs": jobs})) as request:
            data = read_builds({"jenkins_url": 'https://ci.test'})
        self.assertEqual(data['runningCount'], 15)
        self.assertEqual(len(data['builds']), 12)
        self.assertEqual(data['builds'][0]['jobName'], 'job-14')
        self.assertTrue(all(build['building'] for build in data['builds']))
        self.assertEqual(request.call_args.kwargs['timeout'], (3, 10))
        self.assertFalse(request.call_args.kwargs['allow_redirects'])

    def test_finished_status_duration_and_credentials_stay_server_side(self):
        payload = {"jobs": [{"name": "fms", "url": "https://ci.test/job/fms", "color": "blue", "lastBuild": {"number": 65, "timestamp": 1000, "duration": 49000}}]}
        with patch('jenkins_live.requests.get', return_value=self.response(payload)) as request, patch('jenkins_live.reveal', return_value='secret'):
            data = read_builds({"jenkins_url": 'https://ci.test', 'jenkins_user': 'user', 'jenkins_secret': 'encrypted'})
        self.assertEqual(data['builds'][0]['result'], 'SUCCESS')
        self.assertEqual(data['builds'][0]['duration'], 49000)
        self.assertEqual(request.call_args.kwargs['auth'], ('user', 'secret'))
        self.assertNotIn('secret', str(data))

    def test_auth_and_invalid_responses_are_errors_not_empty_success(self):
        with patch('jenkins_live.requests.get', return_value=self.response({}, 401)):
            with self.assertRaises(JenkinsAuthenticationError):
                read_builds({'jenkins_url': 'https://ci.test'})
        with patch('jenkins_live.requests.get', return_value=self.response({})):
            with self.assertRaisesRegex(ValueError, '不是任务列表'):
                read_builds({'jenkins_url': 'https://ci.test'})

    def test_lazy_cache_and_errors_keep_last_known_data(self):
        feed = JenkinsLive()
        self.assertIsNone(feed.thread)
        with patch('jenkins_live.read_builds', return_value={'builds': [{'jobName': 'fms'}], 'fetchedAt': 1000}) as read:
            feed.poll({})
            feed.thread.join(2)
            feed.poll({})
            self.assertEqual(read.call_count, 1)
        feed.last_poll = None
        with patch('jenkins_live.read_builds', side_effect=ValueError('offline')):
            feed.poll({})
            feed.thread.join(2)
        data = feed.snapshot()
        self.assertEqual(data['fetchedAt'], 1000)
        self.assertEqual(data['builds'][0]['jobName'], 'fms')
        self.assertEqual(data['error'], 'offline')
        self.assertFalse(data['loading'])

    def test_close_discards_inflight_result_and_does_not_start_another_request(self):
        feed = JenkinsLive()
        started, finish = threading.Event(), threading.Event()
        def blocked(_):
            started.set()
            finish.wait(2)
            return {'fetchedAt': 999}
        with patch('jenkins_live.read_builds', side_effect=blocked) as read:
            try:
                feed.poll({})
                self.assertTrue(started.wait(1))
                feed.poll({})
                self.assertEqual(read.call_count, 1)
                feed.close()
            finally:
                finish.set()
                feed.thread.join(2)
        self.assertEqual(feed.snapshot()['fetchedAt'], 0)
        self.assertFalse(feed.snapshot()['loading'])

