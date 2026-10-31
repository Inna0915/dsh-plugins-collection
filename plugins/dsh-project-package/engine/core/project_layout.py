"""DSH adapter: explicit output module, leaving the desktop heuristics as fallback."""
from pathlib import Path

_targets = {}


def set_target(project: str, target: str):
    root, directory = Path(project).resolve(), Path(target).resolve()
    if not directory.is_relative_to(root):
        raise ValueError("产物模块必须位于项目中")
    _targets[str(root)] = directory


def selected_target(project: str):
    return _targets.get(str(Path(project).resolve()))
