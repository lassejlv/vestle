"""Reject mismatched versions before building or publishing a release."""
import json
import os
import re
from pathlib import Path

package = json.loads(Path('package.json').read_text())['version']
tauri = json.loads(Path('src-tauri/tauri.conf.json').read_text())['version']
cargo = re.search(r'^version = "([^"]+)"', Path('src-tauri/Cargo.toml').read_text(), re.M)[1]
assert package == tauri == cargo, f'Versions differ: package={package}, tauri={tauri}, cargo={cargo}'
assert re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', tauri), 'Invalid release version'
if os.environ.get('GITHUB_REF', '').startswith('refs/tags/'):
    assert os.environ['GITHUB_REF_NAME'] == f'v{tauri}', 'Tag must match the app version'
if 'GITHUB_ENV' in os.environ:
    with open(os.environ['GITHUB_ENV'], 'a') as env:
        env.write(f'APP_VERSION={tauri}\n')
print(f'App version: {tauri}')
