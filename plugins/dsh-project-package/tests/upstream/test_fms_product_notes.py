"""Use real isolated JAR fixtures to verify FMS readers without changing WMS behavior."""
import tempfile
import unittest
import zipfile
from pathlib import Path

from core.jar_reader import PRODUCT_JARS, collect_product_notes
from core.version_notes import build_version_notes


class FmsProductNotesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lib = self.root / "fms-project-starter/target/app/WEB-INF/lib"
        self.lib.mkdir(parents=True)
        self.front_release = "## fms\\-front 8.27.2\n\n### 新增功能\n\n- feat: 前端发布内容"
        self.backend_release = "## fms 8.27.2\n\n### 问题修复\n\n- fix(warehouse): 后端发布内容"
        self.project_release = "## project 1.0.0\n\n- fix(project): 项目发布内容"

    def make_jar(self, filename, resources):
        with zipfile.ZipFile(self.lib / filename, "w") as jar:
            for entry, content in resources.items():
                jar.writestr(entry, content)

    def seed_products(self, front_release=None, backend_release=None):
        for carrier, module, releases in (
            ("fms-front", "fms-front", front_release),
            ("fms-warehouse", "fms", backend_release),
        ):
            resources = {
                f"version/{module}-version.md": "8.27.2-20261021101002\n",
                f"version/{module}.md": f"2026-10-21\n  feat: {module}旧日期内容\n",
            }
            if releases is not None:
                resources[f"version/{module}-releases.md"] = releases
            self.make_jar(f"{carrier}-8.27.2-SNAPSHOT.jar", resources)

    def build(self, project_releases=""):
        return build_version_notes(
            str(self.root), "2026-10-21\n  feat: 项目旧日期内容\n",
            "1.0.0-202610212128", project_releases,
        )

    def test_fms_mapping_uses_front_and_warehouse_and_derives_resource_names(self):
        expected = {
            "fms-front": ("fms-front-*.jar", "version/fms-front.md", "fms-front"),
            "fms": ("fms-warehouse-*.jar", "version/fms.md", "fms"),
        }
        for module, mapping in expected.items():
            matches = [entry for entry in PRODUCT_JARS if entry[2] == module]
            self.assertEqual(matches, [mapping])
            self.assertEqual(mapping[1].removesuffix(".md") + "-releases.md",
                             f"version/{module}-releases.md")
            self.assertEqual(mapping[1].removesuffix(".md") + "-version.md",
                             f"version/{module}-version.md")

    def test_front_and_backend_release_sections_preserve_raw_markdown_and_order(self):
        self.seed_products(self.front_release, self.backend_release)
        markdown, logs = self.build(self.project_release)
        for section in (self.project_release, self.front_release, self.backend_release):
            self.assertIn(section, markdown)
        self.assertLess(markdown.index(self.project_release), markdown.index(self.front_release))
        self.assertLess(markdown.index(self.front_release), markdown.index(self.backend_release))
        for module in ("fms-front", "fms"):
            self.assertIn(f"- **[{module}]** 8.27.2-20261021101002", markdown)
        self.assertNotIn("旧日期内容", markdown)
        self.assertFalse(any("[WARN]" in log for log in logs), logs)

    def test_fms281_front_resource_is_shown_when_backend_jar_has_no_resources(self):
        self.seed_products(self.front_release)
        self.make_jar("fms-warehouse-8.27.2-SNAPSHOT.jar", {})
        self.make_jar("fms-platform-8.27.2-SNAPSHOT.jar", {})
        markdown, logs = self.build(self.project_release)
        self.assertIn(self.front_release, markdown)
        self.assertIn("- **[fms-front]** 8.27.2-20261021101002", markdown)
        self.assertNotIn("- **[fms]**", markdown)
        self.assertIn("[WARN] [fms] fms-warehouse-8.27.2-SNAPSHOT.jar 中无 version/fms-version.md", logs)
        self.assertFalse(any("[wms" in log for log in logs), logs)

    def test_missing_backend_jar_does_not_hide_front_or_report_unrelated_wms(self):
        self.seed_products(self.front_release)
        (self.lib / "fms-warehouse-8.27.2-SNAPSHOT.jar").unlink()
        markdown, logs = self.build()
        self.assertIn(self.front_release, markdown)
        self.assertEqual([log for log in logs if "[WARN]" in log],
                         ["[WARN] [fms] lib 中未找到 fms-warehouse-*.jar"])

    def test_front_release_suppresses_backend_and_project_date_records(self):
        self.seed_products(self.front_release)
        markdown, _ = self.build()
        self.assertIn(self.front_release, markdown)
        self.assertIn("- **[fms]** 8.27.2", markdown)
        self.assertNotIn("旧日期内容", markdown)

    def test_backend_release_suppresses_front_and_project_date_records(self):
        self.seed_products(None, self.backend_release)
        markdown, _ = self.build()
        self.assertIn(self.backend_release, markdown)
        self.assertIn("- **[fms-front]** 8.27.2", markdown)
        self.assertNotIn("旧日期内容", markdown)

    def test_all_absent_or_blank_releases_use_combined_date_fallback(self):
        self.seed_products(" \n", "\t")
        markdown, logs = self.build()
        for module in ("项目", "fms-front", "fms"):
            self.assertIn(f"{module}旧日期内容", markdown)
        self.assertEqual(markdown.count("### 2026-10-21"), 1)
        self.assertFalse(any("[WARN]" in log for log in logs), logs)

    def test_project_release_suppresses_legacy_fms_but_keeps_versions(self):
        self.seed_products()
        markdown, _ = self.build(self.project_release)
        self.assertIn(self.project_release, markdown)
        self.assertNotIn("旧日期内容", markdown)
        for module in ("fms-front", "fms"):
            self.assertIn(f"- **[{module}]** 8.27.2", markdown)

    def test_platform_common_and_project_jars_do_not_replace_backend_carrier(self):
        self.seed_products(self.front_release, self.backend_release)
        for name in ("fms-platform", "fms-common", "fms-project-module"):
            self.make_jar(f"{name}-8.27.2-SNAPSHOT.jar", {
                "version/fms-releases.md": "## fms 99.0.0\n\n- fix: 错误载体内容",
                "version/fms-version.md": "错误载体版本",
            })
        markdown, _ = self.build()
        self.assertEqual(markdown.count(self.backend_release), 1)
        self.assertNotIn("错误载体", markdown)

    def test_sources_javadoc_and_test_classifier_jars_are_excluded(self):
        for carrier, module in (("fms-front", "fms-front"), ("fms-warehouse", "fms")):
            for classifier in ("sources", "javadoc", "tests"):
                self.make_jar(f"{carrier}-8.27.2-{classifier}.jar", {
                    f"version/{module}-releases.md": "附加包内容",
                    f"version/{module}-version.md": "附加包版本",
                })
        self.seed_products(self.front_release, self.backend_release)
        markdown, _ = self.build()
        self.assertNotIn("附加包", markdown)
        self.assertIn(self.front_release, markdown)
        self.assertIn(self.backend_release, markdown)

    def test_mixed_fms_wms_dependencies_are_both_read(self):
        self.seed_products(self.front_release, self.backend_release)
        for carrier, module in (("wms-front", "wms-front"), ("wms-platform", "wms")):
            self.make_jar(f"{carrier}-10.29.0.jar", {
                f"version/{module}-releases.md": f"## {module} 10.29.0\n\n- fix: WMS内容",
                f"version/{module}-version.md": "10.29.0\n",
            })
        notes = collect_product_notes(str(self.root))
        self.assertEqual(set(notes.releases), {"wms-front", "wms", "fms-front", "fms"})
        self.assertEqual(set(notes.versions), set(notes.releases))
        self.assertFalse(any("[WARN]" in log for log in notes.logs), notes.logs)

    def test_broken_front_does_not_prevent_backend_release(self):
        self.seed_products(None, self.backend_release)
        (self.lib / "fms-front-8.27.2-SNAPSHOT.jar").write_bytes(b"broken zip")
        markdown, logs = self.build()
        self.assertIn(self.backend_release, markdown)
        self.assertNotIn("- **[fms-front]**", markdown)
        self.assertFalse(any("[wms" in log for log in logs), logs)

    def test_noncarrier_fms_jar_still_identifies_family_and_missing_carriers(self):
        self.make_jar("fms-platform-8.27.2-SNAPSHOT.jar", {})
        notes = collect_product_notes(str(self.root))
        self.assertEqual(notes.versions, {})
        self.assertEqual(notes.logs, [
            "[WARN] [fms-front] lib 中未找到 fms-front-*.jar",
            "[WARN] [fms] lib 中未找到 fms-warehouse-*.jar",
        ])

    def test_version_only_resource_is_independent_of_release_and_date_text(self):
        self.make_jar("fms-warehouse-8.27.2-SNAPSHOT.jar", {
            "version/fms-version.md": "\ufeff\n  8.27.2-20261021101002  \n",
        })
        notes = collect_product_notes(str(self.root))
        self.assertEqual(notes.versions, {"fms": "8.27.2-20261021101002"})
        self.assertEqual(notes.entries, [])
        self.assertEqual(notes.releases, {})


if __name__ == "__main__":
    unittest.main()
