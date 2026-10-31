"""Create a distributable from the explicit package.json file list."""
import hashlib
import json
import tarfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
output = root / 'releases' / f"{package['name']}-{package['version']}.tgz"
output.parent.mkdir(exist_ok=True)
names = []
with tarfile.open(output, 'w:gz') as archive:
    for relative in ['package.json', *package['files']]:
        source = root / relative
        if not source.exists():
            raise FileNotFoundError(source)
        files = sorted(source.rglob('*')) if source.is_dir() else [source]
        for file in files:
            if not file.is_file() or '__pycache__' in file.parts or file.suffix == '.pyc':
                continue
            name = 'package/' + file.relative_to(root).as_posix()
            archive.add(file, arcname=name, recursive=False)
            names.append(name)
with tarfile.open(output) as archive:
    assert archive.getnames() == names
    assert json.load(archive.extractfile('package/package.json'))['version'] == package['version']
assert not any('installation' in name or '.task-temp' in name for name in names)
digest = hashlib.sha256(output.read_bytes()).hexdigest()
Path(str(output) + '.sha256').write_text(digest + '  ' + output.name + '\n', encoding='utf-8')
print(json.dumps({'release': str(output), 'files': len(names), 'bytes': output.stat().st_size, 'sha256': digest}))
