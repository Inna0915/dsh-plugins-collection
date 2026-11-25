"""Verify Gaia (gaia-front / gaia-module) product version and release-notes extraction."""
import tempfile
import unittest
import zipfile
from pathlib import Path

from core.jar_reader import PRODUCT_JARS, collect_product_notes
from core.version_notes import build_version_notes


class GaiaProductNotesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lib = self.root / "fms-project-starter/target/app/WEB-INF/lib"
        self.lib.mkdir(parents=True)
        self.fms_front_release = "## fms\\-front 8.27.3\n\n### 新增功能\n\n- feat: FMS前端内容"
        self.fms_release = "## fms 8.27.3\n\n### 问题修复\n\n- fix(warehouse): FMS后端内容"
        self.gaia_front_release = "## gaia\\-front 8.48.3\n\n### 新增功能\n\n- feat(cycletask): Gaia前端内容"
        self.gaia_release = "## gaia 8.56.0\n\n### 问题修复\n\n- fix: Gaia后端内容"
        self.project_release = "## project 1.0.0\n\n- fix(project): 项目发布内容"

    def make_jar(self, filename, resources):
        with zipfile.ZipFile(self.lib / filename, "w") as jar:
            for entry, content in resources.items():
                jar.writestr(entry, content)

    def seed_gaia(self, front_release=None, backend_release=None):
        for carrier, module, ver, releases in (
            ("gaia-front", "gaia-front", "8.56.0-20261125005111", front_release),
            ("gaia-module", "gaia", "8.56.0-20261125005109", backend_release),
        ):
            resources = {
                f"version/{module}-version.md": f"{ver}\n",
                f"version/{module}.md": f"2026-11-25\n  fix: {module}旧日期内容\n",
            }
            if releases is not None:
                resources[f"version/{module}-releases.md"] = releases
            self.make_jar(f"{carrier}-8.56.0-SNAPSHOT.jar", resources)

    def seed_fms(self):
        for carrier, module, ver, releases in (
            ("fms-front", "fms-front", "8.27.3-20261125031806", self.fms_front_release),
            ("fms-warehouse", "fms", "8.27.3-20261125025932", self.fms_release),
        ):
            self.make_jar(f"{carrier}-8.27.3-SNAPSHOT.jar", {
                f"version/{module}-version.md": f"{ver}\n",
                f"version/{module}-releases.md": releases,
            })

    def test_gaia_mapping_uses_front_and_module_and_derives_resource_names(self):
        expected = {
            "gaia-front": ("gaia-front-*.jar", "version/gaia-front.md", "gaia-front"),
            "gaia": ("gaia-module-*.jar", "version/gaia.md", "gaia"),
        }
        for module, mapping in expected.items():
            matches = [entry for entry in PRODUCT_JARS if entry[2] == module]
            self.assertEqual(matches, [mapping])
            self.assertEqual(
                mapping[1].removesuffix(".md") + "-releases.md",
                f"version/{module}-releases.md",
            )
            self.assertEqual(
                mapping[1].removesuffix(".md") + "-version.md",
                f"version/{module}-version.md",
            )

    def test_fms_and_gaia_versions_and_releases_are_extracted_in_order(self):
        self.seed_fms()
        self.seed_gaia(self.gaia_front_release, self.gaia_release)
        md, logs = build_version_notes(
            str(self.root),
            "2026-11-25\n  feat: 项目旧日期内容\n",
            "1.0.0-202611251155",
            self.project_release,
        )
        self.assertIn("- **[project]** 1.0.0-202611251155", md)
        self.assertIn("- **[fms-front]** 8.27.3-20261125031806", md)
        self.assertIn("- **[fms]** 8.27.3-20261125025932", md)
        self.assertIn("- **[gaia-front]** 8.56.0-20261125005111", md)
        self.assertIn("- **[gaia]** 8.56.0-20261125005109", md)
        order = [
            md.index(self.project_release),
            md.index(self.fms_front_release),
            md.index(self.fms_release),
            md.index(self.gaia_front_release),
            md.index(self.gaia_release),
        ]
        self.assertEqual(order, sorted(order))
        self.assertNotIn("旧日期内容", md)
        self.assertFalse(any("[WARN]" in log for log in logs), logs)

    def test_noncarrier_gaia_jars_do_not_replace_module_carrier(self):
        self.seed_gaia(self.gaia_front_release, self.gaia_release)
        for name in ("gaia-boot", "gaia-service", "gaia-service-api", "gaia-service-redis"):
            self.make_jar(f"{name}-8.56.0-SNAPSHOT.jar", {
                "version/gaia-releases.md": "## gaia 99.0.0\n\n- fix: 错误载体内容",
                "version/gaia-version.md": "错误载体版本",
            })
        md, _ = build_version_notes(str(self.root), "", "1.0.0-202611251155", self.project_release)
        self.assertEqual(md.count(self.gaia_release), 1)
        self.assertNotIn("错误载体", md)

    def test_classifier_gaia_jars_are_excluded(self):
        for carrier, module in (("gaia-front", "gaia-front"), ("gaia-module", "gaia")):
            for classifier in ("sources", "javadoc", "tests"):
                self.make_jar(f"{carrier}-8.56.0-{classifier}.jar", {
                    f"version/{module}-releases.md": "附加包内容",
                    f"version/{module}-version.md": "附加包版本",
                })
        self.seed_gaia(self.gaia_front_release, self.gaia_release)
        notes = collect_product_notes(str(self.root))
        self.assertEqual(notes.versions["gaia-front"], "8.56.0-20261125005111")
        self.assertEqual(notes.versions["gaia"], "8.56.0-20261125005109")
        self.assertNotIn("附加包", "\n".join(notes.releases.values()))

    def test_missing_gaia_front_does_not_block_gaia_module(self):
        self.seed_gaia(self.gaia_front_release, self.gaia_release)
        (self.lib / "gaia-front-8.56.0-SNAPSHOT.jar").unlink()
        notes = collect_product_notes(str(self.root))
        self.assertEqual(notes.versions, {"gaia": "8.56.0-20261125005109"})
        self.assertIn("gaia", notes.releases)
        self.assertEqual(
            [log for log in notes.logs if "[WARN]" in log],
            ["[WARN] [gaia-front] lib 中未找到 gaia-front-*.jar"],
        )

    def test_all_absent_releases_fall_back_to_combined_dates(self):
        self.seed_gaia(" \n", "\t")
        md, logs = build_version_notes(
            str(self.root), "2026-11-25\n  feat: 项目旧日期内容\n", "1.0.0-202611251155"
        )
        for label in ("项目", "gaia-front", "gaia"):
            self.assertIn(f"{label}旧日期内容", md)
        self.assertEqual(md.count("### 2026-11-25"), 1)
        self.assertFalse(any("[WARN]" in log for log in logs), logs)


if __name__ == "__main__":
    unittest.main()
