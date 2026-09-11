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
    def test_worker_reports_v5_protocol_version(self):
        self.assertEqual(worker.VERSION, '2.3.0')
        source = MODULE.read_text(encoding='utf-8')
        self.assertIn("'learningRepairV5': True", source)
        self.assertIn("'teachingSchemaVersion': 3", source)

    def test_upload_concurrency_is_bounded(self):
        with patch.dict('os.environ', {'EASTUDY_UPLOAD_CONCURRENCY': '99'}):
            self.assertEqual(worker.upload_concurrency(), 8)
        with patch.dict('os.environ', {'EASTUDY_UPLOAD_CONCURRENCY': 'invalid'}):
            self.assertEqual(worker.upload_concurrency(), 6)

    def test_parallel_upload_preserves_manifest_order_and_receipts(self):
        calls = []
        class Client:
            def upload(self, _url, _token, _job_id, path, source):
                return {'size': source.stat().st_size, 'sha256': path.replace('/', '-'), 'etag': path}
            def call(self, action, **values):
                calls.append((action, values))
                return {'ok': True}
        lease = {'job': {'id': '00000000-0000-0000-0000-000000000001',
                         'run_id': '00000000-0000-0000-0000-000000000002'},
                 'token': 'x' * 32, 'outputUrl': 'https://example.test/upload?job=one'}
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            assets = []
            for name in ('z.ts', 'a.m3u8', 'm.webp'):
                path = output / name
                path.write_bytes(name.encode())
                assets.append(path)
            manifest = worker.upload_assets(Client(), lease, output, assets)
        self.assertEqual([item['path'] for item in manifest], ['a.m3u8', 'm.webp', 'z.ts'])
        self.assertEqual(sum(action == 'worker-output-receipt-v2' for action, _ in calls), 3)

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
        value = worker.rewrite_result(result, '00000000-0000-0000-0000-000000000001',
                                      'videos/00000000-0000-0000-0000-000000000099/source.mp4')
        self.assertEqual(value['video']['mediaUrl'], '/api/processing/media/00000000-0000-0000-0000-000000000001/720p/index.m3u8')
        self.assertNotIn('original', value['video']['playback'])
        self.assertEqual(value['evidence']['storage'], 'cloudflare-r2')

    def test_selected_assets_ignore_stale_renditions(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            for name in ('master.m3u8', 'cover.webp', '720p/index.m3u8',
                         '720p/segment_00000.ts', '1080p/index.m3u8', '1080p/segment_00000.ts'):
                path = output / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b'x')
            result = {'video': {'playback': {'variants': [{'path': '720p/index.m3u8'}]}}}
            assets = worker.selected_assets(output, result)
            self.assertEqual([path.relative_to(output).as_posix() for path in assets],
                             ['720p/index.m3u8', '720p/segment_00000.ts', 'cover.webp', 'master.m3u8'])

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

    def test_learning_repair_skips_all_media_io(self):
        calls = []
        class Client:
            def call(self, action, **values):
                calls.append((action, values))
                return {'ok': True}
        lease = {'job': {'id': '00000000-0000-0000-0000-000000000001',
                         'run_id': '00000000-0000-0000-0000-000000000002',
                         'input': {'kind': 'LEARNING_REPAIR', 'sentences': [
                             {'id': '1-1', 'english': 'Good morning', 'chinese': '', 'keyWords': ['Good morning']}
                         ]}}, 'token': 'x' * 32}
        repaired = [{'id': '1-1', 'english': 'Good morning', 'chinese': '早上好',
                     'keyWords': ['Good morning'], 'expressions': [{'surface': 'Good morning',
                     'coreMeaningZh': '早上好', 'contextMeaningZh': '日常问候'}]}]
        with tempfile.TemporaryDirectory() as folder, \
             patch.dict('os.environ', {'EASTUDY_WORK_ROOT': folder}), \
             patch.object(worker, 'repair_learning', return_value=(repaired, {'model': 'test'})), \
             patch.object(worker, 'download') as download_mock, \
             patch.object(worker, 'process_job') as process_mock, \
             patch.object(worker, 'upload_assets') as upload_mock:
            worker.process_lease(Client(), lease)
        download_mock.assert_not_called()
        process_mock.assert_not_called()
        upload_mock.assert_not_called()
        self.assertEqual(calls[-1][0], 'worker-complete-learning-v5')
        self.assertEqual(calls[-1][1]['result']['sentences'], repaired)


if __name__ == '__main__':
    unittest.main()
