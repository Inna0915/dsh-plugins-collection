"""core.shell_deploy 单元测试（仅覆盖纯函数 build_packaged_name）。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.shell_deploy import build_packaged_name  # noqa: E402
from core.git_log import format_project_version  # noqa: E402


class BuildPackagedNameTest(unittest.TestCase):
    def test_name_version_timestamp(self):
        self.assertEqual(
            build_packaged_name("orig-stem", "wms-258", "1.2.3", "202606181626"),
            "wms-258-1.2.3-202606181626",
        )

    def test_version_omitted_when_empty(self):
        self.assertEqual(
            build_packaged_name("orig-stem", "wms-258", "", "202606181626"),
            "wms-258-202606181626",
        )

    def test_falls_back_to_stem_when_no_name(self):
        self.assertEqual(
            build_packaged_name("orig-stem", "", "1.0", "202606181626"),
            "orig-stem-1.0-202606181626",
        )

    def test_test_version_prefix(self):
        self.assertEqual(
            build_packaged_name("orig-stem", "wms-258", "1.0.0", "202606181716", True),
            "test-wms-258-1.0.0-202606181716",
        )


class ProjectVersionTest(unittest.TestCase):
    def test_project_version_strips_snapshot_and_adds_timestamp(self):
        self.assertEqual(
            format_project_version("1.0.0-SNAPSHOT", "202606181716"),
            "1.0.0-202606181716",
        )

    def test_project_version_keeps_release_version_and_adds_timestamp(self):
        self.assertEqual(
            format_project_version("1.0.0", "202606181716"),
            "1.0.0-202606181716",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
