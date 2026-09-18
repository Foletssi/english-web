import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
import worker
from checkpoint import file_sha256
from teaching_voice import collect_voice_items
from final_output import save_final_output, restore_final_output


class FinalOutputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / 'old' / 'output'
        self.output.mkdir(parents=True)
        self.source = self.root / 'source.mp4'
        self.source.write_bytes(b'source')
        self.asset = self.output / 'master.m3u8'
        self.asset.write_bytes(b'media')
        self.job = {'id': 'job', 'video_id': '123', 'source_key': 'source.mp4', 'input': {}}
        rows = [{'id': 's1', 'english': 'Go', 'textRevision': 1, 'expressions': [],
                 'wordLookup': {'sourceTextRevision': 1, 'sourceEnglish': 'Go', 'tokens': [
                     {'tokenId': 't0', 'surface': 'Go', 'coreMeaningZh': 'go meaning', 'pronunciationHint': '/go/'}]}}]
        items = collect_voice_items('123', 'old-run', rows)
        items[0].update(status='ready', storagePath='voice/test.mp3', ownerJobId='old-owner', url='old-url')
        self.result = {'video': {'status': 'REVIEW', 'voiceManifest': {'videoId': '123',
                       'contentRevision': 'old-run', 'status': 'complete', 'items': items}}, 'sentences': rows,
                       'evidence': {'humanReviewRequired': True}}
        self.manifest = [{'path': 'master.m3u8', 'size': self.asset.stat().st_size, 'sha256': file_sha256(self.asset)}]

    def save(self):
        save_final_output(self.root, self.job, self.source, None, self.output, self.result, self.manifest)

    def restore(self):
        return restore_final_output(self.root, self.job, self.source, None, 'new-run', lambda out, result: [self.asset])

    def test_missing_returns_none(self):
        self.assertIsNone(self.restore())

    def test_restores_and_rebinds_voice_without_changing_teaching(self):
        self.save()
        output, result = self.restore()
        self.assertEqual(output, self.output)
        self.assertEqual(result['sentences'], self.result['sentences'])
        voice = result['video']['voiceManifest']
        self.assertEqual(voice['contentRevision'], 'new-run')
        self.assertEqual(voice['items'][0]['contentRevision'], 'new-run')
        self.assertNotEqual(voice['items'][0]['itemId'], self.result['video']['voiceManifest']['items'][0]['itemId'])
        self.assertNotIn('ownerJobId', voice['items'][0])
        self.assertNotIn('url', voice['items'][0])
        self.assertEqual(result['video']['status'], 'REVIEW')

    def test_source_or_settings_change_fails_closed(self):
        self.save()
        self.source.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'FINAL_OUTPUT_IDENTITY_MISMATCH'):
            self.restore()

    def test_compact_generated_manifest_rebinds_without_duplicated_teaching(self):
        item = self.result['video']['voiceManifest']['items'][0]
        item.pop('meaning')
        item.pop('context')
        self.save()
        _, result = self.restore()
        rebound = result['video']['voiceManifest']['items'][0]
        self.assertEqual(rebound['contentRevision'], 'new-run')
        self.assertEqual(rebound['pronunciationHint'], '/go/')
        self.assertNotIn('meaning', rebound)
        self.assertNotIn('context', rebound)

    def test_settings_change_fails_closed(self):
        self.save()
        self.job['input']['title'] = 'changed'
        with self.assertRaisesRegex(ValueError, 'FINAL_OUTPUT_IDENTITY_MISMATCH'):
            self.restore()

    def test_corrupted_media_does_not_fall_back_to_generation(self):
        self.save()
        self.asset.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'FINAL_OUTPUT_ASSETS_MISMATCH'):
            self.restore()

    def test_invalid_json_fails_closed(self):
        (self.root / 'final-output.json').write_text('{', encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'FINAL_OUTPUT_CHECKPOINT_INVALID'):
            self.restore()

    def test_metadata_corruption_is_detected(self):
        self.save()
        target = self.root / 'final-output.json'
        data = json.loads(target.read_text(encoding='utf-8'))
        data['result']['sentences'][0]['english'] = 'Stop'
        target.write_text(json.dumps(data), encoding='utf-8')
        with self.assertRaisesRegex(ValueError, 'FINAL_OUTPUT_CHECKPOINT_INVALID'):
            self.restore()

    def test_stale_meaning_or_ipa_cannot_reuse_audio(self):
        for field in ('meaning', 'pronunciationHint', 'context'):
            with self.subTest(field=field):
                result = copy.deepcopy(self.result)
                result['video']['voiceManifest']['items'][0][field] = 'stale'
                save_final_output(self.root, self.job, self.source, None, self.output, result, self.manifest)
                with self.assertRaisesRegex(ValueError, 'FINAL_OUTPUT_VOICE_STALE'):
                    self.restore()

    def test_duplicate_voice_item_rejected(self):
        self.result['video']['voiceManifest']['items'] *= 2
        self.save()
        with self.assertRaisesRegex(ValueError, 'FINAL_OUTPUT_VOICE_STALE'):
            self.restore()

    def test_output_cannot_escape_job_root(self):
        with self.assertRaises(ValueError):
            save_final_output(self.root, self.job, self.source, None, self.root.parent, self.result, self.manifest)

    def exercise_lease(self, corrupt=False):
        self.job['progress'] = 97
        self.job['id'] = '11111111-1111-4111-8111-111111111111'
        self.job['run_id'] = '22222222-2222-4222-8222-222222222222'
        # The real saved checkpoint is restored; only external effects are mocked.
        job_root = self.root / self.job['id']
        output = job_root / 'old' / 'output'
        output.mkdir(parents=True)
        asset = output / 'master.m3u8'
        asset.write_bytes(b'media')
        save_final_output(job_root, self.job, self.source, None, output, self.result, self.manifest)
        if corrupt:
            asset.write_bytes(b'corrupt')
        client = MagicMock()
        lease = {'job': self.job, 'token': 'test-token'}
        with patch.object(worker, 'worker_root', return_value=self.root), \
             patch.object(worker, 'heartbeat_loop'), \
             patch.object(worker, 'resolve_input_source', return_value=(self.source, None)), \
             patch.object(worker, 'selected_assets', return_value=[asset]), \
             patch.object(worker, 'upload_assets', return_value=self.manifest) as upload, \
             patch.object(worker, 'process_job') as pipeline, \
             patch.object(worker, 'prepare_voice') as voice, \
             patch.object(worker, 'rewrite_result', side_effect=lambda value, *args: value), \
             patch.object(worker, 'report_failure') as failure:
            worker.process_lease(client, lease)
        pipeline.assert_not_called()
        voice.assert_not_called()
        completions = [call for call in client.call.call_args_list if call.args[0]=='worker-complete-v2']
        samples = [call.kwargs for call in client.call.call_args_list if call.args[0]=='worker-telemetry-v2']
        self.assertTrue(samples)
        self.assertTrue(all(sample['progress'] >= 97 for sample in samples))
        self.assertEqual(samples[0]['metrics']['resumePosition']['phase'], 'validating')
        self.assertFalse(samples[0]['metrics']['resumePosition']['verified'])
        self.assertEqual(samples[-1]['metrics']['resumePosition']['verified'], not corrupt)
        if not corrupt:
            self.assertEqual(samples[-1]['metrics']['resumePosition']['phase'], 'final')
        if corrupt:
            upload.assert_not_called()
            self.assertEqual(completions, [])
            failure.assert_called_once()
            self.assertIn('FINAL_OUTPUT_ASSETS_MISMATCH', failure.call_args.args[2]['message'])
        else:
            failure.assert_not_called()
            upload.assert_called_once()
            self.assertEqual(len(completions), 1)
            result = completions[0].kwargs['result']
            self.assertEqual(result['video']['status'], 'REVIEW')
            self.assertEqual(result['sentences'], self.result['sentences'])
            self.assertEqual(result['video']['voiceManifest']['contentRevision'], self.job['run_id'])

    def test_process_lease_resumes_without_pipeline_or_voice_generation(self):
        self.exercise_lease()

    def test_process_lease_corrupt_checkpoint_stops_without_ai_or_upload(self):
        self.exercise_lease(corrupt=True)

    def exercise_pipeline_lease(self, previous_progress):
        self.job.update(id='11111111-1111-4111-8111-111111111111',
                        run_id='22222222-2222-4222-8222-222222222222',
                        progress=previous_progress)
        job_root = self.root / self.job['id']
        cache_root = job_root / 'artifacts'
        cache_root.mkdir(parents=True)
        marker = cache_root / 'existing-stage'
        marker.write_bytes(b'preserve cached work')
        output = job_root / self.job['run_id'] / 'output' / self.job['id']
        output.mkdir(parents=True)
        asset = output / 'master.m3u8'
        asset.write_bytes(b'media')
        result = copy.deepcopy(self.result)
        result['_uploadedManifest'] = self.manifest

        def pipeline(*args, **kwargs):
            execution = kwargs['execution']
            self.assertEqual(execution['cache_root'], cache_root)
            self.assertEqual(marker.read_bytes(), b'preserve cached work')
            execution['observe']('media', {'state': 'DONE'})
            execution['observe']('teaching', {'state': 'RUNNING'})
            return {'status': 'REVIEW', 'result': result}

        client = MagicMock()
        lease = {'job': self.job, 'token': 'test-token'}
        with patch.object(worker, 'worker_root', return_value=self.root), \
             patch.object(worker, 'heartbeat_loop'), \
             patch.object(worker, 'resolve_input_source', return_value=(self.source, None)), \
             patch.object(worker, 'selected_assets', return_value=[asset]), \
             patch.object(worker, 'process_job', side_effect=pipeline) as process, \
             patch.object(worker, 'rewrite_result', side_effect=lambda value, *args: value), \
             patch.object(worker, 'report_failure') as failure:
            worker.process_lease(client, lease)
        failure.assert_not_called()
        process.assert_called_once()
        self.assertTrue((job_root / 'final-output.json').is_file())
        completions = [c for c in client.call.call_args_list if c.args[0] == 'worker-complete-v2']
        self.assertEqual(len(completions), 1)
        self.assertEqual(completions[0].kwargs['result']['sentences'], self.result['sentences'])
        samples = [c.kwargs for c in client.call.call_args_list if c.args[0] == 'worker-telemetry-v2']
        self.assertGreaterEqual(len(samples), 3)
        if previous_progress:
            self.assertTrue(all(s['progress'] >= previous_progress for s in samples))
            self.assertEqual(samples[0]['metrics']['resumePosition']['phase'], 'validating')
            self.assertEqual(samples[-1]['metrics']['resumePosition']['phase'], 'stages')
            self.assertFalse(samples[-1]['metrics']['resumePosition']['verified'])
        else:
            self.assertNotIn('_resume', lease)
            self.assertTrue(all('resumePosition' not in s['metrics'] for s in samples))

    def test_fresh_job_does_not_claim_to_resume(self):
        self.exercise_pipeline_lease(0)

    def test_stage_only_resume_preserves_progress_and_shared_cache(self):
        self.exercise_pipeline_lease(71)


if __name__ == '__main__':
    unittest.main()
