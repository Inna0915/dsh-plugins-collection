import hashlib
import io
import tempfile
import unittest
import zipfile
from pathlib import Path
from threading import Event
from unittest.mock import patch

from core.dependency_inventory import Dependency, parse_dependency_tree, read_war
from core.dependency_monitor import (GAIA_RULES, RULES_REVISION, DependencyMonitor, comparison,
                                     default_options, load_options, mapped_job, parse_rules)
from core.markdown_preview import parse_markdown, preview_text
from core.maven_repository import AuthenticationError, Repository, RepositoryError, read_repositories, remote_artifact
from core.notes_display import default_scope, scoped_release


class GaiaConfigurationTest(unittest.TestCase):
    def load_saved(self, saved):
        with patch("core.dependency_monitor.load_json", return_value=saved):
            return load_options()

    def test_fresh_defaults_cover_only_published_gaia_jars(self):
        rules = parse_rules(self.load_saved({})["rules"])
        for artifact in ("gaia-boot", "gaia-module", "gaia-service", "gaia-service-api",
                         "gaia-service-matrix", "gaia-service-opc", "gaia-service-zebra",
                         "gaia-service-redis", "gaia-service-distributed", "gaia-service-monitor",
                         "gaia-service-alarm", "gaia-service-mongodb"):
            with self.subTest(artifact=artifact):
                self.assertEqual(mapped_job(Dependency("com.ykeey.gaia", artifact, "8.56.0-SNAPSHOT"), rules), "gaia")
        self.assertEqual(mapped_job(Dependency("com.ykeey.gaia", "gaia-front", "8.56.0-SNAPSHOT"), rules), "gaia-front")
        for group, artifact in (("com.foeris.y", "y.resource.plugin.gaia2"),
                                ("com.ykeey.gaia", "gaia-parent"),
                                ("com.ykeey.gaia", "gaia-demo"),
                                ("com.ykeey.gaia", "gaia-unconfirmed")):
            self.assertEqual(mapped_job(Dependency(group, artifact, "1"), rules), "")
        self.assertEqual(len(rules), len(set(rules)))

    def test_legacy_config_adds_only_gaia_preserving_custom_settings(self):
        saved = {"rules": ["com.cyzn.fms:fms-front:*=custom-fms"],
                 "jenkins_url": "https://ci.invalid", "jenkins_secret": "protected"}
        options = self.load_saved(saved)
        self.assertEqual(options["rules"], saved["rules"] + GAIA_RULES)
        self.assertEqual(options["jenkins_url"], saved["jenkins_url"])
        self.assertEqual(options["jenkins_secret"], "protected")
        self.assertEqual(options["rules_revision"], RULES_REVISION)
        self.assertEqual(saved["rules"], ["com.cyzn.fms:fms-front:*=custom-fms"])
        self.assertEqual(self.load_saved(options), options)

    def test_custom_gaia_version_mapping_is_not_overlapped(self):
        custom = "com.ykeey.gaia:gaia-service:8.*=folder/custom-gaia"
        options = self.load_saved({"rules": [custom, GAIA_RULES[-1]]})
        rules = parse_rules(options["rules"])
        self.assertEqual(mapped_job(Dependency("com.ykeey.gaia", "gaia-service", "8.56.0-SNAPSHOT"), rules), "folder/custom-gaia")
        self.assertEqual(mapped_job(Dependency("com.ykeey.gaia", "gaia-service", "9.0"), rules), "")
        self.assertEqual(options["rules"].count(GAIA_RULES[-1]), 1)

    def test_deleted_rules_stay_deleted_after_saving_revision(self):
        options = self.load_saved({"rules": [], "rules_revision": RULES_REVISION})
        self.assertEqual(options["rules"], [])

    def test_invalid_legacy_text_is_not_silently_removed(self):
        options = self.load_saved({"rules": ["invalid", "# custom comment"]})
        self.assertEqual(options["rules"][:2], ["invalid", "# custom comment"])
        with self.assertRaises(ValueError):
            parse_rules(options["rules"])


class DisplayFixTest(unittest.TestCase):
    def test_escaped_punctuation_is_text_not_style(self):
        raw = r"\# title\n" + "\n" + r"- feat\(fms\-platform\): fake\_wms \*\*literal\*\*"
        text = preview_text(raw)
        self.assertIn("feat(fms-platform): fake_wms **literal**", text)
        self.assertFalse(any("bold" in s.styles or "h1" in s.styles for s in parse_markdown(raw)))
        self.assertEqual(preview_text(r"C:\work\test `a\_b`"), r"C:\work\test `a\_b`")

    def test_only_missing_scopes_are_added(self):
        for message, expected in [("feat: A", "feat(project): A"), ("fix!: B", "fix(project)!: B"),
                                  ("feat old", "feat(project) old"), ("fix(api): A", "fix(api): A"),
                                  (r"fix\(api\): A", r"fix\(api\): A")]:
            actual = default_scope(message, "project")
            self.assertEqual(actual, expected)
            self.assertEqual(default_scope(actual, "project"), actual)
        md = "## warehouse 1.0\n- fix: A\n```\n- fix: code\n```"
        self.assertIn("- fix(warehouse): A", scoped_release(md, "warehouse"))
        self.assertIn("- fix: code", scoped_release(md, "warehouse"))


