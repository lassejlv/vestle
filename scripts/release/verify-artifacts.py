"""Verify final ZIP/DMG downloads and exercise the packaged daemon on native Macs."""
import base64
import hashlib
import json
import os
import platform
import plistlib
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def run(*args):
    return subprocess.run(args, check=True, capture_output=True).stdout


def smoke(app):
    with tempfile.TemporaryDirectory(prefix='tc-smoke-', dir='/tmp') as data:
        daemon = subprocess.Popen(
            [str(app / 'Contents/MacOS/termy-code'), '--daemon'],
            env=dict(os.environ, TERMY_DATA_DIR=data),
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        connections = []
        events = []
        sequence = 0
        try:
            path = data + '/daemon.sock'
            deadline = time.monotonic() + 15
            while not os.path.exists(path):
                assert daemon.poll() is None, 'Packaged daemon exited at startup'
                assert time.monotonic() < deadline, 'Daemon startup timed out'
                time.sleep(.025)

            def connect():
                sock = socket.socket(socket.AF_UNIX)
                sock.settimeout(10)
                sock.connect(path)
                stream = sock.makefile('rwb', buffering=0)
                connections.append((stream, sock))
                return stream

            def call(stream, method, params):
                nonlocal sequence
                sequence += 1
                stream.write((json.dumps(dict(id=sequence, method=method, params=params)) + '\n').encode())
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    message = json.loads(stream.readline())
                    if message.get('id') == sequence:
                        assert 'error' not in message, message
                        return message['result']
                    events.append(message)
                raise AssertionError('Daemon request timed out: ' + method)

            def output_until(stream, marker):
                seen = ''
                deadline = time.monotonic() + 15
                while marker not in seen:
                    assert time.monotonic() < deadline, 'Missing shell output: ' + marker
                    message = events.pop(0) if events else json.loads(stream.readline())
                    if message.get('event') == 'shell.output':
                        seen += base64.b64decode(message['data']['data']).decode(errors='replace')

            first = connect()
            hello = call(first, 'hello', {})
            params = dict(key='release-smoke', cwd=data, cols=80, rows=24)
            assert call(first, 'shell.open', params)['created']
            call(first, 'shell.write', dict(key=params['key'], data="printf 'release-%s\\n' 42\n"))
            output_until(first, 'release-42')
            call(first, 'shell.resize', dict(key=params['key'], cols=100, rows=40))
            call(first, 'shell.write', dict(key=params['key'], data='stty size\n'))
            output_until(first, '40 100')
            first.close()
            connections[0][1].close()
            events.clear()
            second = connect()
            assert call(second, 'hello', {})['pid'] == hello['pid']
            params.update(cols=100, rows=40)
            restored = call(second, 'shell.open', params)
            assert not restored['created']
            assert b'release-42' in base64.b64decode(restored['scrollback'])
            call(second, 'shell.write', dict(key=params['key'], data="printf 'resumed-%s\\n' 84\n"))
            output_until(second, 'resumed-84')
            call(second, 'shell.close', dict(key=params['key']))
            assert call(second, 'status', {})['shells'] == 0
            second.write(b'{"id":999,"method":"daemon.shutdown","params":{}}\n')
            assert daemon.wait(timeout=10) == 0
            print('Packaged daemon: terminal I/O, resize, reattachment, replay and shutdown passed')
        finally:
            for stream, sock in connections:
                stream.close()
                sock.close()
            if daemon.poll() is None:
                daemon.terminate()
                daemon.wait(timeout=10)


def verify_app(app, arch, team):
    run('codesign', '--verify', '--deep', '--strict', '--verbose=2', str(app))
    candidates = [app]
    for path in (app / 'Contents').rglob('*'):
        if path.is_file() and not path.is_symlink() and b'Mach-O' in run('file', '-b', str(path)):
            candidates.append(path)
    for path in candidates:
        result = subprocess.run(['codesign', '--display', '--verbose=4', str(path)], check=True, capture_output=True)
        metadata = result.stderr.decode()
        assert f'TeamIdentifier={team}' in metadata, metadata
        assert 'runtime' in metadata and 'Timestamp=' in metadata, metadata
        entitlements = run('codesign', '--display', '--entitlements', ':-', str(path))
        if entitlements.strip():
            values = plistlib.loads(entitlements)
            assert not values.get('com.apple.security.get-task-allow'), 'Debug entitlement in release'
    executable = app / 'Contents/MacOS/termy-code'
    assert run('lipo', '-archs', str(executable)).decode().strip() == arch
    run('xcrun', 'stapler', 'validate', str(app))
    run('spctl', '--assess', '--type', 'execute', '--verbose=2', str(app))
    if platform.machine() == arch:
        smoke(app)
    else:
        print(f'{arch}: signature verified; native runtime check requires a {arch} Mac')


def main():
    directory = Path(sys.argv[1]).resolve()
    arch = sys.argv[2]
    team = os.environ['APPLE_TEAM_ID']
    manifests = list(directory.glob(f'*-macos-{arch}.sha256'))
    assert len(manifests) == 1, 'Expected one checksum manifest for this architecture'
    files = {}
    for line in manifests[0].read_text().splitlines():
        checksum, name = line.split(maxsplit=1)
        assert Path(name).name == name, 'Invalid artifact filename'
        path = directory / name
        assert hashlib.sha256(path.read_bytes()).hexdigest() == checksum, f'Checksum mismatch: {name}'
        files[path.suffix] = path
    assert set(files) == {'.zip', '.dmg', '.gz', '.sig'}, 'Expected DMG, ZIP and signed updater archive'
    with tempfile.TemporaryDirectory(prefix='tc-verify-', dir='/tmp') as scratch:
        extracted = Path(scratch) / 'zip'
        run('ditto', '-x', '-k', str(files['.zip']), str(extracted))
        verify_app(extracted / 'Termy Code.app', arch, team)
        updater = Path(scratch) / 'updater'
        updater.mkdir()
        run('tar', '-xzf', str(files['.gz']), '-C', str(updater))
        verify_app(updater / 'Termy Code.app', arch, team)
        dmg = str(files['.dmg'])
        run('codesign', '--verify', '--strict', '--verbose=2', dmg)
        run('xcrun', 'stapler', 'validate', dmg)
        run('spctl', '--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg)
        mount = Path(scratch) / 'mount'
        mount.mkdir()
        run('hdiutil', 'attach', dmg, '-readonly', '-nobrowse', '-mountpoint', str(mount))
        try:
            verify_app(mount / 'Termy Code.app', arch, team)
        finally:
            run('hdiutil', 'detach', str(mount))
    print(f'{arch}: ZIP, DMG and updater checksums, signatures, tickets and Gatekeeper checks passed')


if __name__ == '__main__':
    main()
