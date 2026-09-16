import tempfile
import unittest
import contextlib
import io
import json
from pathlib import Path
from unittest.mock import patch

from contracts import StudioError
from teaching_voice import collect_voice_items, generate_voice_manifest, pronunciation_input, main


def row(identity='s1', text='read', hint='present tense /riːd/', meaning='阅读'):
    return {'id': identity, 'english': text, 'textRevision': 1,
        'wordLookup': {'sourceEnglish': text, 'sourceTextRevision': 1,
            'tokens': [{'tokenId': 't0', 'surface': text, 'coreMeaningZh': meaning,
                        'pronunciationHint': hint}]}, 'expressions': []}


class VoiceTests(unittest.TestCase):
    def test_contextual_read_uses_explicit_phonemes(self):
        present = collect_voice_items('1', '2', [row()])[0]
        past = collect_voice_items('1', '2', [row(hint='past tense /red/')])[0]
        self.assertEqual(pronunciation_input(present), ('ɹiːd', True))
        self.assertEqual(pronunciation_input(past), ('ɹɛd', True))
        with self.assertRaises(StudioError):
            pronunciation_input({**present, 'pronunciationHint': ''})

    def test_stale_source_and_duplicate_identity_rejected(self):
        stale = row()
        stale['textRevision'] = 2
        with self.assertRaises(StudioError):
            collect_voice_items('1', '2', [stale])
        with self.assertRaises(StudioError):
            collect_voice_items('1', '2', [row(), row()])

    def test_cli_keeps_failures_structured_and_persists_incomplete_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            request_path = Path(temporary) / 'request.json'
            output_path = Path(temporary) / 'manifest.json'
            request_path.write_text(json.dumps({'videoId': 'v', 'contentRevision': '1', 'rows': []}))
            args = ['--request', str(request_path), '--output-dir', temporary, '--manifest', str(output_path)]
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout), patch('teaching_voice.generate_voice_manifest',
                    side_effect=RuntimeError('secret /private/local/path')):
                self.assertEqual(main(args), 1)
            self.assertEqual(json.loads(stdout.getvalue()), {'status': 'failed', 'errorCode': 'VOICE_RUNTIME_FAILED'})
            manifest = {'status': 'incomplete', 'ready': 0, 'total': 1, 'uniqueFiles': 0, 'elapsedSeconds': .2,
                        'items': [{'status': 'failed', 'errorCode': 'VOICE_GENERATION_FAILED'}]}
            with contextlib.redirect_stdout(io.StringIO()), patch('teaching_voice.generate_voice_manifest', return_value=manifest):
                self.assertEqual(main(args), 2)
            self.assertEqual(json.loads(output_path.read_text()), manifest)

    def test_retry_dedup_and_context_isolation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model, voices = root / 'model', root / 'voices'
            model.write_bytes(b'model')
            voices.write_bytes(b'voices')
            rows = [row('s1'), row('s2'), row('s3', hint='past tense /red/', meaning='读过')]
            attempts = []
            def synth(engine, item, path, voice, language):
                attempts.append(item['sentenceId'])
                if len(attempts) == 1:
                    raise RuntimeError('transient')
                return {'duration': .5, 'bytes': 4000, 'contentHash': 'a' * 64}
            with patch('teaching_voice._synthesize', side_effect=synth):
                result = generate_voice_manifest('v1', 'r1', rows, root,
                    {'modelPath': str(model), 'voicesPath': str(voices)}, engine=object())
            self.assertEqual(attempts, ['s1', 's1', 's3'])
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(result['uniqueFiles'], 2)
            self.assertEqual(result['items'][0]['storagePath'], result['items'][1]['storagePath'])
            self.assertNotEqual(result['items'][0]['storagePath'], result['items'][2]['storagePath'])
            self.assertNotEqual(result['items'][0]['itemId'], result['items'][1]['itemId'])
            with patch('teaching_voice._synthesize', side_effect=RuntimeError('persistent')) as synth:
                failed = generate_voice_manifest('v1', 'r1', [row()], root,
                    {'modelPath': str(model), 'voicesPath': str(voices)}, engine=object())
            self.assertEqual(synth.call_count, 3)
            self.assertEqual(failed['status'], 'incomplete')
            self.assertNotIn('storagePath', failed['items'][0])


if __name__ == '__main__':
    unittest.main()
