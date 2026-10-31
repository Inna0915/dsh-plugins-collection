import os
import sys
import tempfile
import unittest
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "engine"))
sys.path.insert(0, str(root / "tests"))
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
with tempfile.TemporaryDirectory(prefix="engine-tests-", dir=root / ".task-temp") as temporary:
    os.environ["LOCALAPPDATA"] = str(Path(temporary) / "appdata")
    os.environ["TEMP"] = temporary
    os.environ["TMP"] = temporary
    tempfile.tempdir = temporary
    from process_job import install_owned_subprocesses
    install_owned_subprocesses()
    loader = unittest.TestLoader()
    group = 'release' if '--release' in sys.argv else "integration" if "--integration" in sys.argv else "fast" if "--fast" in sys.argv else "all"
    def flatten(suite):
        for item in suite:
            if isinstance(item, unittest.TestSuite):
                yield from flatten(item)
            else:
                yield item
    all_tests = unittest.TestSuite([loader.discover(str(root / "tests"), pattern="test_engine.py"),
                                   loader.discover(str(root / "tests"), pattern="test_jenkins_live.py"),
                                   loader.discover(str(root / "tests"), pattern="test_project_cache.py"),
                                   loader.discover(str(root / "tests" / "upstream"), pattern="test_*.py", top_level_dir=str(root / "tests" / "upstream"))])
    def included(test):
        if group == 'release':
            return test.id().startswith('test_release_notes.')
        integration = test.id().startswith(("test_git_repo.", "test_release_notes."))
        return group == "all" or integration == (group == "integration")
    suite = unittest.TestSuite(test for test in flatten(all_tests) if included(test))
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    (root / "docs" / ("tests-" + group + ".json")).write_text(json.dumps({"run":result.testsRun,"failures":[t.id() for t,_ in result.failures],"errors":[t.id() for t,_ in result.errors],"skipped":[t.id() for t,_ in result.skipped],"success":result.wasSuccessful()},indent=2))
    sys.exit(0 if result.wasSuccessful() else 1)