class InventoryTest(unittest.TestCase):
    def test_transitive_tree_and_classifier(self):
        text = "[INFO] 1 g:project:war:1\n[INFO] 2 g:a:jar:2:compile\n[INFO] 3 g:b:jar:linux:3:runtime\n[INFO] 4 g:c:jar:1:test\n#\n1 2\n"
        deps = parse_dependency_tree(text, {("g", "project")})
        self.assertEqual([d.key for d in deps], ["g:a:2:jar:", "g:b:3:jar:linux"])

    def test_war_hashes_actual_nested_jar(self):
        dep = Dependency("g", "backend", "1-SNAPSHOT")
        jar_bytes = io.BytesIO()
        with zipfile.ZipFile(jar_bytes, "w") as jar:
            jar.writestr("META-INF/maven/g/backend/pom.properties", "groupId=g\nartifactId=backend\nversion=1-SNAPSHOT\n")
            jar.writestr("version/backend.md", "test")
        content = jar_bytes.getvalue()
        with tempfile.TemporaryDirectory() as directory:
            war = Path(directory) / "app.war"
            with zipfile.ZipFile(war, "w") as z:
                z.writestr("WEB-INF/lib/backend-1-SNAPSHOT.jar", content)
            result = read_war(war, [dep], Event())
        self.assertEqual(result[dep.key]["sha1"], hashlib.sha1(content).hexdigest())


class FakeResponse:
    def __init__(self, status=200, text=""):
        self.status_code, self.text = status, text
        self.closed = False
    def iter_content(self, size):
        yield self.text.encode()
    def close(self):
        self.closed = True


class FakeSession:
    def __init__(self, metadata, checksum="a" * 40, code=200):
        self.metadata, self.checksum, self.code = metadata, checksum, code
        self.calls = []
    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.code != 200:
            return FakeResponse(self.code)
        if url.endswith("maven-metadata.xml"):
            return FakeResponse(text=self.metadata)
        if url.endswith(".sha256"):
            return FakeResponse(404)
        if url.endswith(".sha1"):
            return FakeResponse(text=self.checksum)
        return FakeResponse()


METADATA = """<metadata><groupId>g</groupId><artifactId>a</artifactId><version>1-SNAPSHOT</version>
<versioning><snapshotVersions><snapshotVersion><extension>jar</extension><value>1-20261022.010000-2</value><updated>20261022010000</updated></snapshotVersion>
<snapshotVersion><extension>jar</extension><classifier>sources</classifier><value>1-20261022.020000-3</value><updated>20261022020000</updated></snapshotVersion>
</snapshotVersions></versioning></metadata>"""


