import copy
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import worker
from teaching_voice import collect_voice_items


class FinalOutputRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lease = {'job': {'id': '00000000-0000-0000-0000-000000000001',
            'video_id': '123', 'run_id': '00000000-0000-0000-0000-000000000002',
            'source_key': 'source.mp4'}, 'downloadUrl': 'https://example.test/source', 'token': 'fixture'}
        self.client = MagicMock()
        self.rows = [{'id': 's1', 'english': 'Go', 'textRevision': 1, 'expressions': [],
            'wordLookup': {'sourceTextRevision': 1, 'sourceEnglish': 'Go', 'tokens': [
                {'tokenId': 't0', 'surface': 'Go', 'coreMeaningZh': 'go meaning', 'pronunciationHint': '/go/'}]}}]
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        for name, kwargs in (
            ('worker_root', {'return_value': self.root}), ('heartbeat_loop', {}),
            ('download', {'side_effect': lambda url, path, *args: path.write_bytes(b'source')}),
            ('selected_assets', {'side_effect': lambda output, result: [output / 'master.m3u8']}),
            ('rewrite_result', {'side_effect': lambda result, *args: result}),
        ):
            self.stack.enter_context(patch.object(worker, name, **kwargs))
        self.pipeline = self.stack.enter_context(patch.object(worker, 'process_job', side_effect=self.generate))
        self.voice = self.stack.enter_context(patch.object(worker, 'prepare_voice'))
        self.upload = self.stack.enter_context(patch.object(worker, 'upload_assets', side_effect=self.upload_existing))

    def generate(self, store, job_id, source, cover, config, output_root, base_url, execution):
        output = output_root / job_id
        output.mkdir(parents=True)
        (output / 'master.m3u8').write_bytes(b'media')
        items = collect_voice_items('123', config['runId'], self.rows)
        items[0].update(status='ready', storagePath='voice/test.mp3', ownerJobId=job_id)
        self.result = {'video': {'status': 'REVIEW', 'voiceManifest': {'videoId': '123',
            'contentRevision': config['runId'], 'status': 'complete', 'items': items}},
            'sentences': copy.deepcopy(self.rows), 'evidence': {'humanReviewRequired': True}}
        return {'status': 'REVIEW', 'result': {**copy.deepcopy(self.result),
            '_uploadedManifest': self.upload_existing(None, None, output, [output / 'master.m3u8'], None)}}

    def upload_existing(self, client, lease, output, assets, cancelled):
        return [{'path': p.relative_to(output).as_posix(), 'size': p.stat().st_size,
                 'sha256': worker.file_sha256(p)} for p in assets]

    def fail_first_commit(self):
        def call(action, **kwargs):
            if action == 'worker-complete-v2':
                raise worker.ApiError('SUPABASE_400:VOICE_SOURCE_STALE')
            return {'ok': True}
        self.client.call.side_effect = call
        worker.process_lease(self.client, self.lease)
        self.checkpoint = self.root / self.lease['job']['id'] / 'final-output.json'
        self.assertTrue(self.checkpoint.is_file())
        self.client.reset_mock()
        self.client.call.side_effect = None
        self.client.call.return_value = {"validation": {"valid": True}}
        self.pipeline.reset_mock()
        self.retry = {key: copy.deepcopy(self.lease[key])
                      for key in ('job', 'downloadUrl', 'token')}
        self.retry['job']['run_id'] = '00000000-0000-0000-0000-000000000003'

    def test_failed_commit_reuses_exact_teaching_and_audio_on_next_lease(self):
        self.fail_first_commit()
        worker.process_lease(self.client, self.retry)
        self.pipeline.assert_not_called()
        self.voice.assert_not_called()
        self.upload.assert_called_once()
        self.assertEqual(self.upload.call_args.args[1]['job']['run_id'], self.retry['job']['run_id'])
        calls = [c for c in self.client.call.call_args_list if c.args[0] == 'worker-complete-v2']
        self.assertEqual(len(calls), 1)
        result = calls[0].kwargs['result']
        self.assertEqual(calls[0].kwargs['runId'], self.retry['job']['run_id'])
        self.assertEqual(result['sentences'], self.rows)
        self.assertEqual(result['video']['status'], 'REVIEW')
        self.assertTrue(result['evidence']['humanReviewRequired'])
        voice = result['video']['voiceManifest']
        self.assertEqual(voice['contentRevision'], self.retry['job']['run_id'])
        self.assertEqual(voice['items'][0]['storagePath'], 'voice/test.mp3')
        self.assertNotEqual(voice['items'][0]['itemId'], self.result['video']['voiceManifest']['items'][0]['itemId'])

    def test_corrupt_checkpoint_stops_without_generation_upload_or_commit(self):
        self.fail_first_commit()
        self.checkpoint.write_text('{', encoding='utf-8')
        worker.process_lease(self.client, self.retry)
        self.pipeline.assert_not_called()
        self.voice.assert_not_called()
        self.upload.assert_not_called()
        self.assertFalse(any('complete' in c.args[0] for c in self.client.call.call_args_list))
        self.assertIn('FINAL_OUTPUT_CHECKPOINT_INVALID', str(self.client.call.call_args_list))

    def test_cancellation_during_recovery_upload_prevents_commit(self):
        self.fail_first_commit()
        def cancel(client, lease, output, assets, cancelled):
            cancelled.set()
            return self.upload_existing(client, lease, output, assets, cancelled)
        self.upload.side_effect = cancel
        worker.process_lease(self.client, self.retry)
        self.pipeline.assert_not_called()
        self.voice.assert_not_called()
        self.assertFalse(any('complete' in c.args[0] for c in self.client.call.call_args_list))


if __name__ == '__main__':
    unittest.main()
