import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_artifacts import restore_media, save_media


class MediaArtifactTests(unittest.TestCase):
    def fixture(self, root):
        source, cache, output = (Path(root) / name for name in ('source', 'cache', 'output'))
        (source / '540p').mkdir(parents=True)
        (source / 'master.m3u8').write_text('#EXTM3U\n540p/index.m3u8\n', encoding='utf-8')
        (source / '540p/index.m3u8').write_text('#EXTM3U\n#EXTINF:4,\n000.ts\n#EXT-X-ENDLIST\n', encoding='utf-8')
        for name in ('540p/000.ts', 'cover.webp', 'cover-480.webp'):
            (source / name).write_bytes(b'verified output ' + name.encode())
        value = {'variants': [{'path': '540p/index.m3u8'}], 'coverImages': [{'path': 'cover-480.webp'}]}
        save_media(cache, source, 'source-and-profile-key', value)
        return source, cache, output, value

    def edit_receipt(self, cache, change):
        path = cache / 'receipt.json'
        receipt = json.loads(path.read_text(encoding='utf-8'))
        change(receipt)
        path.write_text(json.dumps(receipt), encoding='utf-8')

    def test_roundtrip_restores_complete_media_and_rejects_wrong_source(self):
        with tempfile.TemporaryDirectory() as root:
            source, cache, output, value = self.fixture(root)
            self.assertIsNone(restore_media(cache, output, 'different-source'))
            self.assertFalse(output.exists())
            self.assertEqual(restore_media(cache, output, 'source-and-profile-key'), value)
            for path in source.rglob('*'):
                if path.is_file():
                    self.assertEqual(path.read_bytes(), (output / path.relative_to(source)).read_bytes())

    def test_incomplete_duplicate_or_extra_receipt_cannot_restore(self):
        def omit_segment(receipt):
            receipt['files'] = [row for row in receipt['files'] if not row['path'].endswith('.ts')]
        def duplicate(receipt):
            receipt['files'].append(receipt['files'][0])
        def escape(receipt):
            receipt['files'][0]['path'] = '../outside'
        for mutate in (omit_segment, duplicate, escape):
            with self.subTest(mutation=mutate.__name__), tempfile.TemporaryDirectory() as root:
                _, cache, output, _ = self.fixture(root)
                self.edit_receipt(cache, mutate)
                self.assertIsNone(restore_media(cache, output, 'source-and-profile-key'))
                self.assertFalse(output.exists())

    def test_corrupt_segment_cannot_restore(self):
        with tempfile.TemporaryDirectory() as root:
            _, cache, output, _ = self.fixture(root)
            (cache / '540p/000.ts').write_bytes(b'corrupt segment')
            self.assertIsNone(restore_media(cache, output, 'source-and-profile-key'))
            self.assertFalse(output.exists())

    def test_incomplete_playlist_cannot_be_saved(self):
        with tempfile.TemporaryDirectory() as root:
            source, cache, _, value = self.fixture(root)
            (source / '540p/index.m3u8').write_text('#EXTM3U\n000.ts\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'NOT_FINAL'):
                save_media(cache, source, 'source-and-profile-key', value)

    def test_source_and_destination_symlink_components_are_rejected(self):
        # Patch the OS symlink predicate so this regression also runs on Windows
        # hosts without the CreateSymbolicLink privilege.
        for side in ('cache', 'output'):
            with self.subTest(side=side), tempfile.TemporaryDirectory() as root:
                _, cache, output, _ = self.fixture(root)
                unsafe = (cache if side == 'cache' else output) / '540p'
                actual = Path.is_symlink
                with patch.object(Path, 'is_symlink', lambda path: path == unsafe or actual(path)):
                    self.assertIsNone(restore_media(cache, output, 'source-and-profile-key'))
                self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
