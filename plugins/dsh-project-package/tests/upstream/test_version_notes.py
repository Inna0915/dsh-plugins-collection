"""core.version_notes 单元测试（stdlib unittest，无额外依赖）。

运行：
    python -m unittest discover -s tests -v
或：
    python tests/test_version_notes.py
"""
import sys
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path

# 将项目根目录加入 sys.path，确保可 import core.*
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.jar_reader import _Entry, collect_product_data  # noqa: E402
from core.version_notes import (  # noqa: E402
    VERSION_NOTES_FILENAME,
    build_project_preview,
    build_version_notes,
    write_version_notes,
    _parse_project_entries,
    _render_history,
    _render_versions,
)


class ParseProjectEntriesTest(unittest.TestCase):
    def test_parses_with_project_module(self):
        raw = "2026-06-18\n  feat: A\n  fix: B\n2026-06-17\n  feat: C\n"
        entries = _parse_project_entries(raw)
        self.assertEqual([e.module for e in entries], ["project", "project", "project"])
        self.assertEqual(entries[0].date, date(2026, 6, 18))
        self.assertEqual(entries[0].description, "feat: A")
        self.assertEqual(entries[2].date, date(2026, 6, 17))

    def test_empty_returns_no_entries(self):
        self.assertEqual(_parse_project_entries(""), [])
        self.assertEqual(_parse_project_entries(None), [])

    def test_message_without_date_skipped(self):
        entries = _parse_project_entries("  feat: 无日期\n2026-06-18\n  feat: 有效\n")
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0].description, "feat: 有效")


class RenderVersionsTest(unittest.TestCase):
    def test_render(self):
        out = _render_versions({"project": "1.2.3", "wms": "3.3.0-2026"})
        self.assertIn("- **[project]** 1.2.3", out)
        self.assertIn("- **[wms]** 3.3.0-2026", out)

    def test_empty_placeholder(self):
        self.assertEqual(_render_versions({}), "（未读取到版本号）")


class RenderHistoryTest(unittest.TestCase):
    def test_merged_and_date_desc(self):
        entries = [
            _Entry(date(2026, 6, 17), "project", "feat: P-old"),
            _Entry(date(2026, 6, 18), "project", "feat: P-new"),
            _Entry(date(2026, 6, 18), "wms", "fix: Q"),
        ]
        out = _render_history(entries)
        # 日期倒序：06-18 在 06-17 之前
        self.assertLess(out.index("### 2026-06-18"), out.index("### 2026-06-17"))
        # 同一列表内合并项目与产品，带模块标签
        self.assertIn("- **[project]** feat(project): P-new", out)
        self.assertIn("- **[wms]** fix: Q", out)
        self.assertIn("- **[project]** feat(project): P-old", out)

    def test_empty_placeholder(self):
        self.assertEqual(_render_history([]), "（无更新记录）")


class BuildProjectPreviewTest(unittest.TestCase):
    def test_preview_contains_project_only(self):
        out = build_project_preview("2026-06-18\n  feat: A\n")
        self.assertEqual(out.splitlines()[0], "# 版本说明")
        self.assertIn("## 更新记录", out)
        self.assertIn("- **[project]** feat(project): A", out)
        # 预览阶段无产品版本号
        self.assertIn("（未读取到版本号）", out)


