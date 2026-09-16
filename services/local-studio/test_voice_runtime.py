import hashlib
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock, patch

from contracts import StudioError
from voice_runtime import generate_worker_voice, voice_assets, voice_capability


class VoiceRuntimeTests(unittest.TestCase):
    def test_assets_reject_traversal_mismatched_hash_and_duplicates_are_one_upload(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            relative = 'voice/' + 'a' * 64 + '.mp3'
            path = root / relative
            path.parent.mkdir()
            path.write_bytes(b'a' * 600)
            item = {'status': 'ready', 'storagePath': relative, 'fingerprint': 'a' * 64,
                    'bytes': 600, 'contentHash': hashlib.sha256(b'a' * 600).hexdigest()}
            manifest = {'status': 'complete', 'total': 2, 'ready': 2, 'items': [item, dict(item)]}
            self.assertEqual(voice_assets(root, manifest), [path])
            for changed in ({'storagePath': '../voice.mp3'}, {'contentHash': 'b' * 64}, {'status': 'failed'}):
                with self.assertRaises(StudioError):
                    voice_assets(root, {**manifest, 'items': [{**item, **changed}, item]})

    def test_cancel_before_start_does_not_spawn(self):
        with tempfile.TemporaryDirectory() as folder, patch('voice_runtime.runtime_paths', return_value=(Path('python'), {})), \
             patch('voice_runtime.subprocess.Popen') as spawn:
            cancelled = threading.Event()
            cancelled.set()
            with self.assertRaises(StudioError) as raised:
                generate_worker_voice('v', 'r', [], folder, cancelled)
            self.assertEqual(raised.exception.code, 'JOB_LEASE_LOST_OR_CANCELLED')
            spawn.assert_not_called()

    def test_timeout_terminates_hidden_subprocess(self):
        process = MagicMock(stdout=io.StringIO(''), stderr=io.StringIO(''))
        process.poll.return_value = None
        with tempfile.TemporaryDirectory() as folder, patch('voice_runtime.runtime_paths', return_value=(Path('python'), {})), \
             patch('voice_runtime.subprocess.Popen', return_value=process) as spawn:
            with self.assertRaises(StudioError) as raised:
                generate_worker_voice('v', 'r', [], folder, timeout=-1)
            self.assertEqual(raised.exception.code, 'VOICE_GENERATION_TIMEOUT')
            process.terminate.assert_called_once()
            self.assertNotIn('shell', spawn.call_args.kwargs)
            self.assertIn('creationflags', spawn.call_args.kwargs)

    def test_capability_never_claims_readiness_after_inference_error(self):
        with patch('voice_runtime.generate_worker_voice', side_effect=RuntimeError('local details')):
            self.assertEqual(voice_capability(Path('unused')), {'inferenceReady': False, 'errorCode': 'VOICE_RUNTIME_FAILED'})

    def test_child_failure_preserves_only_safe_error_codes(self):
        for supplied, expected in [('VOICE_MODEL_MISSING', 'VOICE_MODEL_MISSING'),
                                   ('private local path or API response', 'VOICE_GENERATION_INCOMPLETE')]:
            process = MagicMock(stdout=io.StringIO(json.dumps({'status': 'failed', 'errorCode': supplied}) + '\n'),
                                stderr=io.StringIO(''), returncode=2)
            process.poll.return_value = 2
            with tempfile.TemporaryDirectory() as folder, patch('voice_runtime.runtime_paths', return_value=(Path('python'), {})), \
                 patch('voice_runtime.subprocess.Popen', return_value=process):
                with self.assertRaises(StudioError) as raised:
                    generate_worker_voice('v', 'r', [], folder)
                self.assertEqual(raised.exception.code, expected)

    def test_child_manifest_rejects_duplicate_source_items(self):
        process = MagicMock(stdout=io.StringIO(''), stderr=io.StringIO(''), returncode=0)
        process.poll.return_value = 0
        with tempfile.TemporaryDirectory() as folder, patch('voice_runtime.runtime_paths', return_value=(Path('python'), {})), \
             patch('voice_runtime.subprocess.Popen', return_value=process), \
             patch('voice_runtime.collect_voice_items', return_value=[{'itemId': 'one'}]), \
             patch('voice_runtime.voice_assets') as assets:
            (Path(folder) / 'voice-manifest.json').write_text(json.dumps({'videoId': 'v', 'contentRevision': 'r',
                'items': [{'itemId': 'one'}, {'itemId': 'one'}]}), encoding='utf-8')
            with self.assertRaises(StudioError) as raised:
                generate_worker_voice('v', 'r', [], folder)
            self.assertEqual(raised.exception.code, 'VOICE_SOURCE_STALE')
            assets.assert_not_called()


if __name__ == '__main__':
    unittest.main()
