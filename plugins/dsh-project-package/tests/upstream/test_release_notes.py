"""用临时真实 Git 仓库验证版本归属；HTTP 全部模拟，不登记生产服务。"""
import subprocess
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest.mock import Mock, patch

import requests

from core.release_notes import (
    DEFAULT_RELEASE_URL, PROJECT_RELEASE_RELPATH, ReleaseCancelled,
    _pom_version, collect_version_changes, generate_project_releases,
)


class GitVersionRangeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-b", "test")
        self.git("config", "user.name", "PackageTool Test")
        self.git("config", "user.email", "package-test@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", str(self.root / "no-hooks"))

    def git(self, *args):
        result = subprocess.run(["git", *args], cwd=self.root, capture_output=True,
                                text=True, encoding="utf-8", check=True)
        return result.stdout.strip()

    def pom(self, version, artifact="wms-258", extra=""):
        (self.root / "pom.xml").write_text(
            f'<project xmlns="http://maven.apache.org/POM/4.0.0">{extra}'
            f'<artifactId>{artifact}</artifactId><version>{version}</version></project>', encoding="utf-8")

    def commit(self, subject):
        self.git("add", ".")
        self.git("commit", "--allow-empty", "-m", subject)

    def test_merge_old_feature_into_new_version_includes_feature_excludes_old_baseline(self):
        self.pom("1.0-SNAPSHOT")
        self.commit("feat: 旧版本已有内容")
        self.git("checkout", "-b", "feature")
        self.commit("feat(scope): feature 在旧版开发")
        self.commit('fix 兼容引号 "、反引号 ` 和 $(内容)')
        self.git("checkout", "test")
        self.pom("2.0-SNAPSHOT")
        self.commit("feat: 提升版本并新增功能")
        self.commit("docs: 不登记说明")
        self.git("merge", "--no-ff", "feature", "-m", "feat: 合并标题不登记")
        self.commit("fix!: 新版本直接修复")
        module, version, changes = collect_version_changes(str(self.root))
        self.assertEqual((module, version), ("wms-258", "2.0-SNAPSHOT"))
        self.assertEqual({c["content"] for c in changes}, {
            "feat(scope): feature 在旧版开发", 'fix 兼容引号 "、反引号 ` 和 $(内容)',
            "feat: 提升版本并新增功能", "fix!: 新版本直接修复",
        })

    def test_root_version_and_repeated_subjects(self):
        self.pom("1.2.3")
        self.commit("feat: 根提交功能")
        self.commit("feat: 根提交功能")
        self.commit("feature: 非规范前缀")
        self.commit("fix(scope)!: 修复")
        self.assertEqual(collect_version_changes(str(self.root))[2], [
            {"type": "feat", "content": "feat: 根提交功能"},
            {"type": "fix", "content": "fix(scope)!: 修复"},
        ])

    def test_same_version_pom_change_does_not_reset_boundary(self):
        self.pom("1.0")
        self.commit("feat: 旧版")
        self.pom("2.0-SNAPSHOT")
        self.commit("feat: 本版首条")
        self.pom("2.0", extra="<name>仅从快照转正式</name>")
        self.commit("fix: 本版末条")
        self.assertEqual([c["content"] for c in collect_version_changes(str(self.root))[2]],
                         ["feat: 本版首条", "fix: 本版末条"])

    def test_switch_to_old_branch_only_reports_old_version(self):
        self.pom("1.0")
        self.commit("feat: 旧版")
        self.git("branch", "old")
        self.pom("2.0")
        self.commit("feat: 新版")
        self.git("checkout", "old")
        _module, version, changes = collect_version_changes(str(self.root))
        self.assertEqual(version, "1.0")
        self.assertEqual(changes, [{"type": "feat", "content": "feat: 旧版"}])

    def test_uncommitted_version_rejected(self):
        self.pom("1.0")
        self.commit("feat: 旧版")
        self.pom("2.0")
        with self.assertRaisesRegex(ValueError, "未找到当前版本起点"):
            collect_version_changes(str(self.root))

    def test_property_version_rejected(self):
        self.pom("${revision}")
        self.commit("feat: 属性版本")
        with self.assertRaisesRegex(ValueError, "属性版本"):
            collect_version_changes(str(self.root))

    def test_unknown_historical_version_rejected(self):
        self.pom("${customVersion}")
        self.commit("chore: 历史属性版本")
        historical_commit = self.git("rev-parse", "HEAD")
        self.pom("2.0")
        self.commit("feat: 不能猜测边界")
        with self.assertRaisesRegex(ValueError, "属性版本") as caught:
            collect_version_changes(str(self.root))
        self.assertIn(historical_commit[:12], str(caught.exception))

    def test_historical_revision_boundary_can_register_and_write_project_release(self):
        """复现 wms-p258 从 WMS-258-1101 属性版本切到 1.0.0 后生成空资源的问题。"""
        self.pom("${revision}", extra="<properties><revision>WMS-258-1101</revision></properties>")
        self.commit("feat: 旧版本专属内容")
        self.pom("1.0.0-SNAPSHOT")
        self.commit("feat: 本版本专属内容")
        (self.root / "wms-project-starter").mkdir()
        response = Mock(status_code=200)
        response.json.return_value = {"code": 200, "data": {
            "moduleName": "wms-258", "releases": [{"version": "1.0.0"}],
            "markdown": "## wms\\-258 1.0.0\n\n### 新增功能\n\n- feat: 本版本专属内容",
        }}
        with patch("core.release_notes.requests.Session") as session:
            post = session.return_value.__enter__.return_value.post
            post.return_value = response
            markdown, target, logs = generate_project_releases(str(self.root))
            post.assert_called_once()
            self.assertEqual(post.call_args.kwargs["json"], {
                "moduleName": "wms-258", "version": "1.0.0-SNAPSHOT", "count": 5,
                "changes": [{"type": "feat", "content": "feat: 本版本专属内容"}],
            })
        self.assertTrue(markdown.startswith("## project 1.0.0\n"))
        self.assertEqual(target.read_text(encoding="utf-8"), markdown + "\n")
        self.assertGreater(target.stat().st_size, 0)
        self.assertFalse(any("[WARN]" in log for log in logs), logs)

    def test_revision_is_absent_even_when_property_matches_current_version(self):
        self.pom("1.0")
        self.commit("feat: 旧版本内容")
        self.pom("${revision}", extra="<properties><revision>2.0-SNAPSHOT</revision></properties>")
        self.commit("feat: 属性写法时的本版功能")
        self.pom("2.0-SNAPSHOT")
        self.commit("fix: 同版本改用明文")
        self.assertEqual([c["content"] for c in collect_version_changes(str(self.root))[2]],
                         ["fix: 同版本改用明文"])

    def test_revision_boundary_does_not_scan_through_to_older_same_literal_version(self):
        """明文 2.0 → ${revision} → 明文 2.0，只登记最后一次明文版本区间。"""
        self.pom("2.0")
        self.commit("feat: 更早的同号版本")
        self.pom("${revision}", extra="<properties><revision>2.0</revision></properties>")
        self.commit("feat: 不再登记的旧版本")
        self.pom("2.0")
        self.commit("fix: 新版明文写法")
        self.assertEqual([c["content"] for c in collect_version_changes(str(self.root))[2]],
                         ["fix: 新版明文写法"])

    def test_uncommitted_literal_version_after_revision_is_rejected(self):
        self.pom("${revision}")
        self.commit("feat: 尚无明文版本")
        self.pom("2.0")
        with self.assertRaisesRegex(ValueError, "未找到当前版本起点"):
            collect_version_changes(str(self.root))

    def test_historical_parent_same_version_is_not_boundary(self):
        (self.root / "pom.xml").write_text(
            "<project><parent><version>2.0-SNAPSHOT</version></parent>"
            "<artifactId>wms-258</artifactId></project>", encoding="utf-8")
        self.commit("feat: 继承版本时已有内容")
        self.pom("2.0-SNAPSHOT")
        self.commit("fix: 改为显式版本")
        self.assertEqual(len(collect_version_changes(str(self.root))[2]), 2)

    def test_shallow_clone_rejected(self):
        self.pom("1.0")
        self.commit("feat: 已有内容")
        with tempfile.TemporaryDirectory() as destination:
            subprocess.run(["git", "clone", "--depth=1", self.root.as_uri(), destination],
                           capture_output=True, check=True)
            with self.assertRaisesRegex(ValueError, "浅克隆"):
                collect_version_changes(destination)

    def test_maven_root_in_git_subdirectory(self):
        project = self.root / "nested"
        project.mkdir()
        (project / "pom.xml").write_text(
            "<project><artifactId>nested</artifactId><version>1.0</version></project>", encoding="utf-8")
        self.commit("feat: 子目录项目")
        self.assertEqual(collect_version_changes(str(project))[0], "nested")


