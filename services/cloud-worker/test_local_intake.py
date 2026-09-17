import hashlib
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local-studio'))
from local_intake_store import LocalInputs, IntakeError


class LocalIntakeTests(unittest.TestCase):
    def test_missing_source_reception_respects_queue_capacity(self):
        with tempfile.TemporaryDirectory() as root:
            store = LocalInputs(root)
            try:
                original = self.declaration(b'video')
                store.open(original)
                store.mark_missing(original['sourceId'])
                for index in (3, 4):
                    store.open({**original, 'sourceId': f'00000000-0000-0000-0000-{index:012d}'})
                with self.assertRaisesRegex(IntakeError, 'LOCAL_INTAKE_QUEUE_FULL'):
                    store.open(original)
                self.assertEqual(store.status(original['sourceId'])['state'], 'MISSING')
            finally:
                store.close()

    def declaration(self, data):
        return {'sourceId': '00000000-0000-0000-0000-000000000001',
                'jobId': '00000000-0000-0000-0000-000000000002',
                'workerId': 'test-worker', 'name': 'test.mp4', 'size': len(data),
                'sha256': hashlib.sha256(data).hexdigest()}

    def test_restart_reuses_verified_chunks_and_rejects_different_original(self):
        data = b'original-media'
        source = self.declaration(data)
        with tempfile.TemporaryDirectory() as root:
            store = LocalInputs(root)
            try:
                store.open(source)
                store.chunk(source['sourceId'], 0, data, source['sha256'])
            finally:
                store.close()
            store = LocalInputs(root)
            try:
                self.assertEqual(len(store.open(source)['chunks']), 1)
                with self.assertRaisesRegex(IntakeError, 'DECLARATION_CONFLICT'):
                    store.open({**source, 'sha256': 'a' * 64})
                with patch('media_tools.probe', return_value={'duration': 1}):
                    store.complete(source['sourceId'])
                self.assertEqual(store.require_ready(source).read_bytes(), data)
                store.require_ready(source).write_bytes(b'corrupt-media!')
                with self.assertRaises(IntakeError):
                    store.require_ready(source)
                self.assertEqual(store.status(source['sourceId'])['state'], 'MISSING')
            finally:
                store.close()

    def test_finalization_does_not_block_status_or_publish_before_probe(self):
        source = self.declaration(b'video')
        started, release = threading.Event(), threading.Event()
        def probe(_path):
            started.set()
            if not release.wait(5):
                raise RuntimeError('test timeout')
        with tempfile.TemporaryDirectory() as root:
            store = LocalInputs(root)
            try:
                store.open(source)
                store.chunk(source['sourceId'], 0, b'video', source['sha256'])
                with patch('media_tools.probe', side_effect=probe):
                    store.begin_complete(source['sourceId'])
                    self.assertTrue(started.wait(2))
                    self.assertEqual(store.status(source['sourceId'])['state'], 'VERIFYING')
                    self.assertEqual(store.begin_complete(source['sourceId'])['state'], 'VERIFYING')
                    thread = store.finalizers[source['sourceId']]
                    release.set()
                    thread.join(3)
                self.assertEqual(store.status(source['sourceId'])['state'], 'READY')
            finally:
                release.set()
                store.close()

    def test_corrupt_chunk_is_not_reused(self):
        source = self.declaration(b'video')
        with tempfile.TemporaryDirectory() as root:
            store = LocalInputs(root)
            try:
                store.open(source)
                store.chunk(source['sourceId'], 0, b'video', source['sha256'])
                store.file(source['sourceId'], '0.chunk').write_bytes(b'wrong')
                self.assertEqual(store.status(source['sourceId'], verify=True)['chunks'], [])
                with self.assertRaisesRegex(IntakeError, 'CHUNKS_INCOMPLETE'):
                    store.complete(source['sourceId'])
            finally:
                store.close()