class BuildVersionNotesTest(unittest.TestCase):
    def _make_product_jar(self, lib_dir: Path) -> None:
        """构造一个含 version/wms.md 与 version/wms-version.md 的产品 jar。"""
        lib_dir.mkdir(parents=True, exist_ok=True)
        jar = lib_dir / "wms-platform-10.28.0-SNAPSHOT.jar"
        with zipfile.ZipFile(jar, "w") as zf:
            zf.writestr("version/wms.md", "2026-06-18\n  feat: 产品功能\n")
            zf.writestr("version/wms-version.md", "3.3.0-20260618142454\n")

    def test_merges_project_and_product_with_versions(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            lib = root / "app-starter" / "target" / "app" / "WEB-INF" / "lib"
            self._make_product_jar(lib)

            md, logs = build_version_notes(str(root), "2026-06-18\n  feat: 项目功能\n")

            # 版本信息：体现产品 version.md 的版本号
            self.assertIn("## 版本信息", md)
            self.assertIn("- **[wms]** 3.3.0-20260618142454", md)
            # 更新记录：项目与产品合并为单一列表
            self.assertIn("## 更新记录", md)
            self.assertIn("- **[project]** feat(project): 项目功能", md)
            self.assertIn("- **[wms]** feat: 产品功能", md)
            # 同日期合并到同一 ### 标题下（仅一个 2026-06-18 分组）
            self.assertEqual(md.count("### 2026-06-18"), 1)

    def test_no_jars_still_outputs_project(self):
        with tempfile.TemporaryDirectory() as d:
            md, _ = build_version_notes(d, "2026-06-18\n  feat: 项目功能\n")
            self.assertIn("- **[project]** feat(project): 项目功能", md)
            self.assertIn("（未读取到版本号）", md)

    def test_project_version_from_root_pom(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "pom.xml").write_text(
                '<project xmlns="http://maven.apache.org/POM/4.0.0">\n'
                "  <artifactId>wms-258</artifactId>\n"
                "  <version>1.2.3-SNAPSHOT</version>\n"
                "</project>\n",
                encoding="utf-8",
            )
            md, _ = build_version_notes(
                str(d),
                "2026-06-18\n  feat: 项目功能\n",
                "1.2.3-202606181716",
            )
            # 版本信息复用 project-version.md 的值，不显示 artifactId。
            self.assertIn("- **[project]** 1.2.3-202606181716", md)
            self.assertNotIn("wms-258 1.2.3", md)


class PomReaderTest(unittest.TestCase):
    def _write_pom(self, d: str, body: str) -> None:
        (Path(d) / "pom.xml").write_text(
            '<project xmlns="http://maven.apache.org/POM/4.0.0">\n' + body + "</project>\n",
            encoding="utf-8",
        )

    def test_reads_artifact_and_version(self):
        from core.pom_reader import read_root_pom
        with tempfile.TemporaryDirectory() as d:
            self._write_pom(d, "  <artifactId>wms-258</artifactId>\n  <version>1.2.3-SNAPSHOT</version>\n")
            self.assertEqual(read_root_pom(d), ("wms-258", "1.2.3-SNAPSHOT"))

    def test_version_falls_back_to_parent(self):
        from core.pom_reader import read_root_pom
        with tempfile.TemporaryDirectory() as d:
            self._write_pom(
                d,
                "  <parent><artifactId>p</artifactId><version>9.9.9</version></parent>\n"
                "  <artifactId>child</artifactId>\n",
            )
            self.assertEqual(read_root_pom(d), ("child", "9.9.9"))

    def test_missing_pom_returns_empty(self):
        from core.pom_reader import read_root_pom
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(read_root_pom(d), ("", ""))

    def test_strip_snapshot(self):
        from core.pom_reader import strip_snapshot
        self.assertEqual(strip_snapshot("1.2.3-SNAPSHOT"), "1.2.3")
        self.assertEqual(strip_snapshot("1.2.3"), "1.2.3")
        self.assertEqual(strip_snapshot(""), "")


class CollectProductDataTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.lib = self.root / "app-starter" / "target" / "app" / "WEB-INF" / "lib"
        self.lib.mkdir(parents=True)

    def _make_jar(self, filename: str, resources: dict[str, str]) -> None:
        with zipfile.ZipFile(self.lib / filename, "w") as zf:
            for entry, content in resources.items():
                zf.writestr(entry, content)

    def _make_front_jar(self) -> None:
        self._make_jar("wms-front-10.28.0-SNAPSHOT.jar", {
            "version/wms-front.md": "2026-09-26\n  feat: 前端功能\n",
            "version/wms-front-version.md": "10.28.0-20260926131859\n",
        })

    def test_merges_front_unified_wms_and_project_ignoring_old_modules(self):
        self._make_front_jar()
        self._make_jar("wms-platform-10.28.0-SNAPSHOT.jar", {
            "version/wms.md": "2026-09-27\n  fix: 后端修复\n",
            "version/wms-version.md": "10.28.0-20260927120000\n",
        })
        for filename, module in (
            ("wms-warehouse-10.28.0-SNAPSHOT.jar", "wms"),
            ("wms-common-10.28.0-SNAPSHOT.jar", "wms-common"),
            ("wms-warehouse-service-8.27.19.0-SNAPSHOT.jar", "wms"),
            ("wms-standard-workstation-8.27.19.0-SNAPSHOT.jar", "wms-standard"),
            ("ykeey-gaia-8.27.19.0-SNAPSHOT.jar", "wms-common"),
        ):
            self._make_jar(filename, {
                f"version/{module}.md": "2026-09-25\n  feat: 旧模块记录\n",
                f"version/{module}-version.md": "8.27.19.0-20260925120000\n",
            })

        md, logs = build_version_notes(
            str(self.root), "2026-09-27\n  feat: 项目功能\n", "1.0.0-202609271342"
        )

        self.assertIn("- **[project]** 1.0.0-202609271342", md)
        self.assertIn("- **[wms-front]** 10.28.0-20260926131859", md)
        self.assertIn("- **[wms]** 10.28.0-20260927120000", md)
        self.assertIn("- **[project]** feat(project): 项目功能", md)
        self.assertIn("- **[wms-front]** feat: 前端功能", md)
        self.assertEqual(md.count("- **[wms]** fix: 后端修复"), 1)
        self.assertNotIn("旧模块记录", md)
        self.assertNotIn("[wms-standard]", md)
        self.assertNotIn("[wms-common]", md)
        self.assertLess(md.index("### 2026-09-27"), md.index("### 2026-09-26"))
        self.assertFalse(any("[WARN]" in log for log in logs), logs)

    def test_missing_platform_keeps_front_and_reports_new_jar(self):
        self._make_front_jar()
        self._make_jar("wms-warehouse-service-8.27.19.0-SNAPSHOT.jar", {
            "version/wms.md": "2026-09-25\n  feat: 旧后端\n",
            "version/wms-version.md": "8.27.19.0\n",
        })

        entries, versions, logs = collect_product_data(str(self.root))

        self.assertEqual(versions, {"wms-front": "10.28.0-20260926131859"})
        self.assertEqual([e.module for e in entries], ["wms-front"])
        self.assertEqual(
            [log for log in logs if log.startswith("[WARN]")],
            ["[WARN] [wms] lib 中未找到 wms-platform-*.jar"],
        )

    def test_version_is_read_when_history_is_absent(self):
        self._make_front_jar()
        self._make_jar("wms-platform-10.28.0-SNAPSHOT.jar", {
            "version/wms-version.md": "\n  10.28.0-20260927120000  \n",
        })

        entries, versions, logs = collect_product_data(str(self.root))

        self.assertEqual(versions["wms"], "10.28.0-20260927120000")
        self.assertEqual([e.module for e in entries], ["wms-front"])
        self.assertIn(
            "[WARN] [wms] wms-platform-10.28.0-SNAPSHOT.jar 中无 version/wms.md", logs
        )

    def test_history_is_read_when_version_is_absent(self):
        self._make_front_jar()
        self._make_jar("wms-platform-10.28.0-SNAPSHOT.jar", {
            "version/wms.md": "2026-09-27\n  fix: 后端修复\n",
        })

        entries, versions, logs = collect_product_data(str(self.root))

        self.assertNotIn("wms", versions)
        self.assertEqual([e.description for e in entries if e.module == "wms"], ["fix: 后端修复"])
        self.assertIn(
            "[WARN] [wms] wms-platform-10.28.0-SNAPSHOT.jar 中无 version/wms-version.md", logs
        )

    def test_auxiliary_jars_are_excluded(self):
        self._make_front_jar()
        for classifier in ("sources", "javadoc", "tests"):
            self._make_jar(f"wms-platform-10.28.0-SNAPSHOT-{classifier}.jar", {
                "version/wms.md": "2026-09-25\n  feat: 附加包记录\n",
                "version/wms-version.md": "错误版本\n",
            })
        self._make_jar("wms-platform-10.28.0-SNAPSHOT.jar", {
            "version/wms.md": "2026-09-27\n  fix: 后端修复\n",
            "version/wms-version.md": "10.28.0-20260927120000\n",
        })

        entries, versions, logs = collect_product_data(str(self.root))

        self.assertEqual(versions["wms"], "10.28.0-20260927120000")
        self.assertEqual([e.description for e in entries if e.module == "wms"], ["fix: 后端修复"])
        self.assertFalse(any("[WARN]" in log for log in logs), logs)


class ProductJarsConfigTest(unittest.TestCase):
    def test_includes_expected_products(self):
        from core.jar_reader import PRODUCT_JARS

        modules = {e[2] for e in PRODUCT_JARS}
        self.assertEqual(
            modules, {"wms-front", "wms", "fms-front", "fms"}
        )

    def test_wms_platform_mapping_and_derived_version(self):
        from core.jar_reader import PRODUCT_JARS

        entry = [e for e in PRODUCT_JARS if e[2] == "wms"]
        self.assertEqual(len(entry), 1, "WMS 后端只读取一份版本说明")
        glob, md, _module = entry[0]
        self.assertEqual(glob, "wms-platform-*.jar")
        self.assertEqual(md, "version/wms.md")
        # 版本号文件按 -version 后缀派生
        self.assertEqual(md.removesuffix(".md") + "-version.md", "version/wms-version.md")


class WriteVersionNotesTest(unittest.TestCase):
    def test_writes_file_with_expected_name_and_content(self):
        content = "# 版本说明\n\n内容\n"
        with tempfile.TemporaryDirectory() as d:
            path = write_version_notes(d, content)
            self.assertEqual(path.name, VERSION_NOTES_FILENAME)
            self.assertEqual(path.name, "版本说明.md")
            self.assertEqual(path.parent, Path(d))
            self.assertTrue(path.exists())
            self.assertEqual(path.read_text(encoding="utf-8"), content)

    def test_writes_file_with_packaged_name(self):
        content = "# 版本说明\n\n内容\n"
        with tempfile.TemporaryDirectory() as d:
            path = write_version_notes(d, content, "wms-258-1.0.0-202606181716.md")
            self.assertEqual(path.name, "wms-258-1.0.0-202606181716.md")
            self.assertEqual(path.parent, Path(d))
            self.assertTrue(path.exists())
            self.assertEqual(path.read_text(encoding="utf-8"), content)


if __name__ == "__main__":
    unittest.main(verbosity=2)