class HistoricalRevisionTest(unittest.TestCase):
    def test_historical_revision_is_absent_regardless_of_properties(self):
        for properties in ("", "<properties><revision>1.2.3</revision></properties>",
                           "<properties><revision>${external}</revision></properties>"):
            with self.subTest(properties=properties):
                pom = ('<project xmlns="http://maven.apache.org/POM/4.0.0">'
                       f'<version> ${{revision}} </version>{properties}</project>')
                self.assertIsNone(_pom_version(pom, historical=True))

    def test_historical_parent_revision_is_also_absent(self):
        pom = ('<project><parent><version>${revision}</version></parent>'
               '<properties><revision>1.2.3-SNAPSHOT</revision></properties></project>')
        self.assertIsNone(_pom_version(pom, historical=True))

    def test_current_pom_still_requires_explicit_literal_version(self):
        pom = ('<project><version>${revision}</version>'
               '<properties><revision>1.2.3</revision></properties></project>')
        with self.assertRaisesRegex(ValueError, "属性版本"):
            _pom_version(pom)

    def test_other_property_expressions_are_not_silently_ignored(self):
        for value in ("${customVersion}", "${revision}${changelist}", ""):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "属性版本"):
                    _pom_version(f"<project><version>{value}</version></project>", historical=True)


class ReleaseServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "app-starter" / PROJECT_RELEASE_RELPATH
        self.target.parent.mkdir(parents=True)
        self.target.write_text("## 旧版本残留", encoding="utf-8")
        patcher = patch("core.release_notes.collect_version_changes")
        self.collect = patcher.start()
        self.addCleanup(patcher.stop)
        self.collect.return_value = ("wms-258", "2.0-SNAPSHOT", [{"type": "feat", "content": "feat: 中文"}])
        patcher = patch("core.release_notes.requests.Session")
        self.session = patcher.start().return_value.__enter__.return_value
        self.addCleanup(patcher.stop)
        self.session.post.return_value = self.response()

    def response(self, markdown="## wms\\-258 2.0\n\n- feat: 中文", releases=None, **data):
        result = Mock(status_code=200)
        result.json.return_value = {"code": 200, "data": {
            "moduleName": "wms-258", "releases": [{}] if releases is None else releases,
            "markdown": markdown, **data,
        }}
        return result

    def test_success_writes_utf8_and_uses_base_version_protocol(self):
        md, target, logs = generate_project_releases(str(self.root))
        self.assertEqual(target, self.target)
        self.assertEqual(target.read_text(encoding="utf-8"), md + "\n")
        self.assertTrue(md.startswith("## project 2.0\n"))
        self.assertEqual(target.name, "project-releases.md")
        args, kwargs = self.session.post.call_args
        self.assertEqual(args, (DEFAULT_RELEASE_URL + "/record",))
        self.assertEqual(kwargs["json"], {"moduleName": "wms-258", "version": "2.0-SNAPSHOT",
                                         "count": 5, "changes": [{"type": "feat", "content": "feat: 中文"}]})
        self.assertEqual(kwargs["timeout"], (3, 30))
        self.assertFalse(kwargs["allow_redirects"])
        self.assertFalse(any("[WARN]" in log for log in logs))

    def test_empty_changes_still_fetch_history(self):
        self.collect.return_value = ("wms-258", "2.0", [])
        self.session.post.return_value = self.response("", [])
        md, _, _ = generate_project_releases(str(self.root))
        self.assertEqual(md, "")
        self.assertEqual(self.session.post.call_args.kwargs["json"]["changes"], [])
        self.assertEqual(self.target.read_text(encoding="utf-8"), "")

    def test_batches_and_writes_only_final_response(self):
        self.collect.return_value = ("wms-258", "2.0", [
            {"type": "feat", "content": f"feat: 条目 {i}"} for i in range(501)])
        def post(*args, **kwargs):
            self.assertEqual(self.target.read_text(encoding="utf-8"), "")
            return self.response("## 最终结果" if len(kwargs["json"]["changes"]) == 1 else "## 半批结果")
        self.session.post.side_effect = post
        md, _, _ = generate_project_releases(str(self.root), "http://example.invalid/release/", 3)
        self.assertEqual(md, "## 最终结果")
        self.assertEqual([len(c.kwargs["json"]["changes"]) for c in self.session.post.call_args_list], [500, 1])
        self.assertTrue(all(c.kwargs["json"]["count"] == 3 for c in self.session.post.call_args_list))

    def test_second_batch_failure_does_not_write_partial_results(self):
        self.collect.return_value = ("wms-258", "2.0", [{"type": "fix", "content": "fix: A"}] * 501)
        self.session.post.side_effect = [self.response(), requests.Timeout("请求超时")]
        md, _, logs = generate_project_releases(str(self.root))
        self.assertEqual(md, "")
        self.assertEqual(self.target.read_text(encoding="utf-8"), "")
        self.assertIn("请求超时", logs[-1])

    def test_bad_http_business_code_module_and_markdown_all_clear_stale_resource(self):
        cases = [Mock(status_code=403), self.response(moduleName="other"),
                 self.response("", [{}]), self.response("错误正文", []),
                 self.response(releases=[{}] * 6), self.response(markdown=12)]
        business = self.response()
        business.json.return_value["code"] = 500
        cases.append(business)
        html = self.response()
        html.json.side_effect = ValueError("不是 JSON")
        cases.append(html)
        for response in cases:
            with self.subTest(response=response):
                self.target.write_text("旧内容", encoding="utf-8")
                self.session.post.return_value = response
                md, _, logs = generate_project_releases(str(self.root))
                self.assertEqual((md, self.target.read_text(encoding="utf-8")), ("", ""))
                self.assertIn("[WARN]", logs[-1])

    def test_cancel_during_request_never_writes_or_starts_next_batch(self):
        cancel = Event()
        self.collect.return_value = ("wms-258", "2.0", [{"type": "fix", "content": "fix: A"}] * 501)
        def post(*args, **kwargs):
            cancel.set()
            return self.response()
        self.session.post.side_effect = post
        with self.assertRaises(ReleaseCancelled):
            generate_project_releases(str(self.root), cancel=cancel)
        self.assertEqual(self.session.post.call_count, 1)
        self.assertEqual(self.target.read_text(encoding="utf-8"), "")

    def test_invalid_count_never_calls_service_and_clears_stale_resource(self):
        for count in (0, 51, True, "5"):
            with self.subTest(count=count):
                md, _, logs = generate_project_releases(str(self.root), count=count)
                self.assertEqual(md, "")
                self.assertIn("版本数量", logs[-1])
        self.session.post.assert_not_called()
        self.assertEqual(self.target.read_text(encoding="utf-8"), "")

    def test_unavailable_boundary_warns_without_network(self):
        self.collect.side_effect = ValueError("未找到当前版本起点")
        md, _, logs = generate_project_releases(str(self.root))
        self.assertEqual(md, "")
        self.assertIn("未找到当前版本起点", logs[-1])
        self.session.post.assert_not_called()

    def test_project_title_mapping_preserves_versions_and_body(self):
        """服务转义后的多版本标题映射为 project，正文中相同身份不得被替换。"""
        self.collect.return_value = ("wms_demo.base-258", "2.0", [])
        markdown = (
            "## wms\\_demo\\.base\\-258 2.0\n\n### 新增功能\n\n"
            "- feat: wms\\_demo\\.base\\-258 与 project 的集成\n\n"
            "## wms\\_demo\\.base\\-258 1.0\\-rc\n\n### 问题修复\n\n"
            "- fix: 保留正文中的 ## wms\\_demo\\.base\\-258 1.0\n"
        )
        self.session.post.return_value = self.response(markdown, [{}, {}], moduleName="wms_demo.base-258")
        md, _, _ = generate_project_releases(str(self.root))
        self.assertIn("## project 2.0\n", md)
        self.assertIn("## project 1.0\\-rc\n", md)
        self.assertIn("- feat: wms\\_demo\\.base\\-258 与 project 的集成", md)
        self.assertIn("- fix: 保留正文中的 ## wms\\_demo\\.base\\-258 1.0", md)


