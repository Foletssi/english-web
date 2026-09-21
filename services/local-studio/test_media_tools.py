import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import subprocess
import os
from media_tools import extract_audio, ladder, make_cover, probe, run, transcode
from contracts import StudioError


class MediaTools(unittest.TestCase):
    def test_ladder_does_not_upscale(self):
        self.assertEqual([x['label'] for x in ladder(1280, 720)], ['540p'])
        self.assertEqual([x['label'] for x in ladder(1920, 1080)], ['540p'])
        low_source = ladder(640, 360)
        self.assertEqual([x['label'] for x in low_source], ['540p'])
        self.assertEqual([x['size'] for x in low_source], [360])

    def test_ladder_caps_frame_rate_and_uses_quality_based_encoding(self):
        levels = ladder(1920, 1080, 60)
        self.assertEqual([x['fps'] for x in levels], [30])
        self.assertEqual([x['crf'] for x in levels], [25])
        self.assertEqual([x['rateK'] for x in levels], [800])
        self.assertEqual([x['audioRateK'] for x in levels], [96])
        self.assertEqual([x['preset'] for x in levels], ['medium'])
        self.assertEqual([x['profileVersion'] for x in levels], ['balanced-540-v1'])
        self.assertEqual([x['fps'] for x in ladder(1920, 1080, 20)], [20])

    def test_invalid_ffprobe_output_is_explicit_and_retryable(self):
        with patch('media_tools.run', return_value=b''):
            with self.assertRaises(StudioError) as raised:
                probe('broken.mp4')
        self.assertEqual(raised.exception.code, 'MEDIA_PROBE_INVALID')
        self.assertTrue(raised.exception.retryable)

    def test_commands_do_not_open_windows(self):
        with patch('media_tools.require_tools'), patch('media_tools.subprocess.Popen') as execute:
            process = execute.return_value.__enter__.return_value
            process.communicate.return_value = (b'ok', b'')
            process.returncode = 0
            run(['ffprobe', 'sample.mp4'])
            self.assertEqual(execute.call_args.kwargs['creationflags'],
                             subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg unavailable')
    def test_real_media_pipeline(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sample = root / 'input.mp4'
            run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
                 '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:d=1',
                 '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
                 '-c:v', 'libx264', '-c:a', 'aac', '-shortest', str(sample)], 60)
            info = probe(sample)
            self.assertGreater(info['duration'], 0)
            self.assertGreater(info['fps'], 0)
            audio = extract_audio(sample, root / 'audio.wav')
            self.assertGreater(audio.stat().st_size, 44)
            cover = make_cover(sample, root / 'cover.webp', info['duration'])
            self.assertGreater(cover.stat().st_size, 0)
            variants = transcode(sample, root / 'hls', info)
            self.assertTrue((root / 'hls' / 'master.m3u8').exists())
            self.assertEqual([x['label'] for x in variants], ['540p'])
            self.assertLessEqual(variants[0]['frameRate'], 30)
            playlist = root / 'hls' / '540p' / 'index.m3u8'
            self.assertIn('balanced-540-v1', playlist.read_text())
            modified = playlist.stat().st_mtime_ns
            repeated = transcode(sample, root / 'hls', info)
            self.assertEqual([x['label'] for x in repeated], ['540p'])
            self.assertEqual(playlist.stat().st_mtime_ns, modified)
            playlist.write_text(playlist.read_text().replace('balanced-540-v1', 'single-720-v2'))
            transcode(sample, root / 'hls', info)
            self.assertIn('balanced-540-v1', playlist.read_text())


if __name__ == '__main__':
    unittest.main()
