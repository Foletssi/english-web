"""Bounded voice batches must retain the same durable receipt guarantees as PUT."""
import base64
import copy
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

import worker


def receipt(relative, path):
    return {'ok': True, 'path': relative, 'size': path.stat().st_size,
            'sha256': worker.file_sha256(path), 'etag': 'etag-' + relative}


class RecordingClient:
    def __init__(self):
        self.batches, self.singles, self.registered, self.actions = [], [], [], []
        self.fail_registration = False
        self.alter = lambda rows: rows
        self.cancel_after_upload = None

    def upload(self, url, token, job_id, relative, path):
        self.singles.append((relative, path))
        return receipt(relative, path)

    def upload_batch(self, url, items):
        self.batches.append(list(items))
        rows = self.alter([receipt(relative, path) for relative, path in items])
        if self.cancel_after_upload:
            self.cancel_after_upload.set()
        return rows

    def call(self, action, **values):
        self.actions.append(action)
        if action == 'worker-output-receipts-v3':
            if self.fail_registration:
                raise worker.ApiError('OUTPUT_RECEIPT_REGISTER_FAILED')
            self.registered.extend({'jobId': values['jobId'], 'runId': values['runId'], **item}
                                   for item in values['receipts'])
            return {'ok': True}
        if action == 'worker-output-receipt-v2':
            if self.fail_registration:
                raise worker.ApiError('OUTPUT_RECEIPT_REGISTER_FAILED')
            self.registered.append(values)
        return {'ok': True}


class UploadBatchTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.output = Path(temp.name)
        self.url = 'https://example.test/api/processing/output?job=job&run=run&token=fixture'
        self.lease = {'job': {'id': 'job', 'run_id': 'run'},
                      'token': 'fixture', 'outputUrl': self.url}
        self.client = RecordingClient()

    def make_file(self, name, data=b'audio'):
        path = self.output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def voices(self, count, size=5):
        return [self.make_file('voice/' + f'{number:064x}' + '.mp3', bytes([number + 1]) * size)
                for number in range(count)]

    def test_edge_batch_uses_one_post_with_canonical_base64_and_exact_receipts(self):
        paths = self.voices(4)
        items = [(path.relative_to(self.output).as_posix(), path) for path in paths]
        rows = [receipt(*item) for item in items]
        client = worker.EdgeClient('https://example.test', 'secret', 'worker', {})
        with patch.object(worker, 'request_json', return_value={'ok': True, 'results': rows}) as request:
            actual = client.upload_batch(self.url, items)
        self.assertEqual(actual, rows)
        self.assertEqual(request.call_count, 1)
        sent = request.call_args.args[0]
        self.assertEqual(sent.method, 'POST')
        self.assertEqual(sent.full_url, self.url)
        self.assertEqual(sent.get_header('Content-type'), 'application/json')
        envelope = json.loads(sent.data)
        self.assertEqual(len(envelope['items']), 4)
        for item, (relative, path) in zip(envelope['items'], items):
            self.assertEqual(item, {'path': relative, 'size': path.stat().st_size,
                'sha256': worker.file_sha256(path),
                'data': base64.b64encode(path.read_bytes()).decode('ascii')})

    def test_edge_rejects_oversized_or_ineligible_batches_before_network(self):
        paths = self.voices(33)
        items = [(path.relative_to(self.output).as_posix(), path) for path in paths]
        large = self.make_file('voice/' + 'e' * 64 + '.mp3', b'x' * (1024 * 1024 + 1))
        heavy = [self.make_file('voice/' + f'{number + 10:064x}' + '.mp3', b'x' * (800 * 1024))
                 for number in range(3)]
        cases = [[], items, [items[0], items[0]], [('original.mp4', paths[0])],
                 [(large.relative_to(self.output).as_posix(), large)],
                 [(path.relative_to(self.output).as_posix(), path) for path in heavy]]
        for case in cases:
            with self.subTest(paths=[name for name, _ in case]), patch.object(worker, 'request_json') as request:
                client = worker.EdgeClient('https://example.test', 'secret', 'worker', {})
                with self.assertRaises(worker.ApiError):
                    client.upload_batch(self.url, case)
                request.assert_not_called()

    def test_edge_rejects_mismatched_or_missing_receipts(self):
        items = [(path.relative_to(self.output).as_posix(), path) for path in self.voices(2)]
        expected = [receipt(*item) for item in items]
        malformed = [[], expected[:1], [expected[0], expected[0]]]
        for key, value in [('sha256', '0' * 64), ('size', 123), ('path', []), ('path', {}), ('path', 'voice/' + 'f' * 64 + '.mp3')]:
            changed = copy.deepcopy(expected)
            changed[0][key] = value
            malformed.append(changed)
        for rows in malformed:
            with self.subTest(rows=rows), patch.object(worker, 'request_json',
                    return_value={'ok': True, 'results': rows}), patch.object(worker.time, 'sleep'):
                client = worker.EdgeClient('https://example.test', 'secret', 'worker', {})
                with self.assertRaises(worker.ApiError):
                    client.upload_batch(self.url, items)

    def test_voice_files_use_one_bounded_batch_and_manifest_is_sorted(self):
        paths = self.voices(5)
        normal = self.make_file('540p/00001.ts', b'video')
        self.make_file('original.mp4', b'never-upload-this')
        with patch.object(worker, 'report_progress') as progress:
            manifest = worker.upload_assets(self.client, self.lease, self.output, [normal, *reversed(paths)])
        self.assertEqual([len(batch) for batch in self.client.batches], [5])
        self.assertTrue(all(1 <= len(batch) <= 32 for batch in self.client.batches))
        sent = [item for batch in self.client.batches for item in batch] + self.client.singles
        self.assertCountEqual([relative for relative, _ in sent],
                              [path.relative_to(self.output).as_posix() for path in [normal, *paths]])
        self.assertIn(('540p/00001.ts', normal), self.client.singles)
        self.assertTrue(all(relative.startswith('voice/') for batch in self.client.batches for relative, _ in batch))
        self.assertEqual([item['path'] for item in manifest], sorted(item['path'] for item in manifest))
        self.assertEqual(len(self.client.registered), 6)
        self.assertEqual(self.client.actions.count('worker-output-receipts-v3'), 1)
        self.assertEqual(self.client.actions.count('worker-output-receipt-v2'), 1)
        metrics = progress.call_args.args[-1]
        self.assertEqual(metrics['uploadedBytes'], sum(path.stat().st_size for path in [normal, *paths]))
        self.assertEqual(metrics['totalBytes'], metrics['uploadedBytes'])
        self.assertIn('networkQueueSeconds', metrics)
        for item in manifest:
            registration = next(value for value in self.client.registered if value['path'] == item['path'])
            self.assertEqual(registration['sha256'], item['sha256'])
            self.assertEqual(registration['size'], item['size'])
            self.assertEqual(registration['runId'], 'run')
            self.assertEqual(registration['etag'], 'etag-' + item['path'])

    def test_batches_respect_decoded_size_and_large_audio_keeps_single_upload(self):
        small = self.voices(4, 700 * 1024)
        large = self.make_file('voice/' + 'f' * 64 + '.mp3', b'x' * (1024 * 1024 + 1))
        worker.upload_assets(self.client, self.lease, self.output, [*small, large])
        self.assertTrue(self.client.batches)
        for batch in self.client.batches:
            self.assertLessEqual(sum(path.stat().st_size for _, path in batch), 2 * 1024 * 1024)
            self.assertTrue(all(path.stat().st_size <= 1024 * 1024 for _, path in batch))
        self.assertIn((large.relative_to(self.output).as_posix(), large), self.client.singles)

    def test_legacy_run_and_noncanonical_voice_names_never_enter_batch(self):
        voices = self.voices(2)
        old_lease = copy.deepcopy(self.lease)
        old_lease['job'].pop('run_id')
        worker.upload_assets(self.client, old_lease, self.output, voices)
        self.assertFalse(self.client.batches)
        self.client = RecordingClient()
        unusual = [self.make_file('voice/legacy.mp3'), self.make_file('voice/' + 'A' * 64 + '.mp3')]
        worker.upload_assets(self.client, self.lease, self.output, unusual)
        self.assertFalse(self.client.batches)
        self.assertEqual(len(self.client.singles), 2)

    def test_registration_failure_does_not_write_success_checkpoint(self):
        paths = self.voices(4)
        self.client.fail_registration = True
        with self.assertRaises(worker.ApiError):
            worker.upload_assets(self.client, self.lease, self.output, paths)
        self.assertTrue(self.client.batches)
        self.assertEqual(list((self.output / '_upload_receipts').glob('*.json')), [])

    def test_cancelled_batch_cannot_register_or_return_manifest(self):
        paths = self.voices(4)
        cancelled = threading.Event()
        self.client.cancel_after_upload = cancelled
        with self.assertRaisesRegex(worker.ApiError, 'JOB_LEASE_LOST_OR_CANCELLED'):
            worker.upload_assets(self.client, self.lease, self.output, paths, cancelled)
        self.assertFalse(self.client.registered)
        self.assertEqual(list((self.output / '_upload_receipts').glob('*.json')), [])

    def test_worker_does_not_accept_bad_hash_from_batch_transport(self):
        paths = self.voices(4)
        def corrupt(rows):
            for row in rows:
                row['sha256'] = 'f' * 64
            return rows
        self.client.alter = corrupt
        with self.assertRaises(worker.ApiError):
            worker.upload_assets(self.client, self.lease, self.output, paths)
        self.assertFalse(self.client.registered)
        self.assertEqual(list((self.output / '_upload_receipts').glob('*.json')), [])


if __name__ == '__main__':
    unittest.main()