class RepositoryTest(unittest.TestCase):
    def test_snapshot_selects_main_jar_and_checksum_fallback(self):
        session = FakeSession(METADATA)
        result = remote_artifact(Dependency("g", "a", "1-SNAPSHOT"), Repository("r", "http://repo.invalid"), Event(), session)
        self.assertEqual(result["identity"], "1-20261022.010000-2")
        self.assertEqual(result["algorithm"], "sha1")
        self.assertTrue(any(call[0] == "HEAD" for call in session.calls))
        self.assertTrue(all(call[2]["allow_redirects"] is False for call in session.calls))

    def test_coordinates_authentication_and_invalid_hash_fail_closed(self):
        dep, repo = Dependency("g", "a", "1-SNAPSHOT"), Repository("r", "http://repo.invalid")
        with self.assertRaises(AuthenticationError):
            remote_artifact(dep, repo, Event(), FakeSession(METADATA, code=401))
        with self.assertRaises(RepositoryError):
            remote_artifact(dep, repo, Event(), FakeSession(METADATA.replace("<groupId>g", "<groupId>other")))
        with self.assertRaises(RepositoryError):
            remote_artifact(dep, repo, Event(), FakeSession(METADATA, checksum="login page"))

    def test_user_settings_override_matching_server(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            global_path, user_path = root / "global.xml", root / "user.xml"
            global_path.write_text('<settings><mirrors><mirror><id>r</id><url>http://repo.invalid</url><mirrorOf>*</mirrorOf></mirror></mirrors><servers><server><id>r</id><username>old</username><password>old</password></server></servers></settings>')
            user_path.write_text('<settings><servers><server><id>r</id><username>new</username><password>new</password></server></servers></settings>')
            with patch("core.maven_repository.settings_paths", return_value=[global_path, user_path]):
                repo = read_repositories(str(root))[0]
            self.assertEqual(repo.auth, ("new", "new"))
            self.assertNotIn("new", repr(repo))


class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.dep = Dependency("com.cyzn.fms", "fms-warehouse", "8.27.2-SNAPSHOT")
        self.remote = {"identity": "8.27.2-20261021.010000-1", "repository": "repo|http://repo.invalid",
                       "algorithm": "sha1", "checksum": "old", "updated": "20261021010000"}
        self.context_patch = patch("core.dependency_monitor.context_id", return_value="test-context")
        self.context_patch.start()
        self.addCleanup(self.context_patch.stop)
        self.service = DependencyMonitor(str(self.root), default_options(), self.root / "data")
        self.service.dependencies = [self.dep]
        for name, value in (("read_job", {"success": 1, "status": "成功", "number": 1}),
                            ("remote_artifact", self.remote)):
            patcher = patch("core.dependency_monitor." + name, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch.object(self.service, "_repository", return_value=Repository("repo", "http://repo.invalid"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_new_remote_is_detected_then_real_war_clears_difference(self):
        self.service.state["packaged"] = {self.dep.key: {"sha1": "old", "sha256": "old256"}}
        first = self.service.poll(Event(), force=True)
        self.assertEqual(first["rows"][0]["state"], "已包含远端制品")
        self.remote.update(identity="8.27.2-20261022.010000-2", checksum="new")
        second = self.service.poll(Event(), force=True)
        self.assertIn("有新 SNAPSHOT", second["rows"][0]["state"])
        self.assertEqual(len(second["notifications"]), 1)
        third = self.service.poll(Event(), force=True)
        self.assertFalse(third["notifications"])
        self.service.acknowledge(second["events"])
        with patch("core.dependency_monitor.read_war", return_value={self.dep.key: {"sha1": "old", "sha256": "old256"}}):
            unchanged = self.service.poll(Event(), war="app.war", force=True)
        self.assertTrue(unchanged["rows"][0]["different"])
        self.assertFalse(unchanged["events"])
        with patch("core.dependency_monitor.read_war", return_value={self.dep.key: {"sha1": "new", "sha256": "new256"}}):
            updated = self.service.poll(Event(), war="app.war", force=True)
        self.assertEqual(updated["rows"][0]["state"], "已包含远端制品")

    def test_local_install_is_not_claimed_to_be_older(self):
        state, different = comparison({"sha1": "custom"}, self.remote)
        self.assertTrue(different)
        self.assertIn("可能为本地构建包", state)

    def test_gaia_groups_jobs_and_verifies_actual_war_after_update(self):
        deps = [Dependency("com.ykeey.gaia", artifact, "8.56.0-SNAPSHOT")
                for artifact in ("gaia-service", "gaia-service-redis", "gaia-front")]
        self.service.dependencies = deps
        self.service.state["packaged"] = {dep.key: {"sha1": "old", "sha256": "old256"} for dep in deps}
        self.remote["identity"] = "8.56.0-20261021.010000-1"
        with patch("core.dependency_monitor.read_job", return_value={"success": 1, "status": "成功", "number": 1}) as job:
            first = self.service.poll(Event(), force=True)
        self.assertEqual(sorted(call.args[1] for call in job.call_args_list), ["gaia", "gaia-front"])
        self.assertEqual({row["state"] for row in first["rows"]}, {"已包含远端制品"})
        self.remote.update(identity="8.56.0-20261022.010000-2", checksum="new")
        changed = self.service.poll(Event(), force=True)
        self.assertEqual(len(changed["notifications"]), 3)
        self.assertTrue(all(row["different"] for row in changed["rows"]))
        contents = {dep.key: {"sha1": "new", "sha256": "new256"} for dep in deps}
        with patch("core.dependency_monitor.read_war", return_value=contents):
            updated = self.service.poll(Event(), war="app.war", force=True)
        self.assertEqual({row["state"] for row in updated["rows"]}, {"已包含远端制品"})
        self.assertFalse(updated["events"])

    def test_auth_failure_never_reports_cached_result_as_current(self):
        self.service.state["packaged"] = {self.dep.key: {"sha1": "old"}}
        self.service.poll(Event(), force=True)
        with patch("core.dependency_monitor.remote_artifact", side_effect=AuthenticationError("auth")):
            result = self.service.poll(Event(), force=True)
        self.assertIn("无法核验", result["rows"][0]["state"])
        self.assertTrue(self.service.auth_blocked)

    def test_ambiguous_rule_does_not_guess(self):
        rules = parse_rules(["g:a:*=first", "g:a:1*=second"])
        self.assertEqual(mapped_job(Dependency("g", "a", "1-SNAPSHOT"), rules), "")
        self.assertEqual(mapped_job(Dependency("g", "a", "2-SNAPSHOT"), rules), "first")


if __name__ == "__main__":
    unittest.main()
