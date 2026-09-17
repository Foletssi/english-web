import tempfile
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from checkpoint import file_sha256
from voice_cache import copy_audio, restore_audio, store_audio, prune_cache


class VoiceCacheTests(unittest.TestCase):
    def test_eviction_preserves_recent_audio_independent_job_and_unowned_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = root / 'cache'
            source = root / 'job.mp3'
            source.write_bytes(b'a' * 600)
            metadata = {'duration': .5, 'bytes': 600, 'contentHash': file_sha256(source),
                        'contentType': 'audio/mpeg'}
            for index, character in enumerate('ab'):
                fingerprint = character * 64
                store_audio(cache, fingerprint, source, metadata)
                os.utime(cache / f'{fingerprint}.json', (index + 1, index + 1))
            (cache / 'notes.json').write_text('{}')
            (cache / 'unfinished.part').write_bytes(b'keep')
            one_size = sum((cache / ('a' * 64 + suffix)).stat().st_size for suffix in ('.mp3', '.json'))
            prune_cache(cache, one_size)
            self.assertFalse((cache / ('a' * 64 + '.mp3')).exists())
            self.assertIsNotNone(restore_audio(cache, 'b' * 64, root / 'another-job.mp3'))
            self.assertEqual(source.read_bytes(), b'a' * 600)
            self.assertTrue((cache / 'notes.json').is_file())
            self.assertTrue((cache / 'unfinished.part').is_file())
            prune_cache(cache, 0)
            self.assertEqual((root / 'another-job.mp3').read_bytes(), b'a' * 600)

    def test_cache_maintenance_failure_does_not_raise(self):
        with tempfile.TemporaryDirectory() as folder:
            for value in ('invalid', '-1'):
                with patch.dict('os.environ', EASTUDY_VOICE_CACHE_MAX_BYTES=value):
                    prune_cache(folder)
            with patch('voice_cache.Path.glob', side_effect=PermissionError):
                prune_cache(folder)

    def test_concurrent_source_replacement_cannot_deliver_wrong_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, destination = root / 'source.mp3', root / 'job' / 'audio.mp3'
            source.write_bytes(b'a' * 600)
            metadata = {'duration': .5, 'bytes': 600, 'contentHash': file_sha256(source),
                        'contentType': 'audio/mpeg'}
            fingerprint = 'a' * 64
            store_audio(root / 'cache', fingerprint, source, metadata)

            def concurrent_copy(cached, target):
                # A writer replaces the source after receipt/hash validation.
                Path(cached).write_bytes(b'b' * 600)
                copy_audio(cached, target)

            with patch('voice_cache.copy_audio', side_effect=concurrent_copy):
                self.assertIsNone(restore_audio(root / 'cache', fingerprint, destination))
            self.assertFalse(destination.exists())
            self.assertEqual(list(destination.parent.glob('*.part')), [])

    def test_invalid_receipt_or_missing_audio_is_cache_miss(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            fingerprint = 'a' * 64
            receipt = root / (fingerprint + '.json')
            for content in ('not json', 'null', '{}', '{"metadata": []}'):
                receipt.write_text(content, encoding='utf-8')
                self.assertIsNone(restore_audio(root, fingerprint, root / 'out.mp3'))


if __name__ == '__main__':
    unittest.main()
