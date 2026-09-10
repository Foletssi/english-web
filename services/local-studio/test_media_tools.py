import shutil
import tempfile
import unittest
from pathlib import Path
from media_tools import extract_audio, ladder, make_cover, probe, run, transcode


class MediaTools(unittest.TestCase):
    def test_ladder_does_not_upscale(self):
        self.assertEqual([x['label'] for x in ladder(1280, 720)], ['720p'])
        self.assertEqual([x['label'] for x in ladder(1920, 1080)], ['720p'])
        low_source = ladder(640, 360)
        self.assertEqual([x['label'] for x in low_source], ['720p'])
        self.assertEqual([x['size'] for x in low_source], [360])

    def test_ladder_caps_frame_rate_and_uses_quality_based_encoding(self):
        levels = ladder(1920, 1080, 60)
        self.assertEqual([x['fps'] for x in levels], [30])
        self.assertEqual([x['crf'] for x in levels], [25])
        self.assertEqual([x['rateK'] for x in levels], [1200])
        self.assertEqual([x['audioRateK'] for x in levels], [96])
        self.assertEqual([x['fps'] for x in ladder(1920, 1080, 20)], [20])

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
            self.assertEqual([x['label'] for x in variants], ['720p'])
            self.assertLessEqual(variants[0]['frameRate'], 30)
            playlist = root / 'hls' / '720p' / 'index.m3u8'
            modified = playlist.stat().st_mtime_ns
            repeated = transcode(sample, root / 'hls', info)
            self.assertEqual([x['label'] for x in repeated], ['720p'])
            self.assertEqual(playlist.stat().st_mtime_ns, modified)


if __name__ == '__main__':
    unittest.main()
