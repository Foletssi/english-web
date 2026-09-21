import tempfile
import unittest
import contextlib
import io
import json
from pathlib import Path
from unittest.mock import patch

from contracts import StudioError
from teaching_voice import (collect_voice_items, generate_voice_manifest, pronunciation_input,
                            main, _hash, file_hash, LEGACY_VOICE_VERSION, PACKAGE_VERSION)
from voice_runtime import voice_assets


def row(identity='s1', text='read', hint='present tense /riːd/', meaning='阅读'):
    return {'id': identity, 'english': text, 'textRevision': 1,
        'wordLookup': {'sourceEnglish': text, 'sourceTextRevision': 1,
            'tokens': [{'tokenId': 't0', 'surface': text, 'coreMeaningZh': meaning,
                        'pronunciationHint': hint}]}, 'expressions': []}


class VoiceTests(unittest.TestCase):
    def test_cross_sentence_and_video_cache_preserves_item_bindings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model, voices = root / 'model', root / 'voices'
            model.write_bytes(b'model')
            voices.write_bytes(b'voices')
            config = {'modelPath': str(model), 'voicesPath': str(voices),
                      'cacheDirectory': str(root / 'cache')}
            def synth(engine, item, path, voice, language):
                path.write_bytes(pronunciation_input(item)[0].encode() * 600)
                return {'duration': .5, 'bytes': path.stat().st_size,
                        'contentHash': file_hash(path), 'contentType': 'audio/mpeg'}
            second = row('s2', meaning='朗读')
            second['english'] = second['wordLookup']['sourceEnglish'] = 'I read books.'
            rows = [row(), second, row('s3', hint='/red/', meaning='读过')]
            events = []
            with patch('teaching_voice._synthesize', side_effect=synth) as generate:
                first = generate_voice_manifest('v1', '1', rows, root / 'job1', config,
                    engine=object(), progress_details=events.append)
                with patch('teaching_voice._load_engine') as load:
                    other = generate_voice_manifest('v2', '2', rows, root / 'job2', config)
                    load.assert_not_called()
            self.assertEqual(generate.call_count, 2)
            self.assertEqual((first['total'], first['uniqueTotal'], first['generated'], first['reused']), (3, 2, 2, 1))
            self.assertEqual((other['generated'], other['reused']), (0, 3))
            self.assertEqual(events[-1]['uniqueReady'], 2)
            self.assertEqual(len(voice_assets(root / 'job1', first)), 2)
            self.assertEqual(len(voice_assets(root / 'job2', other)), 2)
            self.assertNotEqual(first['items'][0]['itemId'], other['items'][0]['itemId'])
            self.assertEqual(first['items'][0]['fingerprint'], other['items'][0]['fingerprint'])
            # Job assets are copies, so deleting/replacing one cannot damage another.
            (root / 'job1' / first['items'][0]['storagePath']).unlink()
            self.assertEqual(len(voice_assets(root / 'job2', other)), 2)
            cache_file = root / 'cache' / (first['items'][0]['fingerprint'] + '.mp3')
            cache_file.write_bytes(b'corrupt')
            with patch('teaching_voice._synthesize', side_effect=synth) as generate:
                repaired = generate_voice_manifest('v3', '3', rows, root / 'job3', config, engine=object())
            self.assertEqual(generate.call_count, 1)
            self.assertEqual(repaired['status'], 'complete')
            voices.write_bytes(b'changed voice model')
            with patch('teaching_voice._synthesize', side_effect=synth) as generate:
                generate_voice_manifest('v4', '4', rows, root / 'job4', config, engine=object())
            self.assertEqual(generate.call_count, 2)

    def test_reuses_valid_legacy_file_even_when_later_occurrence_owned_it(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model, voices = root / 'model', root / 'voices'
            model.write_bytes(b'model')
            voices.write_bytes(b'voices')
            rows = [row(), row('s2', meaning='朗读')]
            item = collect_voice_items('v', '1', rows)[1]
            old = _hash({'text': item['text'], 'hint': item['pronunciationHint'],
                'meaning': item['meaning'], 'context': item['context'],
                'revision': LEGACY_VOICE_VERSION, 'packageVersion': PACKAGE_VERSION,
                'modelHash': file_hash(model), 'voicesHash': file_hash(voices),
                'voice': 'af_heart', 'language': 'en-us'})
            (root / 'voice').mkdir()
            audio = root / 'voice' / f'{old}.mp3'
            audio.write_bytes(b'a' * 600)
            metadata = {'duration': .5, 'bytes': 600, 'contentHash': file_hash(audio), 'contentType': 'audio/mpeg'}
            with patch('teaching_voice.validate_audio', return_value=metadata), patch('teaching_voice._synthesize') as synth:
                result = generate_voice_manifest('v', '1', rows, root,
                    {'modelPath': str(model), 'voicesPath': str(voices)}, engine=object())
            synth.assert_not_called()
            self.assertEqual((result['generated'], result['reused']), (0, 2))
            self.assertEqual(len(voice_assets(root, result)), 1)
            (root / result['items'][0]['storagePath']).unlink()
            with patch('teaching_voice.validate_audio', return_value=metadata), \
                 patch('teaching_voice.copy_audio', side_effect=OSError('copy failed')), \
                 patch('teaching_voice._synthesize', side_effect=RuntimeError('synthesis failed')) as synth:
                failed = generate_voice_manifest('v', '1', rows, root,
                    {'modelPath': str(model), 'voicesPath': str(voices)}, engine=object())
            self.assertEqual(synth.call_count, 3)
            self.assertEqual(failed['status'], 'incomplete')
            self.assertEqual(failed['failed'], 2)
            self.assertNotIn('storagePath', failed['items'][0])

    def test_deterministic_invalid_pronunciation_is_not_retried_or_cached(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model, voices = root / 'model', root / 'voices'
            model.write_bytes(b'model')
            voices.write_bytes(b'voices')
            with patch('teaching_voice._synthesize') as synth:
                result = generate_voice_manifest('v', '1', [row(hint='')], root,
                    {'modelPath': str(model), 'voicesPath': str(voices)}, engine=object())
            synth.assert_not_called()
            self.assertEqual(result['status'], 'incomplete')
            self.assertEqual(result['failed'], 1)
            self.assertEqual(result['items'][0]['attempts'], 0)
            self.assertEqual(result['items'][0]['errorCode'], 'VOICE_CONTEXT_REQUIRED')

    def test_failed_input_retry_is_bounded_across_repeated_occurrences(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model, voices = root / 'model', root / 'voices'
            model.write_bytes(b'model')
            voices.write_bytes(b'voices')
            with patch('teaching_voice._synthesize', side_effect=RuntimeError('transient')) as synth:
                result = generate_voice_manifest('v', '1', [row(), row('s2')], root,
                    {'modelPath': str(model), 'voicesPath': str(voices)}, engine=object())
            self.assertEqual(synth.call_count, 3)
            self.assertEqual(result['failed'], 2)
            self.assertEqual(result['status'], 'incomplete')

    def test_engine_initialization_failure_is_not_repeated_per_input(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model, voices = root / 'model', root / 'voices'
            model.write_bytes(b'model')
            voices.write_bytes(b'voices')
            with patch('teaching_voice._load_engine', side_effect=RuntimeError('runtime unavailable')) as load, \
                 patch('teaching_voice._synthesize') as synth:
                result = generate_voice_manifest('v', '1', [row(), row('s2', text='speak', hint='/spiːk/')], root,
                    {'modelPath': str(model), 'voicesPath': str(voices)})
            self.assertEqual(load.call_count, 1)
            synth.assert_not_called()
            self.assertEqual((result['status'], result['failed']), ('incomplete', 2))

    def test_cache_write_failure_keeps_valid_assets_and_reports_warning(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            model, voices = root / 'model', root / 'voices'
            model.write_bytes(b'model')
            voices.write_bytes(b'voices')
            def synth(engine, item, path, voice, language):
                path.write_bytes(b'a' * 600)
                return {'duration': .5, 'bytes': 600, 'contentHash': file_hash(path),
                        'contentType': 'audio/mpeg'}
            with patch('teaching_voice._synthesize', side_effect=synth), \
                 patch('teaching_voice.store_audio', side_effect=PermissionError('readonly')):
                result = generate_voice_manifest('v', '1', [row(), row('s2')], root,
                    {'modelPath': str(model), 'voicesPath': str(voices)}, engine=object())
            self.assertEqual(result['cacheWriteFailures'], 1)
            self.assertEqual(result['status'], 'complete')
            self.assertEqual(len(voice_assets(root, result)), 1)

    def test_contextual_read_uses_explicit_phonemes(self):
        present = collect_voice_items('1', '2', [row()])[0]
        past = collect_voice_items('1', '2', [row(hint='past tense /red/')])[0]
        self.assertEqual(pronunciation_input(present), ('ɹiːd', True))
        self.assertEqual(pronunciation_input(past), ('ɹɛd', True))
        with self.assertRaises(StudioError):
            pronunciation_input({**present, 'pronunciationHint': ''})

    def test_american_flap_diacritic_is_normalized_for_kokoro(self):
        cases = {
            'motivation': ('/ˌmoʊ.t̬əˈveɪ.ʃən/', 'ˌmoʊ.ɾəˈveɪ.ʃən'),
            'excited': ('/ɪkˈsaɪ.t̬ɪd/', 'ɪkˈsaɪ.ɾɪd'),
            'little': ('/ˈlɪt̬.əl/', 'ˈlɪɾ.əl'),
        }
        for text, (hint, expected) in cases.items():
            item = collect_voice_items('1', '2', [row(text=text, hint=hint)])[0]
            self.assertEqual(pronunciation_input(item), (expected, True))

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
