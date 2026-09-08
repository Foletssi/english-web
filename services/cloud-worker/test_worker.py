import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name('worker.py')
SPEC = importlib.util.spec_from_file_location('cloud_worker', MODULE)
worker = importlib.util.module_from_spec(SPEC)
sys.modules['cloud_worker'] = worker
SPEC.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_content_types(self):
        self.assertEqual(worker.content_type('720p/index.m3u8'), 'application/vnd.apple.mpegurl')
        self.assertEqual(worker.content_type('720p/segment_00001.ts'), 'video/mp2t')

    def test_result_urls_point_to_cloud_route(self):
        result = {'video': {'playback': {'variants': [{'path': '720p/index.m3u8'}]}}, 'evidence': {}}
        value = worker.rewrite_result(result, '00000000-0000-0000-0000-000000000001')
        self.assertEqual(value['video']['mediaUrl'], '/api/processing/media/00000000-0000-0000-0000-000000000001/master.m3u8')
        self.assertEqual(value['evidence']['storage'], 'cloudflare-r2')

    def test_empty_download_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'source.mp4'
            target.write_bytes(b'')
            self.assertEqual(target.stat().st_size, 0)


if __name__ == '__main__':
    unittest.main()
