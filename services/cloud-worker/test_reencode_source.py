import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from local_intake_store import IntakeError, LocalInputs

spec = importlib.util.spec_from_file_location('reencode_existing', Path(__file__).with_name('reencode-existing.py'))
reencode = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reencode)


class ReencodeSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.root_patch = patch.object(reencode, 'worker_root', return_value=self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        self.store = LocalInputs(self.root / 'local-inputs-v1')
        self.addCleanup(self.store.close)
        data = b'original-high-quality-video'
        self.source = {'kind': 'local_file', 'protocolVersion': 1,
                       'sourceId': '00000000-0000-0000-0000-000000000001',
                       'jobId': '00000000-0000-0000-0000-000000000002',
                       'workerId': 'original-worker', 'name': 'original.mp4',
                       'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        with patch('local_intake_store.shutil.disk_usage') as disk:
            disk.return_value.free = 10 * 1024**3
            self.store.open(self.source)
        self.store.chunk(self.source['sourceId'], 0, data, self.source['sha256'])
        with patch('media_tools.probe', return_value={'duration': 1}):
            self.store.complete(self.source['sourceId'])
        self.lease = {'inputSource': self.source, 'job': {'id': 'maintenance-job',
                      'source_key': 'videos/reserved/source.mp4'}, 'downloadUrl': 'https://source.invalid'}

    def test_local_original_is_readable_while_intake_writer_is_running(self):
        with patch.object(reencode, 'download') as cloud:
            source = reencode.resolve_reencode_source(self.lease, self.source['jobId'])
            self.assertEqual(source.read_bytes(), b'original-high-quality-video')
            cloud.assert_not_called()
        self.assertEqual(self.store.status(self.source['sourceId'])['state'], 'READY')

    def test_missing_local_original_never_falls_back_to_virtual_r2(self):
        self.store.file(self.source['sourceId'], 'source.bin').unlink()
        with patch.object(reencode, 'download') as cloud:
            with self.assertRaisesRegex(IntakeError, 'LOCAL_SOURCE_MISSING'):
                reencode.resolve_reencode_source(self.lease, self.source['jobId'])
            cloud.assert_not_called()

    def test_same_size_tampering_is_rejected(self):
        self.store.file(self.source['sourceId'], 'source.bin').write_bytes(b'x' * self.source['size'])
        with self.assertRaisesRegex(IntakeError, 'LOCAL_SOURCE_SHA_MISMATCH'):
            reencode.resolve_reencode_source(self.lease, self.source['jobId'])

    def test_parent_job_and_worker_binding_cannot_change(self):
        for key in ('jobId', 'workerId'):
            with self.subTest(key=key), self.assertRaisesRegex(IntakeError, 'SOURCE_DECLARATION_CONFLICT'):
                reencode.verified_local_source({**self.source, key: 'different'})

    def test_non_ready_local_source_cannot_be_transcoded(self):
        self.store.mark_missing(self.source['sourceId'])
        with self.assertRaisesRegex(IntakeError, 'LOCAL_SOURCE_MISSING'):
            reencode.resolve_reencode_source(self.lease, self.source['jobId'])

    def test_cloud_input_keeps_cloud_cache_revalidation(self):
        self.lease['inputSource'] = {'kind': 'cloud_r2', 'key': self.lease['job']['source_key']}
        with patch.object(reencode, 'download') as cloud:
            target = reencode.resolve_reencode_source(self.lease, self.source['jobId'])
            cloud.assert_called_once_with(self.lease['downloadUrl'], target,
                                          source_key=self.lease['job']['source_key'])

    def test_unknown_or_conflicting_descriptor_cannot_download(self):
        for value in (None, [], 'bad', {}, {'kind': 'bad'}, {'kind': 'cloud_r2', 'key': 'other'}):
            with self.subTest(value=value), patch.object(reencode, 'download') as cloud:
                self.lease['inputSource'] = value
                with self.assertRaisesRegex(IntakeError, 'SOURCE_DECLARATION_CONFLICT'):
                    reencode.resolve_reencode_source(self.lease, self.source['jobId'])
                cloud.assert_not_called()

    def test_old_maintenance_lease_still_downloads_original(self):
        self.lease.pop('inputSource')
        with patch.object(reencode, 'download') as cloud:
            reencode.resolve_reencode_source(self.lease, self.source['jobId'])
            self.assertEqual(cloud.call_args.kwargs['source_key'], self.lease['job']['source_key'])


if __name__ == '__main__':
    unittest.main()
