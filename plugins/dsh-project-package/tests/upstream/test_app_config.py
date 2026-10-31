import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.app_config import (  # noqa: E402
    AppConfig,
    MAX_RECENT_PROJECTS,
    load_config,
    normalize_recent_projects,
    remember_project,
    save_config,
)


class RecentProjectsTest(unittest.TestCase):
    def test_filters_deduplicates_and_limits(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dirs = []
            for index in range(MAX_RECENT_PROJECTS + 2):
                directory = root / f"p{index}"
                directory.mkdir()
                dirs.append(str(directory))
            result = normalize_recent_projects([dirs[0], dirs[0], *dirs, root / "missing"])
            self.assertEqual(len(result), MAX_RECENT_PROJECTS)
            self.assertEqual(result[0], str(Path(dirs[0]).resolve()))

    def test_remember_moves_directory_to_front(self):
        with tempfile.TemporaryDirectory() as temp:
            first = Path(temp) / "first"
            second = Path(temp) / "second"
            first.mkdir()
            second.mkdir()
            result = remember_project([str(first), str(second)], str(second))
            self.assertEqual(result, [str(second.resolve()), str(first.resolve())])


class ConfigPersistenceTest(unittest.TestCase):
    def test_round_trip(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "project"
            project.mkdir()
            path = root / "config" / "config.json"
            config = AppConfig([str(project)], {"enabled": False})
            save_config(config, path)
            loaded = load_config(path, root / "no-last", root / "no-shell")
            self.assertEqual(loaded.recent_projects, [str(project.resolve())])
            self.assertFalse(loaded.shell["enabled"])
            self.assertIn("trigger_url", loaded.shell)
            self.assertFalse(path.with_suffix(".json.tmp").exists())

    def test_migrates_legacy_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            project = root / "project"
            project.mkdir()
            config_path = root / "new" / "config.json"
            legacy_last = root / "last.txt"
            legacy_shell = root / "shell.json"
            legacy_last.write_text(str(project), encoding="utf-8")
            legacy_shell.write_text(
                json.dumps({"enabled": False, "upload_dir": "X:/upload"}),
                encoding="utf-8",
            )

            loaded = load_config(config_path, legacy_last, legacy_shell)

            self.assertEqual(loaded.recent_projects, [str(project.resolve())])
            self.assertFalse(loaded.shell["enabled"])
            self.assertEqual(loaded.shell["upload_dir"], "X:/upload")
            self.assertTrue(config_path.exists())

    def test_corrupt_json_returns_defaults(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config.json"
            path.write_text("{broken", encoding="utf-8")
            loaded = load_config(path, Path(temp) / "last", Path(temp) / "shell")
            self.assertEqual(loaded.recent_projects, [])
            self.assertTrue(loaded.shell["enabled"])

    def test_release_configuration_survives_shell_and_project_updates(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "config.json"
            config = AppConfig(release={"url": "http://example.invalid/release", "count": 12})
            save_config(config, path)
            config = load_config(path, legacy_release_path=root / "missing")
            config.recent_projects = [str(root)]
            config.shell["enabled"] = False
            save_config(config, path)
            loaded = load_config(path, legacy_release_path=root / "missing")
            self.assertEqual(loaded.release, {"url": "http://example.invalid/release", "count": 12})
            self.assertEqual(loaded.recent_projects, [str(root.resolve())])
            self.assertFalse(loaded.shell["enabled"])

    def test_existing_v141_config_migrates_archive_release_settings_only_once(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "config.json"
            legacy = root / "release.json"
            path.write_text(json.dumps({"recent_projects": [str(root)], "shell": {"enabled": False}}), encoding="utf-8")
            legacy.write_text(json.dumps({"url": "http://example.invalid/old", "count": 7}), encoding="utf-8")
            loaded = load_config(path, legacy_release_path=legacy)
            self.assertEqual(loaded.release["count"], 7)
            self.assertFalse(loaded.shell["enabled"])
            self.assertEqual(loaded.recent_projects, [str(root.resolve())])
            legacy.write_text(json.dumps({"url": "http://example.invalid/changed", "count": 9}), encoding="utf-8")
            self.assertEqual(load_config(path, legacy_release_path=legacy).release, loaded.release)

    def test_first_run_migrates_archive_release_file(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            legacy = root / "release.json"
            legacy.write_text(json.dumps({"url": "http://example.invalid/archive", "count": 3}), encoding="utf-8")
            config = load_config(root / "new.json", root / "missing-last", root / "missing-shell", legacy)
            self.assertEqual(config.release, {"url": "http://example.invalid/archive", "count": 3})

    def test_invalid_release_values_do_not_become_runtime_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config.json"
            for count in (0, 51, True, "5"):
                with self.subTest(count=count):
                    path.write_text(json.dumps({"release": {"url": 12, "count": count}}), encoding="utf-8")
                    loaded = load_config(path)
                    self.assertEqual(loaded.release["count"], 5)
                    self.assertIsInstance(loaded.release["url"], str)


if __name__ == "__main__":
    unittest.main(verbosity=2)