class ProjectIdentityIntegrationTest(unittest.TestCase):
    def test_same_version_projects_use_root_artifact_identity_but_project_resources(self):
        """复现两个项目共用 starter 名和版本号，验证 POM→请求→资源→展示整条映射。"""
        from core.git_log import generate_version_md
        from core.version_notes import build_version_notes

        cases = [("wms-project", "wms-project-base", "wms\\-project\\-base"),
                 ("wms-p258", "wms-258", "wms\\-258")]
        with tempfile.TemporaryDirectory() as directory:
            request_modules = []
            for folder, artifact, escaped in cases:
                with self.subTest(project=artifact):
                    root = Path(directory) / folder
                    starter = root / "wms-project-starter"
                    starter.mkdir(parents=True)
                    (root / "pom.xml").write_text(
                        '<project xmlns="http://maven.apache.org/POM/4.0.0">'
                        '<parent><artifactId>wms-parent</artifactId><version>10.29.0-SNAPSHOT</version></parent>'
                        f'<artifactId>{artifact}</artifactId><version>1.0.0-SNAPSHOT</version></project>',
                        encoding="utf-8")
                    for args in (("init", "-b", "test"), ("add", "."), ("commit", "-m", f"feat: {folder} 专属功能")):
                        subprocess.run([
                            "git", "-c", "user.name=Package Test", "-c", "user.email=package@example.invalid",
                            "-c", "commit.gpgsign=false", "-c", f"core.hooksPath={root / 'no-hooks'}", *args,
                        ], cwd=root, capture_output=True, check=True)
                    content, legacy_path, version_path, version = generate_version_md(str(root))
                    response = Mock(status_code=200)
                    response.json.return_value = {"code": 200, "data": {
                        "moduleName": artifact, "releases": [{"version": "1.0.0"}],
                        "markdown": f"## {escaped} 1.0.0\n\n### 新增功能\n\n- feat: {folder} 专属功能",
                    }}
                    with patch("core.release_notes.requests.Session") as session:
                        post = session.return_value.__enter__.return_value.post
                        post.return_value = response
                        markdown, release_path, logs = generate_project_releases(str(root))
                        request = post.call_args.kwargs["json"]
                    self.assertEqual(request["moduleName"], artifact)
                    self.assertEqual(request["version"], "1.0.0-SNAPSHOT")
                    self.assertEqual(request["changes"], [{"type": "feat", "content": f"feat: {folder} 专属功能"}])
                    request_modules.append(request["moduleName"])
                    self.assertEqual([path.name for path in (legacy_path, version_path, release_path)],
                                     ["project.md", "project-version.md", "project-releases.md"])
                    self.assertEqual(release_path.parent, starter / "src/main/resources/version")
                    self.assertTrue(markdown.startswith("## project 1.0.0\n"))
                    self.assertEqual(release_path.read_text(encoding="utf-8"), markdown + "\n")
                    combined, _ = build_version_notes(str(root), content, version, markdown)
                    self.assertIn("- **[project]** 1.0.0-", combined)
                    self.assertIn("## project 1.0.0", combined)
                    self.assertNotIn("## 更新记录", combined)
                    self.assertFalse(any("[WARN]" in log for log in logs), logs)
            self.assertEqual(request_modules, ["wms-project-base", "wms-258"])


if __name__ == "__main__":
    unittest.main()
