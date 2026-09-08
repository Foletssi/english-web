import shutil
import tempfile
import unittest
from pathlib import Path
from media_tools import extract_audio, ladder, make_cover, probe, run, transcode


class MediaTools(unittest.TestCase):
    def test_ladder_does_not_upscale(self):
        self.assertEqual([x['label'] for x in ladder(1280, 720)], ['480p', '720p'])
        self.assertEqual([x['label'] for x in ladder(1920, 1080)], ['480p', '720p', '1080p'])

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
            audio = extract_audio(sample, root / 'audio.wav')
            self.assertGreater(audio.stat().st_size, 44)
            cover = make_cover(sample, root / 'cover.webp', info['duration'])
            self.assertGreater(cover.stat().st_size, 0)
            variants = transcode(sample, root / 'hls', info)
            self.assertTrue((root / 'hls' / 'master.m3u8').exists())
            self.assertEqual([x['label'] for x in variants], ['480p', '720p'])


if __name__ == '__main__':
    unittest.main()
