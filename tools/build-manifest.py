import hashlib
import json
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
result = subprocess.run(['npm.cmd', 'pack', '--dry-run', '--json'], cwd=root, check=True, capture_output=True, text=True, encoding='utf-8')
report = json.loads(result.stdout)[0]
pkg = json.loads((root / 'package.json').read_text(encoding='utf-8'))
files = []
for entry in report['files']:
    relative = entry['path']
    if relative == 'MANIFEST-v5.json':
        continue
    data = (root / relative).read_bytes()
    files.append({'path': relative, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
files.sort(key=lambda item: item['path'])
manifest = {'kind': 'dsh-continuity-5.0.0-rewrite-source-manifest', 'version': pkg['version'], 'files': files}
(root / 'MANIFEST-v5.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'files': len(files), 'version': pkg['version']}, indent=2))
