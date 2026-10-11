import base64
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('updater_manifest', Path(__file__).with_name('updater-manifest.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for arch in ['arm64', 'x86_64']:
            stem = f'Termy-Code-0.2.0-macos-{arch}'
            archive = self.root / f'{stem}.app.tar.gz'
            archive.write_bytes(arch.encode())
            signature = self.root / f'{archive.name}.sig'
            signature.write_text(base64.b64encode(b'trusted comment: timestamp:1\tversion:0.2.0\n').decode())
            (self.root / f'{stem}.sha256').write_text('\n'.join(
                f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}' for p in [archive, signature]))

    def test_both_architectures_and_versioned_urls(self):
        result = module.manifest(self.root, 'v0.2.0', 'termylabs/code')
        self.assertEqual(set(result['platforms']), {'darwin-aarch64', 'darwin-x86_64'})
        self.assertTrue(result['platforms']['darwin-aarch64']['url'].endswith('/v0.2.0/Termy-Code-0.2.0-macos-arm64.app.tar.gz'))
        self.assertTrue(result['platforms']['darwin-x86_64']['url'].endswith('-x86_64.app.tar.gz'))
        self.assertEqual(result['version'], '0.2.0')

    def test_missing_architecture_fails(self):
        (self.root / 'Termy-Code-0.2.0-macos-x86_64.app.tar.gz').unlink()
        with self.assertRaises(FileNotFoundError):
            module.manifest(self.root, 'v0.2.0', 'termylabs/code')

    def test_tampered_archive_fails(self):
        (self.root / 'Termy-Code-0.2.0-macos-arm64.app.tar.gz').write_bytes(b'changed')
        with self.assertRaises(ValueError):
            module.manifest(self.root, 'v0.2.0', 'termylabs/code')

    def test_signature_for_another_version_fails(self):
        stem = 'Termy-Code-0.2.0-macos-arm64'
        sig = self.root / f'{stem}.app.tar.gz.sig'
        old = hashlib.sha256(sig.read_bytes()).hexdigest()
        sig.write_text(base64.b64encode(b'trusted comment: timestamp:1\tversion:0.1.0\n').decode())
        checksums = self.root / f'{stem}.sha256'
        checksums.write_text(checksums.read_text().replace(old, hashlib.sha256(sig.read_bytes()).hexdigest()))
        with self.assertRaises(ValueError):
            module.manifest(self.root, 'v0.2.0', 'termylabs/code')

    def test_invalid_tag_fails(self):
        with self.assertRaises(ValueError):
            module.manifest(self.root, 'main', 'termylabs/code')
