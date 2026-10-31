"""用真实 JAR 资源验证整份说明的模式切换，防止前端旧日期混入后端版本说明。"""
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from core.jar_reader import _read_zip_entry
from core.version_notes import build_project_preview, build_version_notes


class GlobalReleaseDisplayTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lib = self.root / "app-starter/target/app/WEB-INF/lib"
        self.lib.mkdir(parents=True)
        self.legacy = "2026-10-07\n  feat: 项目旧日期内容\n"
        self.backend_release = "## wms 10.29.0\n\n### 新增功能\n\n- feat: 后端版本内容"
        self.project_release = "## project 1.2.0\n\n### 问题修复\n\n- fix(project): 项目版本内容"

    def jar(self, module, releases=None):
        name = "wms-platform" if module == "wms" else module
        with zipfile.ZipFile(self.lib / f"{name}-10.29.0.jar", "w") as jar:
            jar.writestr(f"version/{module}.md", f"2026-10-07\n  feat: {module}旧日期内容\n")
            jar.writestr(f"version/{module}-version.md", "10.29.0-20261007120000\n")
            if releases is not None:
                jar.writestr(f"version/{module}-releases.md", releases)

    def build(self, project_releases=""):
        return build_version_notes(str(self.root), self.legacy, "1.2.0-202610071200", project_releases)[0]

    def test_later_backend_release_suppresses_earlier_front_and_project_dates(self):
        self.jar("wms-front")
        self.jar("wms", self.backend_release)
        md = self.build()
        self.assertIn(self.backend_release, md)
        self.assertNotIn("旧日期内容", md)
        self.assertNotIn("## 更新记录", md)
        for module in ("project", "wms-front", "wms"):
            self.assertIn(f"- **[{module}]**", md)

    def test_project_release_alone_suppresses_all_product_dates(self):
        self.jar("wms-front")
        self.jar("wms", " \n\t")
        md = self.build(self.project_release)
        self.assertIn(self.project_release, md)
        self.assertNotIn("旧日期内容", md)
        self.assertIn("- **[wms]** 10.29.0", md)

    def test_all_release_sections_preserve_order_and_markdown(self):
        self.jar("wms-front", "## wms-front 10.29.0\n\n- feat: 前端版本内容")
        self.jar("wms", self.backend_release + "\n\n## wms 10.28.0\n\n- fix: 上一版本")
        md = self.build(self.project_release)
        self.assertLess(md.index("## project 1.2.0"), md.index("## wms-front"))
        self.assertLess(md.index("## wms-front"), md.index("## wms 10.29.0"))
        self.assertIn("## wms 10.28.0", md)
        self.assertNotIn("旧日期内容", md)

    def test_blank_or_unreadable_resources_fall_back_only_when_all_absent(self):
        self.jar("wms-front", " \n\t")
        self.jar("wms", b"\xff\xfe")
        md = self.build()
        for module in ("项目", "wms-front", "wms"):
            self.assertIn(f"{module}旧日期内容", md)
        self.assertEqual(md.count("### 2026-10-07"), 1)

    def test_one_unreadable_release_does_not_restore_dates_with_valid_other(self):
        self.jar("wms-front", b"\xff\xfe")
        self.jar("wms", self.backend_release)
        md = self.build()
        self.assertIn(self.backend_release, md)
        self.assertNotIn("旧日期内容", md)

    def test_new_mode_never_reads_legacy_jar_entries(self):
        self.jar("wms-front")
        self.jar("wms", self.backend_release)
        with patch("core.jar_reader._read_zip_entry", wraps=_read_zip_entry) as read:
            self.build()
            paths = [c.args[1] for c in read.call_args_list]
        self.assertNotIn("version/wms.md", paths)
        self.assertNotIn("version/wms-front.md", paths)

    def test_preview_uses_project_release_and_build_version(self):
        md = build_project_preview(self.legacy, "1.2.0-202610071200", self.project_release)
        self.assertIn(self.project_release, md)
        self.assertIn("- **[project]** 1.2.0-202610071200", md)
        self.assertNotIn("旧日期内容", md)

    def test_broken_jar_does_not_prevent_other_release_display(self):
        (self.lib / "wms-front-10.29.0.jar").write_bytes(b"broken zip")
        self.jar("wms", self.backend_release)
        self.assertIn(self.backend_release, self.build())


if __name__ == "__main__":
    unittest.main()
