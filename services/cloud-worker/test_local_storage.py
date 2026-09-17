import hashlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local-studio'))

from local_intake_store import IntakeError, LocalInputs
from local_storage import cleanup_copy, source_access


class LocalStorageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = LocalInputs(Path(self.temp.name))
        self.addCleanup(self.store.close)
        self.source = {'sourceId': '00000000-0000-0000-0000-000000000001',
                       'jobId': '00000000-0000-0000-0000-000000000002',
                       'workerId': 'test-worker', 'name': 'video.mp4',
                       'size': 5, 'sha256': hashlib.sha256(b'video').hexdigest()}
        with patch('local_intake_store.shutil.disk_usage') as disk:
            disk.return_value.free = 10 * 1024**3
            self.store.open(self.source)
        self.store.chunk(self.source['sourceId'], 0, b'video', self.source['sha256'])
        with patch('media_tools.probe'):
            self.store.complete(self.source['sourceId'])

    def test_rejected_cloud_state_preserves_source(self):
        with self.assertRaisesRegex(IntakeError, 'NOT_COMPLETE'):
            cleanup_copy(self.store, self.source['sourceId'], lambda _: False)
        self.assertEqual(self.store.require_ready(self.source).read_bytes(), b'video')

    def test_reader_blocks_cleanup(self):
        with source_access(self.store.root, self.source['sourceId']):
            with self.assertRaises(OSError):
                cleanup_copy(self.store, self.source['sourceId'], lambda _: True)
        self.assertEqual(self.store.require_ready(self.source).read_bytes(), b'video')

    def test_cleanup_is_idempotent_and_preserves_receipt(self):
        self.assertEqual(self.store.storage_usage()['applicationBytes'], 5)
        self.assertEqual(cleanup_copy(self.store, self.source['sourceId'], lambda _: True), 5)
        self.assertEqual(cleanup_copy(self.store, self.source['sourceId'], lambda _: True), 0)
        self.assertEqual(self.store.status(self.source['sourceId'])['state'], 'MISSING')
        self.assertEqual(self.store.storage_usage()['applicationBytes'], 0)
        with self.assertRaisesRegex(IntakeError, 'LOCAL_SOURCE_MISSING'):
            self.store.require_ready(self.source)

    def test_unexpected_directory_blocks_cleanup_before_any_delete(self):
        (self.store.directory(self.source['sourceId']) / 'unexpected').mkdir()
        with self.assertRaisesRegex(IntakeError, 'SOURCE_PATH_INVALID'):
            cleanup_copy(self.store, self.source['sourceId'], lambda _: True)
        self.assertEqual(self.store.require_ready(self.source).read_bytes(), b'video')


if __name__ == '__main__':
    unittest.main()
