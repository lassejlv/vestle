"""Generate a complete, architecture-specific Tauri manifest before publishing."""
import base64
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys


def manifest(directory, tag, repo):
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', tag):
        raise ValueError('Expected a version tag')
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repo):
        raise ValueError('Expected owner/repository')
    version = tag[1:]
    platforms = {}
    for arch, target in [('arm64', 'darwin-aarch64'), ('x86_64', 'darwin-x86_64')]:
        stem = f'Termy-Code-{version}-macos-{arch}'
        archive = directory / f'{stem}.app.tar.gz'
        signature = directory / f'{archive.name}.sig'
        checksums = {}
        for line in (directory / f'{stem}.sha256').read_text().splitlines():
            digest, name = line.split(maxsplit=1)
            checksums[name] = digest
        for path in [archive, signature]:
            if hashlib.sha256(path.read_bytes()).hexdigest() != checksums.get(path.name):
                raise ValueError(f'Checksum mismatch: {path.name}')
        encoded = signature.read_text().strip()
        decoded = base64.b64decode(encoded, validate=True).decode()
        # Cryptographic verification runs in each architecture's packaging job.
        # Catch cross-version asset mixes again when assembling the final manifest.
        comment = next(line for line in decoded.splitlines() if line.startswith('trusted comment: '))
        if f'version:{version}' not in comment.removeprefix('trusted comment: ').split('\t'):
            raise ValueError('Updater signature belongs to another version')
        platforms[target] = {
            'signature': encoded,
            'url': f'https://github.com/{repo}/releases/download/{tag}/{archive.name}',
        }
    return {
        'version': version,
        'notes': f'Termy Code {version}',
        'pub_date': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'platforms': platforms,
    }


if __name__ == '__main__':
    directory = Path(sys.argv[1])
    result = manifest(directory, sys.argv[2], sys.argv[3])
    (directory / 'latest.json').write_text(json.dumps(result, indent=2) + '\n')
