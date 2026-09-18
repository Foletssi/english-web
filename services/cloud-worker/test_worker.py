import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

MODULE = Path(__file__).with_name('worker.py')
SPEC = importlib.util.spec_from_file_location('cloud_worker', MODULE)
worker = importlib.util.module_from_spec(SPEC)
sys.modules['cloud_worker'] = worker
SPEC.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_output_lost_response_reconciles_without_second_put(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'worker', {})
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'segment.ts'
            source.write_bytes(b'abc')
            receipt = {'ok': True, 'found': True, 'size': 3, 'sha256': worker.file_sha256(source), 'etag': 'etag'}
            with patch.object(worker, 'request_json', side_effect=[{'ok': True, 'found': False},
                    worker.ApiError('OUTPUT_UNAVAILABLE'), receipt]) as request, patch.object(worker.time, 'sleep'):
                self.assertEqual(client.upload('https://example.test?run=run', '', '', 'segment.ts', source), receipt)
            self.assertEqual([call.args[0].method for call in request.call_args_list], ['GET', 'PUT', 'GET'])
            self.assertTrue(all(call.args[0].get_header('User-agent') == f'EastudyCloudWorker/{worker.VERSION}'
                                for call in request.call_args_list))

    def test_partial_commit_response_retries_without_reprocessing(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'worker', {})
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        with patch.object(worker.urllib.request, 'urlopen', side_effect=[
                worker.http.client.IncompleteRead(b'partial'), response]) as request, patch.object(worker.time, 'sleep'):
            self.assertTrue(client.call('worker-complete-v2', result={'video': {}})['ok'])
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[0].args[0].data, request.call_args_list[1].args[0].data)

    def test_output_reconcile_conflict_does_not_overwrite(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'worker', {})
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'segment.ts'
            source.write_bytes(b'abc')
            with patch.object(worker, 'request_json', return_value={'ok': True, 'found': True, 'size': 3, 'sha256': 'bad'}) as request:
                with self.assertRaisesRegex(worker.ApiError, 'OUTPUT_RECEIPT_CONFLICT'):
                    client.upload('https://example.test?run=run', '', '', 'segment.ts', source)
            self.assertEqual(request.call_count, 1)

    def test_commit_retries_identical_payload_after_lost_response(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'worker', {})
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        with patch.object(worker.urllib.request, 'urlopen', side_effect=[TimeoutError(), response]) as request, patch.object(worker.time, 'sleep'):
            self.assertTrue(client.call('worker-complete-v2', result={'video': {}}, manifest=[])['ok'])
        self.assertEqual(request.call_args_list[0].args[0].data, request.call_args_list[1].args[0].data)

    def test_voice_progress_exposes_counts_without_changing_item_manifest(self):
        client = MagicMock()
        lease = {'job': {'id': 'job', 'video_id': 'video', 'run_id': 'run'}, 'token': 'token'}
        manifest = {'status': 'complete', 'items': ['unchanged']}
        def generate(video_id, revision, rows, output, cancelled, progress):
            self.assertEqual((video_id, revision), ('video', 'run'))
            progress({'current': 3, 'total': 3, 'uniqueTotal': 2, 'uniqueReady': 1,
                      'generated': 1, 'reused': 1, 'failed': 1, 'elapsedSeconds': 2.5})
            return manifest
        with patch.object(worker, 'generate_worker_voice', side_effect=generate):
            self.assertIs(worker.prepare_voice(client, lease, [], Path('unused'), None), manifest)
        args = client.call.call_args.kwargs
        self.assertEqual(args['metrics']['generated'], 1)
        self.assertEqual(args['metrics']['reused'], 1)
        self.assertIn('失败 1', args['message'])
        self.assertEqual(args['runId'], 'run')

    def test_idempotent_network_retry_is_bounded(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'test-worker', {})
        with patch.object(worker.urllib.request, 'urlopen', side_effect=TimeoutError()) as request, \
             patch.object(worker.time, 'sleep') as sleep:
            with self.assertRaises(worker.ApiError):
                client.call('worker-output-receipt-v2')
        self.assertEqual(request.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])

    def test_receipt_retries_transient_failure_with_identical_payload(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'test-worker', {})
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        error = worker.urllib.error.HTTPError('https://example.test', 503, 'busy', {}, io.BytesIO(b'{}'))
        with patch.object(worker.urllib.request, 'urlopen', side_effect=[error, response]) as request, \
             patch.object(worker.time, 'sleep'):
            self.assertTrue(client.call('worker-output-receipt-v2', runId='run', path='540p/a.ts')['ok'])
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args_list[0].args[0].data, request.call_args_list[1].args[0].data)

    def test_claim_and_permission_failure_are_not_retried(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'test-worker', {})
        for action, status in [('worker-claim', 503), ('worker-telemetry-v2', 403)]:
            error = worker.urllib.error.HTTPError('https://example.test', status, 'failed', {}, io.BytesIO(b'{}'))
            with patch.object(worker.urllib.request, 'urlopen', side_effect=error) as request:
                with self.assertRaises(worker.ApiError):
                    client.call(action)
            self.assertEqual(request.call_count, 1)

    def test_progress_outage_does_not_abort_but_lease_loss_does(self):
        lease = {'job': {'id': 'job', 'run_id': 'run'}, 'token': 'token'}
        client = MagicMock()
        client.call.side_effect = worker.ApiError('EDGE_HTTP_503', status=503)
        self.assertIsNone(worker.report_progress(client, lease, 'LOCAL_UPLOAD', 96, '上传'))
        client.call.side_effect = worker.ApiError('JOB_LEASE_LOST_OR_CANCELLED', status=403)
        with self.assertRaises(worker.ApiError):
            worker.report_progress(client, lease, 'LOCAL_UPLOAD', 96, '上传')

    def test_wrapped_business_errors_are_not_retried(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'test-worker', {})
        for code in ('VIDEO_IN_TRASH', 'JOB_NOT_FOUND', 'OUTPUT_RECEIPT_CONFLICT'):
            for action in ('worker-telemetry-v2', 'worker-output-receipt-v2'):
                with self.subTest(code=code, action=action):
                    detail = {'ok': False, 'error': 'SUPABASE_400:' + code}
                    errors = [worker.urllib.error.HTTPError(client.endpoint, 500, 'failed', {},
                              io.BytesIO(worker.json.dumps(detail).encode())) for _ in range(3)]
                    for error in errors:
                        self.addCleanup(error.close)
                    with patch.object(worker.urllib.request, 'urlopen', side_effect=errors) as request, \
                         patch.object(worker.time, 'sleep') as sleep:
                        with self.assertRaises(worker.ApiError) as raised:
                            client.call(action)
                    self.assertEqual(request.call_count, 1)
                    sleep.assert_not_called()
                    self.assertEqual(raised.exception.code, code)
                    self.assertEqual(raised.exception.status, 400)
                    self.assertEqual(raised.exception.detail, detail)

    def test_wrapped_lease_refusals_cancel_the_run(self):
        for code in ('VIDEO_IN_TRASH', 'JOB_NOT_FOUND', 'JOB_LEASE_LOST_OR_CANCELLED', 'RUN_ID_MISMATCH'):
            with self.subTest(code=code):
                detail = worker.json.dumps({'ok': False, 'error': 'SUPABASE_400:' + code}).encode()
                error = worker.urllib.error.HTTPError('https://example.test', 500, 'failed', {}, io.BytesIO(detail))
                self.addCleanup(error.close)
                self.assertTrue(worker.lease_cancelled(worker.api_error_from_http(error)))

    def test_progress_does_not_swallow_business_refusals(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'test-worker', {})
        for code in ('SUPABASE_400:VIDEO_IN_TRASH', 'SUPABASE_400:OUTPUT_RECEIPT_CONFLICT',
                     'SUPABASE_400:NEW_BUSINESS_REFUSAL', 'NEW_BUSINESS_REFUSAL'):
            with self.subTest(code=code):
                lease = {'job': {'id': 'job', 'run_id': 'run'}, 'token': 'token'}
                detail = worker.json.dumps({'ok': False, 'error': code}).encode()
                errors = [worker.urllib.error.HTTPError(client.endpoint, 500, 'failed', {},
                          io.BytesIO(detail)) for _ in range(3)]
                for error in errors:
                    self.addCleanup(error.close)
                with patch.object(worker.urllib.request, 'urlopen', side_effect=errors) as request, \
                     patch.object(worker.time, 'sleep') as sleep:
                    with self.assertRaises(worker.ApiError):
                        worker.report_progress(client, lease, 'LOCAL_UPLOAD', 96, '上传')
                self.assertEqual(request.call_count, 1)
                sleep.assert_not_called()

    def test_wrapped_transient_status_retries_but_unknown_error_does_not(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'test-worker', {})
        for code, retry in [('SUPABASE_429:REQUEST_FAILED', True), ('SUPABASE_503:REQUEST_FAILED', True),
                            ('SUPABASE_400:REQUEST_FAILED', False), ('SUPABASE_503:NEW_BUSINESS_REFUSAL', False)]:
            with self.subTest(code=code):
                detail = worker.json.dumps({'ok': False, 'error': code}).encode()
                error = worker.urllib.error.HTTPError(client.endpoint, 500, 'failed', {}, io.BytesIO(detail))
                self.addCleanup(error.close)
                response = MagicMock()
                response.__enter__.return_value.read.return_value = b'{"ok":true}'
                with patch.object(worker.urllib.request, 'urlopen', side_effect=[error, response]) as request, \
                     patch.object(worker.time, 'sleep') as sleep:
                    if retry:
                        self.assertTrue(client.call('worker-output-receipt-v2')['ok'])
                    else:
                        with self.assertRaises(worker.ApiError):
                            client.call('worker-output-receipt-v2')
                self.assertEqual(request.call_count, 2 if retry else 1)
                self.assertEqual(sleep.call_count, 1 if retry else 0)

    def test_upload_retries_network_failure_without_changing_bytes(self):
        client = worker.EdgeClient('https://example.test', 'secret', 'test-worker', {})
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"ok":true}'
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'a.ts'
            source.write_bytes(b'video')
            with patch.object(worker.urllib.request, 'urlopen', side_effect=[TimeoutError(), response]) as request, \
                 patch.object(worker.time, 'sleep'):
                self.assertTrue(client.upload('https://example.test?job=1', 'token', 'job', '540p/a.ts', source)['ok'])
            self.assertEqual(request.call_args_list[0].args[0].data, request.call_args_list[1].args[0].data)

    def test_generic_retry_cannot_reprocess_media_maintenance_learning(self):
        lease = {'job': {'id': '00000000-0000-0000-0000-000000000001',
                        'input': {'kind': 'MEDIA_REENCODE'}}, 'token': 'fixture'}
        with tempfile.TemporaryDirectory() as folder, patch.object(worker, 'worker_root', return_value=Path(folder)), \
             patch.object(worker, 'heartbeat_loop'), patch.object(worker, 'report_failure') as failed, \
             patch.object(worker, 'download') as download, patch.object(worker, 'process_job') as pipeline:
            worker.process_lease(object(), lease)
            self.assertEqual(failed.call_args.args[2]['code'], 'MEDIA_REENCODE_OPERATOR_REQUIRED')
            self.assertFalse(failed.call_args.args[3])
            download.assert_not_called()
            pipeline.assert_not_called()

    def test_worker_reports_v5_protocol_version(self):
        self.assertEqual(worker.VERSION, '2.5.4')
        source = MODULE.read_text(encoding='utf-8')
        self.assertIn("'learningRepairV5': True", source)
        self.assertIn("'teachingSchemaVersion': 3", source)

    def test_upload_concurrency_is_bounded(self):
        with patch.dict('os.environ', {'EASTUDY_UPLOAD_CONCURRENCY': '99'}):
            self.assertEqual(worker.upload_concurrency(), 2)
        with patch.dict('os.environ', {'EASTUDY_UPLOAD_CONCURRENCY': 'invalid'}):
            self.assertEqual(worker.upload_concurrency(), 2)

    def test_parallel_upload_preserves_manifest_order_and_receipts(self):
        calls = []
        class Client:
            def upload(self, _url, _token, _job_id, path, source):
                return {'size': source.stat().st_size, 'sha256': worker.file_sha256(source), 'etag': path}
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
        self.assertLessEqual(sum(action == 'worker-telemetry-v2' for action, _ in calls), 2)

    def test_missing_receipt_never_returns_publishable_manifest(self):
        client = MagicMock()
        client.upload.return_value = {'size': 1, 'sha256': worker.hashlib.sha256(b'x').hexdigest(), 'etag': 'etag'}
        client.call.side_effect = worker.ApiError('EDGE_HTTP_503', status=503)
        lease = {'job': {'id': 'job', 'run_id': 'run'}, 'token': 'token', 'outputUrl': 'https://example.test'}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'a.ts'
            path.write_bytes(b'x')
            with self.assertRaises(worker.ApiError):
                worker.upload_assets(client, lease, Path(folder), [path])

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
        self.assertEqual(worker.content_type('voice/' + 'a' * 64 + '.mp3'), 'audio/mpeg')

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

    def test_download_reuse_requires_matching_digest_not_only_size(self):
        data = b'original-video'
        def response(body=b'', status=200):
            result = MagicMock()
            result.__enter__.return_value = result
            result.headers = {'Content-Length': str(len(data)), 'ETag': 'v1'}
            result.status = status
            result.read = io.BytesIO(body).read
            return result
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'source.mp4'
            with patch.object(worker.urllib.request, 'urlopen', side_effect=[response(), response(data)]) as request:
                worker.download('https://example.test/source', target)
            self.assertEqual(request.call_count, 2)
            receipt = json.loads(target.with_suffix('.mp4.source.json').read_text())
            self.assertEqual(receipt['contentHash'], worker.file_sha256(target))
            with patch.object(worker.urllib.request, 'urlopen', return_value=response()) as request:
                worker.download('https://example.test/source', target)
            self.assertEqual(request.call_count, 1)
            target.write_bytes(b'x' * len(data))
            with patch.object(worker.urllib.request, 'urlopen', side_effect=[response(), response(data)]) as request:
                worker.download('https://example.test/source', target)
            self.assertEqual(request.call_count, 2)
            self.assertEqual(target.read_bytes(), data)

    def test_legacy_receipt_and_complete_partial_are_not_trusted_as_valid_source(self):
        data = b'original-video'
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'source.mp4'
            target.write_bytes(b'x' * len(data))
            target.with_suffix('.mp4.part').write_bytes(b'x' * len(data))
            worker.atomic_json(target.with_suffix('.mp4.source.json'),
                {'version': 1, 'etag': 'v1', 'totalBytes': len(data)})
            response = MagicMock()
            response.__enter__.return_value = response
            response.headers = {'Content-Length': str(len(data)), 'ETag': 'v1'}
            response.status = 200
            response.read = io.BytesIO(data).read
            with patch.object(worker.urllib.request, 'urlopen', return_value=response) as request:
                worker.download('https://example.test/source', target)
            self.assertEqual(request.call_count, 2)
            self.assertIsNone(request.call_args.args[0].get_header('Range'))
            self.assertEqual(target.read_bytes(), data)

    def test_upload_pipeline_receives_run_bound_usage_and_cancel_event(self):
        lease = {'job': {'id': '00000000-0000-0000-0000-000000000001',
                        'video_id': 'video', 'run_id': '00000000-0000-0000-0000-000000000002', 'source_key': 'source.mp4'},
                 'downloadUrl': 'https://example.test/source', 'token': 'secret'}
        client = MagicMock()
        settings = MagicMock()
        settings.snapshot.return_value = {'baseUrl': 'https://new.example/v1', 'model': 'new-model',
                                          'apiKey': 'fixture-key', 'thinkingMode': 'auto', 'revision': 3,
                                          'detailReviewMode': 'delta'}
        def process(store, job_id, source, subtitles, config, output, base_url, execution):
            self.assertEqual(config['jobId'], job_id)
            self.assertEqual(config['runId'], lease['job']['run_id'])
            self.assertFalse(config['cancelled'].is_set())
            self.assertEqual(config['baseUrl'], 'https://new.example/v1')
            self.assertEqual(config['model'], 'new-model')
            self.assertEqual(config['apiKey'], 'fixture-key')
            self.assertEqual(config['thinkingMode'], 'auto')
            self.assertEqual(config['detailReviewMode'], 'full')
            settings.snapshot.return_value['model'] = 'later-model'
            self.assertEqual(config['model'], 'new-model')
            self.assertEqual(set(execution), {'cache_root', 'observe', 'voice', 'upload_media', 'upload_voice'})
            return {'status': 'REVIEW', 'result': {'video': {}, 'sentences': [], '_uploadedManifest': [],
                'evidence': {'aiUsage': worker.summarize_usage(config['usageLogPath'], config['runId'])}}}
        with tempfile.TemporaryDirectory() as folder, \
                patch.object(worker, 'worker_root', return_value=Path(folder)), \
                patch.object(worker, 'heartbeat_loop'), patch.object(worker, 'download',
                    side_effect=lambda url, path, *args: path.write_bytes(b'source')), \
                patch.object(worker, 'process_job', side_effect=process), \
                patch.object(worker, 'prepare_voice', return_value={'status': 'complete'}), \
                patch.object(worker, 'selected_assets', return_value=[]), \
                patch.object(worker, 'upload_assets', return_value=[]), \
                patch.object(worker, 'rewrite_result', side_effect=lambda result, *args: result):
            worker.process_lease(client, lease, ai_settings=settings)
        settings.snapshot.assert_called_once_with()
        completed = [c for c in client.call.call_args_list if c.args[0] == 'worker-complete-v2']
        self.assertEqual(len(completed), 1)
        self.assertTrue(completed[0].kwargs['result']['evidence']['aiUsage']['complete'])

    def test_worker_root_honors_dedicated_directory(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {'EASTUDY_WORK_ROOT': folder}):
            self.assertEqual(worker.worker_root(), Path(folder).resolve())

    def test_learning_repair_uploads_voice_before_commit_without_retranscoding(self):
        calls = []
        class Client:
            def call(self, action, **values):
                calls.append((action, values))
                return {'ok': True}
        lease = {'job': {'id': '00000000-0000-0000-0000-000000000001',
                         'video_id': 'video-one',
                         'run_id': '00000000-0000-0000-0000-000000000002',
                         'input': {'kind': 'LEARNING_REPAIR', 'sentences': [
                             {'id': '1-1', 'english': 'Good morning', 'chinese': '', 'keyWords': ['Good morning']}
                         ]}}, 'token': 'x' * 32}
        repaired = [{'id': '1-1', 'english': 'Good morning', 'chinese': '早上好',
                     'keyWords': ['Good morning'], 'expressions': [{'surface': 'Good morning',
                     'coreMeaningZh': '早上好', 'contextMeaningZh': '日常问候'}]}]
        with tempfile.TemporaryDirectory() as folder, \
             patch.dict('os.environ', {'EASTUDY_WORK_ROOT': folder}), \
             patch.object(worker, 'repair_learning', return_value=(repaired, [{'model': 'test'}])) as repair_mock, \
             patch.object(worker, 'complete_teaching', side_effect=lambda rows, *args: (rows, [])) as complete_mock, \
             patch.object(worker, 'download') as download_mock, \
             patch.object(worker, 'process_job') as process_mock, \
             patch.object(worker, 'prepare_voice', return_value={'status': 'complete'}) as voice_mock, \
             patch.object(worker, 'voice_assets', return_value=['voice.mp3']), \
             patch.object(worker, 'upload_assets', side_effect=lambda *args: calls.append(('upload-voice', {}))) as upload_mock:
            worker.process_lease(Client(), lease)
        download_mock.assert_not_called()
        process_mock.assert_not_called()
        upload_mock.assert_called_once()
        voice_mock.assert_called_once()
        self.assertEqual(calls[-1][0], 'worker-complete-learning-v5')
        self.assertEqual(calls[-2][0], 'upload-voice')
        self.assertEqual(calls[-1][1]['result']['sentences'], repaired)
        self.assertEqual(calls[-1][1]['result']['voiceManifest'], {'status': 'complete'})
        config = repair_mock.call_args.args[1]
        self.assertIs(config, complete_mock.call_args.args[1])
        self.assertEqual(config['runId'], lease['job']['run_id'])
        self.assertEqual(config['jobId'], lease['job']['id'])
        self.assertFalse(config['cancelled'].is_set())
        self.assertTrue(calls[-1][1]['result']['evidence']['aiUsage']['complete'])

    def test_incomplete_voice_cannot_upload_or_complete_repair(self):
        lease = {'job': {'id': '00000000-0000-0000-0000-000000000001', 'video_id': 'v',
            'run_id': '00000000-0000-0000-0000-000000000002', 'input': {'kind': 'LEARNING_REPAIR', 'sentences': [{'id': 's'}]}}, 'token': 'secret'}
        client = MagicMock()
        with tempfile.TemporaryDirectory() as folder, patch.object(worker, 'worker_root', return_value=Path(folder)), \
             patch.object(worker, 'heartbeat_loop'), patch.object(worker, 'repair_learning', return_value=([{}], [])), \
             patch.object(worker, 'complete_teaching', return_value=([{}], [])), \
             patch.object(worker, 'prepare_voice', side_effect=worker.ApiError('VOICE_GENERATION_INCOMPLETE')), \
             patch.object(worker, 'upload_assets') as upload:
            worker.process_lease(client, lease)
        upload.assert_not_called()
        self.assertFalse(any('complete' in call.args[0] for call in client.call.call_args_list))
        self.assertEqual(client.call.call_args_list[-1].kwargs['error']['code'], 'VOICE_GENERATION_INCOMPLETE')

    def test_unready_voice_worker_heartbeats_without_claiming(self):
        client = MagicMock()
        with patch('sys.argv', ['worker.py', '--once']), \
             patch.dict('os.environ', {'EASTUDY_WORKER_SECRET': 'test-secret'}), \
             patch.object(worker, 'configure_ai_environment'), \
             patch.object(worker, 'start_ai_settings'), \
             patch.object(worker, 'start_local_intake'), \
             patch.object(worker, 'start_intake'), \
             patch.object(worker, 'capabilities', return_value={'teachingVoiceV1': False}), \
             patch.object(worker, 'EdgeClient', return_value=client):
            self.assertEqual(worker.main(), 2)
        self.assertTrue(client.call.called)
        self.assertTrue(all(call.args[0] == 'worker-heartbeat' for call in client.call.call_args_list))


if __name__ == '__main__':
    unittest.main()
