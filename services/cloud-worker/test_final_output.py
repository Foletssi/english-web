import copy
import json
from pathlib import Path
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()
