import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import call, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.git_repo import (  # noqa: E402
    GitBranchesResult,
    GitCommandResult,
    GitDirtyWorktreeError,
    GitNoUpstreamError,
    GitRemoteBranchError,
    GitRepository,
    NotGitRepositoryError,
    inspect_repository,
    list_remote_branches,
    pull_repository,
    refresh_remote_branches,
    reset_repository_to_upstream,
    switch_to_remote_branch,
)


def _git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=15,
        check=True,
    )
    return result.stdout.strip()


class GitRepoIntegrationTest(unittest.TestCase):
    def _setup_remote(self, root: Path) -> tuple[Path, Path, Path]:
        remote = root / "remote.git"
        seed = root / "seed"
        target = root / "target"
        subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True, timeout=15)
        subprocess.run(["git", "init", str(seed)], check=True, capture_output=True, timeout=15)
        _git(seed, "config", "user.name", "Package Tool Test")
        _git(seed, "config", "user.email", "package-tool@example.invalid")
        (seed / "tracked.txt").write_text("v1\n", encoding="utf-8")
        _git(seed, "add", "tracked.txt")
        _git(seed, "commit", "-m", "initial")
        _git(seed, "branch", "-M", "main")
        _git(seed, "remote", "add", "origin", str(remote))
        _git(seed, "push", "-u", "origin", "main")
        subprocess.run(
            ["git", "--git-dir", str(remote), "symbolic-ref", "HEAD", "refs/heads/main"],
            check=True,
            capture_output=True,
            timeout=15,
        )
        subprocess.run(["git", "clone", str(remote), str(target)], check=True, capture_output=True, timeout=15)
        return remote, seed, target

    def _push_v2(self, seed: Path) -> None:
        (seed / "tracked.txt").write_text("v2\n", encoding="utf-8")
        _git(seed, "add", "tracked.txt")
        _git(seed, "commit", "-m", "remote update")
        _git(seed, "push")

    def _push_branch(self, seed: Path, branch: str, content: str) -> None:
        _git(seed, "switch", "-c", branch)
        (seed / "tracked.txt").write_text(content + "\n", encoding="utf-8")
        _git(seed, "add", "tracked.txt")
        _git(seed, "commit", "-m", f"add {branch}")
        _git(seed, "push", "-u", "origin", branch)
        _git(seed, "switch", "main")

    def test_inspects_repository_and_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            _remote, _seed, target = self._setup_remote(Path(temp))
            (target / "untracked.txt").write_text("keep\n", encoding="utf-8")
            info = inspect_repository(target)
            self.assertEqual(info.branch, "main")
            self.assertEqual(info.upstream, "origin/main")
            self.assertEqual(info.changed_count, 1)

    def test_pull_fast_forwards(self):
        with tempfile.TemporaryDirectory() as temp:
            _remote, seed, target = self._setup_remote(Path(temp))
            self._push_v2(seed)
            result = pull_repository(target)
            self.assertTrue(result.success, result.output)
            self.assertEqual((target / "tracked.txt").read_text(encoding="utf-8"), "v2\n")
            self.assertIn("git pull --ff-only", result.output)

    def test_reset_matches_upstream_and_keeps_untracked(self):
        with tempfile.TemporaryDirectory() as temp:
            _remote, seed, target = self._setup_remote(Path(temp))
            self._push_v2(seed)
            (target / "tracked.txt").write_text("local edit\n", encoding="utf-8")
            (target / "untracked.txt").write_text("keep\n", encoding="utf-8")
            result = reset_repository_to_upstream(target)
            self.assertTrue(result.success, result.output)
            self.assertEqual((target / "tracked.txt").read_text(encoding="utf-8"), "v2\n")
            self.assertTrue((target / "untracked.txt").exists())
            self.assertIn("git fetch", result.output)
            self.assertIn("git reset --hard origin/main", result.output)

    def test_reset_removes_untracked_generated_files_and_allows_switch(self):
        with tempfile.TemporaryDirectory() as temp:
            _remote, seed, target = self._setup_remote(Path(temp))
            self._push_branch(seed, "develop", "develop")
            version_dir = target / "starter with spaces" / "src/main/resources/version"
            version_dir.mkdir(parents=True)
            generated_files = [
                version_dir / "project.md",
                version_dir / "project-version.md",
                version_dir / "project-releases.md",
            ]
            for generated_file in generated_files:
                generated_file.write_text("generated\n", encoding="utf-8")

            result = reset_repository_to_upstream(target)

            self.assertTrue(result.success, result.output)
            self.assertTrue(all(not path.exists() for path in generated_files))
            self.assertFalse(inspect_repository(target).dirty)
            self.assertIn("project.md", result.output)
            switched = switch_to_remote_branch(target, "origin/develop")
            self.assertTrue(switched.success, switched.output)

    def test_reset_keeps_other_untracked_files_in_generated_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            _remote, _seed, target = self._setup_remote(Path(temp))
            version_dir = target / "wms-starter" / "src/main/resources/version"
            version_dir.mkdir(parents=True)
            generated = version_dir / "project.md"
            generated.write_text("generated\n", encoding="utf-8")
            same_directory = version_dir / "manual-notes.md"
            same_directory.write_text("keep\n", encoding="utf-8")
            unrelated = target / "untracked.txt"
            unrelated.write_text("keep\n", encoding="utf-8")
            wrong_location = target / "project.md"
            wrong_location.write_text("keep\n", encoding="utf-8")
            info_exclude = target / ".git/info/exclude"
            with info_exclude.open("a", encoding="utf-8") as stream:
                stream.write("\nignored-starter/\n")
            ignored = target / "ignored-starter/src/main/resources/version/project.md"
            ignored.parent.mkdir(parents=True)
            ignored.write_text("keep ignored\n", encoding="utf-8")

            result = reset_repository_to_upstream(target)

            self.assertTrue(result.success, result.output)
            self.assertFalse(generated.exists())
            self.assertTrue(same_directory.exists())
            self.assertTrue(unrelated.exists())
            self.assertTrue(wrong_location.exists())
            self.assertTrue(ignored.exists())
            self.assertEqual(inspect_repository(target).changed_count, 3)

    def test_reset_restores_tracked_generated_files_instead_of_deleting_them(self):
        with tempfile.TemporaryDirectory() as temp:
            _remote, seed, target = self._setup_remote(Path(temp))
            relative_dir = Path("wms-starter/src/main/resources/version")
            seed_version_dir = seed / relative_dir
            seed_version_dir.mkdir(parents=True)
            expected = {
                "project.md": "remote notes\n",
                "project-version.md": "1.2.3\n",
                "project-releases.md": "## project 1.2.3\n",
            }
            for name, content in expected.items():
                (seed_version_dir / name).write_text(content, encoding="utf-8")
            _git(seed, "add", relative_dir.as_posix())
            _git(seed, "commit", "-m", "track generated version files")
            _git(seed, "push")
            pull_repository(target)
            target_version_dir = target / relative_dir
            for name in expected:
                (target_version_dir / name).write_text("local edit\n", encoding="utf-8")

            result = reset_repository_to_upstream(target)

            self.assertTrue(result.success, result.output)
            for name, content in expected.items():
                restored = target_version_dir / name
                self.assertTrue(restored.exists())
                self.assertEqual(restored.read_text(encoding="utf-8"), content)
            self.assertFalse(inspect_repository(target).dirty)

    def test_non_repo_and_missing_upstream(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            # Fixtures may live below the tool's repository; do not discover that parent.
            with patch.dict("os.environ", {"GIT_CEILING_DIRECTORIES": str(root.parent)}), self.assertRaises(NotGitRepositoryError):
                inspect_repository(root)
            subprocess.run(["git", "init", str(root)], check=True, capture_output=True, timeout=15)
            _git(root, "config", "user.name", "Package Tool Test")
            _git(root, "config", "user.email", "package-tool@example.invalid")
            (root / "a.txt").write_text("a\n", encoding="utf-8")
            _git(root, "add", "a.txt")
            _git(root, "commit", "-m", "initial")
            with self.assertRaises(GitNoUpstreamError):
                pull_repository(root)

    def test_refresh_lists_remote_only_and_switches_new_and_existing_branches(self):
        with tempfile.TemporaryDirectory() as temp:
            _remote, seed, target = self._setup_remote(Path(temp))
            self._push_branch(seed, "release/z", "release")
            self._push_branch(seed, "develop", "develop")

            refreshed = refresh_remote_branches(target)

            self.assertTrue(refreshed.success, refreshed.output)
            self.assertEqual(
                list(refreshed.branches),
                ["origin/develop", "origin/main", "origin/release/z"],
            )
            self.assertNotIn("origin/HEAD", list_remote_branches(target))

            created = switch_to_remote_branch(target, "origin/release/z")
            self.assertTrue(created.success, created.output)
            self.assertIn("git switch --track -c release/z origin/release/z", created.output)
            self.assertEqual(_git(target, "branch", "--show-current"), "release/z")
            self.assertEqual(
                _git(target, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
                "origin/release/z",
            )
            self.assertEqual((target / "tracked.txt").read_text(encoding="utf-8"), "release\n")

            existing = switch_to_remote_branch(target, "origin/main")
            self.assertTrue(existing.success, existing.output)
            self.assertIn("git switch main", existing.output)
            self.assertEqual(_git(target, "branch", "--show-current"), "main")

            no_op = switch_to_remote_branch(target, "origin/main")
            self.assertTrue(no_op.success, no_op.output)
            self.assertIn("无需切换", no_op.output)

    def test_switch_blocks_unstaged_staged_and_untracked_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            _remote, seed, target = self._setup_remote(Path(temp))
            self._push_branch(seed, "develop", "develop")
            refresh_remote_branches(target)

            (target / "tracked.txt").write_text("unstaged\n", encoding="utf-8")
            with self.assertRaises(GitDirtyWorktreeError):
                switch_to_remote_branch(target, "origin/develop")

            _git(target, "add", "tracked.txt")
            with self.assertRaises(GitDirtyWorktreeError):
                switch_to_remote_branch(target, "origin/develop")

            _git(target, "reset", "--hard", "HEAD")
            untracked = target / "untracked.txt"
            untracked.write_text("local\n", encoding="utf-8")
            with self.assertRaises(GitDirtyWorktreeError):
                switch_to_remote_branch(target, "origin/develop")
            self.assertEqual(_git(target, "branch", "--show-current"), "main")

    def test_switch_rejects_local_branch_without_matching_upstream(self):
        with tempfile.TemporaryDirectory() as temp:
            _remote, seed, target = self._setup_remote(Path(temp))
            self._push_branch(seed, "develop", "develop")
            self._push_branch(seed, "other", "other")
            refresh_remote_branches(target)
            _git(target, "branch", "develop")

            with self.assertRaises(GitRemoteBranchError) as missing:
                switch_to_remote_branch(target, "origin/develop")
            self.assertIn("未设置", str(missing.exception))

            _git(target, "branch", "--set-upstream-to=origin/other", "develop")
            with self.assertRaises(GitRemoteBranchError) as mismatch:
                switch_to_remote_branch(target, "origin/develop")
            self.assertIn("origin/other", str(mismatch.exception))


class GitOperationFailureTest(unittest.TestCase):
    def setUp(self):
        self.repository = GitRepository(
            root=Path("repo"),
            branch="main",
            upstream="origin/main",
            ahead=0,
            behind=0,
            changed_count=0,
        )

    def test_pull_preserves_failure_code_and_output(self):
        failure = GitCommandResult(1, "", "cannot fast-forward")
        with (
            patch("core.git_repo._require_upstream", return_value=self.repository),
            patch("core.git_repo._run_git", return_value=failure) as run_git,
        ):
            result = pull_repository(self.repository.root)

        self.assertFalse(result.success)
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot fast-forward", result.output)
        run_git.assert_called_once_with(
            self.repository.root,
            ["pull", "--ff-only"],
            timeout=120,
        )

    def test_fetch_failure_does_not_run_reset(self):
        failure = GitCommandResult(128, "", "remote unavailable")
        with (
            patch("core.git_repo._require_upstream", return_value=self.repository),
            patch("core.git_repo._run_git", return_value=failure) as run_git,
        ):
            result = reset_repository_to_upstream(self.repository.root)

        self.assertFalse(result.success)
        self.assertEqual(result.returncode, 128)
        self.assertIn("remote unavailable", result.output)
        run_git.assert_called_once_with(
            self.repository.root,
            ["fetch"],
            timeout=120,
        )

    def test_generated_file_listing_failure_marks_reset_failed(self):
        success = GitCommandResult(0, "ok", "")
        failure = GitCommandResult(1, "", "cannot list untracked files")
        with (
            patch("core.git_repo._require_upstream", return_value=self.repository),
            patch("core.git_repo._run_git", side_effect=[success, success, failure]) as run_git,
        ):
            result = reset_repository_to_upstream(self.repository.root)

        self.assertFalse(result.success)
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot list untracked files", result.output)
        self.assertEqual(
            run_git.call_args_list,
            [
                call(self.repository.root, ["fetch"], timeout=120),
                call(self.repository.root, ["reset", "--hard", "origin/main"], timeout=120),
                call(self.repository.root, ["ls-files", "--others", "--exclude-standard", "-z"]),
            ],
        )

    def test_remote_branch_refresh_preserves_fetch_failure(self):
        failure = GitCommandResult(128, "", "remote unavailable")
        with (
            patch("core.git_repo._repository_root", return_value=self.repository.root),
            patch("core.git_repo._run_git", return_value=failure) as run_git,
        ):
            result = refresh_remote_branches(self.repository.root)

        self.assertIsInstance(result, GitBranchesResult)
        self.assertFalse(result.success)
        self.assertEqual(result.returncode, 128)
        self.assertEqual(result.branches, ())
        self.assertIn("remote unavailable", result.output)
        run_git.assert_called_once_with(
            self.repository.root,
            ["fetch", "--prune"],
            timeout=120,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
