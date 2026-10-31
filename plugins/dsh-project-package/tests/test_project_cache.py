import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from core.app_config import AppConfig
from core.git_repo import GitRepository
from git_status import parse_status
from project_cache import cached_discover
from service import PackageService
from test_engine import business_project


class ProjectCacheTests(unittest.TestCase):
    def test_disk_cache_reused_across_opens_and_invalidated_by_pom_or_force(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / 'project'
            business_project(project)
            cache = root / 'cache.json'
            workspaces = [{'path': str(project), 'title': 'test'}]
            first, hit = cached_discover(cache, workspaces, [])
            self.assertFalse(hit)
            with patch('project_cache.discover', side_effect=AssertionError('must not rescan')):
                second, hit = cached_discover(cache, workspaces, [str(project)])
                self.assertTrue(hit)
                self.assertEqual(first, second)
            pom = project / 'fms-project-starter/pom.xml'
            pom.write_text(pom.read_text() + '\n')
            with patch('project_cache.discover', return_value=first) as scan:
                self.assertFalse(cached_discover(cache, workspaces, [])[1])
                self.assertEqual(scan.call_count, 1)
                cached_discover(cache, workspaces, [], force=True)
                self.assertEqual(scan.call_count, 2)

    def test_workspace_change_and_deleted_module_do_not_reuse_stale_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / 'project'
            business_project(project)
            cache = root / 'cache.json'
            cached_discover(cache, [{'path': str(project)}], [])
            self.assertFalse(cached_discover(cache, [], [])[1])
            cached_discover(cache, [{'path': str(project)}], [])
            (project / 'fms-project-starter/pom.xml').unlink()
            result, hit = cached_discover(cache, [{'path': str(project)}], [])
            self.assertFalse(hit)
            self.assertEqual(result['projects'], [])

    def test_compact_git_status_handles_rename_and_detached_head(self):
        output = '# branch.oid abcdef123456\0# branch.head develop\0# branch.upstream origin/develop\0# branch.ab +2 -3\0' + \
                 '1 .M fake tracked.txt\0' + '2 R. fake new.txt\0old name.txt\0? new\nfile.txt\0'
        status = parse_status('D:/repo', output)
        self.assertEqual((status.branch, status.upstream, status.ahead, status.behind, status.changed_count), ('develop', 'origin/develop', 2, 3, 3))
        status = parse_status('D:/repo', '# branch.oid abcdef123456\0# branch.head (detached)\0')
        self.assertEqual(status.branch, 'detached@abcdef1')

    def test_switch_returns_before_git_and_late_result_cannot_overwrite_new_project(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first, second = root / 'first', root / 'second'
            business_project(first)
            business_project(second, 'wms-p277', 'wms-p277')
            started, release = threading.Event(), threading.Event()
            def inspect(project):
                if project == str(first):
                    started.set()
                    release.wait(3)
                return GitRepository(Path(project), Path(project).name, '', 0, 0, 0)
            with patch('service.load_config', return_value=AppConfig()), patch('service.load_options', return_value={}), \
                 patch('service.save_config'), patch('service.load_json', return_value=[]), \
                 patch('service.inspect_repository', side_effect=inspect):
                service = PackageService()
                try:
                    before = time.monotonic()
                    value = service.select(str(first))
                    self.assertLess(time.monotonic() - before, 1)
                    self.assertTrue(value['gitLoading'])
                    self.assertTrue(started.wait(1))
                    value = service.select(str(second))
                    self.assertEqual(value['selected']['path'], str(second))
                    self.assertIsNone(value['git'])
                    release.set()
                    worker = service.git_thread
                    worker.join(4)
                    self.assertEqual(service.state()['git']['branch'], 'second')
                    self.assertFalse(service.state()['gitLoading'])
                finally:
                    release.set()
                    service.close_panel()
                    if service.git_thread:
                        service.git_thread.join(4)
