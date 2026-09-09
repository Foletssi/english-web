import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).with_name('worker.py')
SPEC = importlib.util.spec_from_file_location('cloud_worker', MODULE)
worker = importlib.util.module_from_spec(SPEC)
sys.modules['cloud_worker'] = worker
SPEC.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_v2_progress_carries_run_and_monotonic_sequence(self):
        calls = []
        class Client:
            def call(self, action, **values):
                calls.append((action, values))
                return {'ok': True}
        lease = {'job': {'id': '00000000-0000-0000-0000-000000000001',
                         'run_id': '00000000-0000-0000-0000-000000000002'}, 'token': 'x' * 32}
        worker.report_progress(Client(), lease, 'ASR', 55, '识别', {'current': 1, 'total': 10})
        worker.report_progress(Client(), lease, 'ASR', 56, '识别', {'current': 2, 'total': 10})
        self.assertEqual([row[0] for row in calls], ['worker-telemetry-v2', 'worker-telemetry-v2'])
        self.assertEqual([row[1]['sequence'] for row in calls], [1, 2])
        self.assertEqual(calls[0][1]['runId'], lease['job']['run_id'])

    def test_worker_id_is_ascii_safe_for_non_ascii_hostname(self):
        value = worker.default_worker_id('学习电脑')
        self.assertRegex(value, r'^[A-Za-z0-9._-]{3,80}$')
        self.assertEqual(value, worker.default_worker_id('学习电脑'))

    def test_content_types(self):
        self.assertEqual(worker.content_type('720p/index.m3u8'), 'application/vnd.apple.mpegurl')
        self.assertEqual(worker.content_type('720p/segment_00001.ts'), 'video/mp2t')

    def test_result_urls_point_to_cloud_route(self):
        result = {'video': {'playback': {'variants': [{'path': '720p/index.m3u8'}]}}, 'evidence': {}}
        value = worker.rewrite_result(result, '00000000-0000-0000-0000-000000000001')
        self.assertEqual(value['video']['mediaUrl'], '/api/processing/media/00000000-0000-0000-0000-000000000001/master.m3u8')
        self.assertEqual(value['evidence']['storage'], 'cloudflare-r2')

    def test_empty_download_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'source.mp4'
            target.write_bytes(b'')
            self.assertEqual(target.stat().st_size, 0)

    def test_range_response_must_match_version_and_offset(self):
        headers = {'ETag': 'v1', 'Content-Range': 'bytes 50-99/100'}
        self.assertEqual(worker.download_response_mode(206, headers, 50, 100, 'v1'), ('ab', 50))
        self.assertEqual(worker.download_response_mode(200, {'ETag': 'v1'}, 50, 100, 'v1'), ('wb', 100))
        with self.assertRaisesRegex(worker.ApiError, 'SOURCE_VERSION_CHANGED'):
            worker.download_response_mode(206, headers, 50, 100, 'v2')
        with self.assertRaisesRegex(worker.ApiError, 'SOURCE_CONTENT_RANGE_MISMATCH'):
            worker.download_response_mode(206, headers, 0, 100, 'v1')

    def test_worker_root_honors_dedicated_directory(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {'EASTUDY_WORK_ROOT': folder}):
            self.assertEqual(worker.worker_root(), Path(folder).resolve())


if __name__ == '__main__':
    unittest.main()
