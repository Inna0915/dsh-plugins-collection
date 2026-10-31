"""Persist discovery results; validate known POMs without walking whole workspaces."""
import json
from pathlib import Path

from discovery import discover, key

# Bump when discovery rules change so results from older rules are rescanned.
SCHEMA = 2


def sources(workspaces, recent):
    roots = sorted((key(w['path']), w.get('title', '工作区')) for w in workspaces if w.get('path'))
    outside = sorted({key(path) for path in recent if not any(Path(key(path)).is_relative_to(Path(root)) for root, _ in roots)})
    return [roots, outside]


def signatures(projects):
    result = {}
    for project in projects:
        for directory in project.get('modulePaths', [project['path']]):
            path = Path(directory) / 'pom.xml'
            stat = path.stat()
            result[str(path)] = [stat.st_mtime_ns, stat.st_size]
    return result


def cached_discover(path, workspaces, recent, force=False):
    source_key = json.dumps(sources(workspaces, recent), ensure_ascii=False)
    if not force:
        try:
            saved = json.loads(path.read_text(encoding='utf-8'))
            result = saved['result']
            if saved['schema'] == SCHEMA and saved['sources'] == source_key and saved['signatures'] == signatures(result['projects']):
                return result, True
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            pass
    result = discover(workspaces, recent)
    try:
        saved = {'schema': SCHEMA, 'sources': source_key, 'signatures': signatures(result['projects']), 'result': result}
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix('.tmp')
        try:
            temporary.write_text(json.dumps(saved, ensure_ascii=False), encoding='utf-8')
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
    except OSError:
        pass  # A read-only cache location must not prevent packaging.
    return result, False
