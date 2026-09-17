import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from media_tools import extract_audio


class AudioRecoveryTests(unittest.TestCase):
    def test_only_complete_source_bound_audio_is_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / 'source.mp4', root / 'audio.wav'
            source.write_bytes(b'original')
            target.write_bytes(b'incomplete' * 20)

            def encode(args):
                with wave.open(args[-1], 'wb') as audio:
                    audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                    audio.writeframes(b'\0\0' * 160)

            with patch('media_tools.run', side_effect=encode) as run:
                extract_audio(source, target)
                self.assertEqual(run.call_count, 1)
                extract_audio(source, target)
                self.assertEqual(run.call_count, 1, 'Verified audio must be reused')
                target.write_bytes(target.read_bytes()[:-2])
                extract_audio(source, target)
                self.assertEqual(run.call_count, 2, 'Truncated audio must be rebuilt')
                source.write_bytes(b'replaced')
                extract_audio(source, target)
                self.assertEqual(run.call_count, 3, 'Changed original must invalidate audio')

    def test_failed_extraction_does_not_replace_complete_audio(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / 'source.mp4', root / 'audio.wav'
            source.write_bytes(b'original')
            target.write_bytes(b'previous-result')

            def interrupted(args):
                Path(args[-1]).write_bytes(b'partial')
                raise RuntimeError('interrupted')

            with patch('media_tools.run', side_effect=interrupted):
                with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                    extract_audio(source, target)
            self.assertEqual(target.read_bytes(), b'previous-result')
            self.assertEqual(list(root.glob('.*.wav')), [])


if __name__ == '__main__':
    unittest.main()
