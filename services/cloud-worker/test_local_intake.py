import hashlib
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local-studio'))
from local_intake_store import LocalInputs, IntakeError


class LocalIntakeTests(unittest.TestCase):
    def ready_store(self, root):
        source = self.declaration(b'video')
        store = LocalInputs(root)
        self.addCleanup(store.close)
        store.open(source)
        store.chunk(source['sourceId'], 0, b'video', source['sha256'])
        with patch('media_tools.probe', return_value={'duration': 1}):
            store.complete(source['sourceId'])
        return store, source

    def test_closed_store_rejects_writes_and_releases_ownership(self):
        with tempfile.TemporaryDirectory() as root:
            store = LocalInputs(root)
            store.close()
            store.close()
            with self.assertRaisesRegex(IntakeError, 'STORE_CLOSED'):
                store.open(self.declaration(b'video'))
            with self.assertRaisesRegex(IntakeError, 'STORE_CLOSED'):
                store.stage('job', 'run', 'media', {'state': 'DONE'})
            replacement = LocalInputs(root)
            replacement.close()

    def test_database_initialization_failure_releases_ownership(self):
        with tempfile.TemporaryDirectory() as root:
            with patch('local_intake_store.sqlite3.connect', side_effect=RuntimeError('database unavailable')):
                with self.assertRaisesRegex(RuntimeError, 'database unavailable'):
                    LocalInputs(root)
            replacement = LocalInputs(root)
            replacement.close()

    def test_missing_notification_retries_after_network_failure(self):
        with tempfile.TemporaryDirectory() as root:
            store, source = self.ready_store(root)
            try:
                store.file(source['sourceId'], 'source.bin').unlink()
                client = Mock()
                store.drain_outbox(client)
                client.call.assert_not_called()
                self.assertEqual(store.status(source['sourceId'])['state'], 'MISSING')
                client.call.side_effect = RuntimeError('network down')
                store.drain_outbox(client)
                self.assertFalse(store.status(source['sourceId'])['notified'])
                client.call.side_effect = None
                store.drain_outbox(client)
                client.call.assert_called_with('worker-local-missing', sourceId=source['sourceId'], sha256=source['sha256'])
                self.assertTrue(store.status(source['sourceId'])['notified'])
            finally:
                store.close()

    def test_notification_does_not_acknowledge_a_new_state(self):
        with tempfile.TemporaryDirectory() as root:
            store, source = self.ready_store(root)
            try:
                client = Mock()
                client.call.side_effect = lambda *_args, **_kwargs: store.mark_missing(source['sourceId'])
                store.drain_outbox(client)
                status = store.status(source['sourceId'])
                self.assertEqual(status['state'], 'MISSING')
                self.assertFalse(status['notified'])
            finally:
                store.close()

    def test_cancelled_notification_stops_retrying(self):
        with tempfile.TemporaryDirectory() as root:
            store, source = self.ready_store(root)
            try:
                client = Mock()
                client.call.side_effect = IntakeError('VIDEO_IN_TRASH')
                store.drain_outbox(client)
                store.drain_outbox(client)
                self.assertEqual(store.status(source['sourceId'])['state'], 'CANCELLED')
                self.assertEqual(client.call.call_count, 1)
            finally:
                store.close()

    def test_unsafe_ready_path_marks_input_missing(self):
        with tempfile.TemporaryDirectory() as root:
            store, source = self.ready_store(root)
            try:
                with patch.object(store, 'file', side_effect=IntakeError('SOURCE_PATH_INVALID')):
                    with self.assertRaisesRegex(IntakeError, 'SOURCE_PATH_INVALID'):
                        store.require_ready(source)
                self.assertEqual(store.status(source['sourceId'])['state'], 'MISSING')
            finally:
                store.close()

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
                    with self.assertRaisesRegex(IntakeError, 'FINALIZATION_ACTIVE'):
                        store.close()
                    self.assertFalse(store.closed)
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
