import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from contracts import StudioError
from job_store import JobStore
from pipeline import process_job


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = JobStore(self.root / 'jobs')
        self.job = self.store.create({'creator': 'Alice'}, 'My Morning.mp4')

    def tearDown(self):
        self.temp.cleanup()

    @patch('pipeline.make_cover_variants')
    @patch('pipeline.make_cover')
    @patch('pipeline.enrich')
    @patch('pipeline.transcribe')
    @patch('pipeline.extract_audio')
    @patch('pipeline.transcode')
    @patch('pipeline.probe')
    @patch('pipeline.complete_teaching', side_effect=lambda rows, *args: (rows, [{'stage': 'independent-review'}]))
    def test_real_outputs_required_before_review(self, completion, probe, transcode, audio, asr, enrich, cover, variants):
        variants.return_value = [{'path': 'cover-320.webp', 'width': 320, 'height': 180, 'bytes': 1000}]
        probe.return_value = {'duration': 10, 'width': 1920, 'height': 1080}
        transcode.return_value = [{'label': '720p', 'path': '720p/index.m3u8'}]
        audio.return_value = self.root / 'audio.wav'
        asr.return_value = [{'id': 'one', 'english': 'Good morning', 'startTime': 0, 'endTime': 2}]
        enrich.return_value = (asr.return_value, {'titleZh': '我的清晨日常',
            'descriptionZh': '跟着创作者体验轻松自然的清晨日常，同时积累真实常用的英语表达。',
            'level': 'A2', 'levelReason': '短句为主', 'topicIds': ['daily'],
            'tagIds': ['vlog', 'daily-life', 'spoken-english'],
            'tagAssignments': [{'tagId': tag, 'sentenceIds': ['one'], 'reasonZh': '字幕证据',
                                'reviewStatus': 'REVIEW', 'source': 'ai'}
                               for tag in ('vlog', 'daily-life', 'spoken-english')],
            'goalMappings': [{'goalId': 'daily', 'sentenceIds': ['one'], 'reason': '日常表达'}]},
            [{'model': 'fixture'}])
        result = process_job(self.store, self.job['id'], self.root / 'source.mp4', None,
                             {}, self.root / 'media')
        self.assertEqual(result['status'], 'REVIEW')
        self.assertEqual(result['result']['video']['playback']['policy'], 'single-standard-v2')
        self.assertNotIn('original', result['result']['video']['playback'])
        self.assertTrue(result['result']['video']['mediaUrl'].endswith('/720p/index.m3u8'))
        self.assertEqual(result['result']['evidence']['subtitleCount'], 1)
        self.assertEqual(result['result']['video']['coverImages'][0]['width'], 320)
        self.assertEqual(result['result']['evidence']['aiRequestCount'], 2)
        self.assertEqual(completion.call_count, 1)
        self.assertTrue(result['result']['evidence']['humanReviewRequired'])
        repeated = process_job(self.store, self.job['id'], self.root / 'source.mp4', None,
                               {}, self.root / 'media')
        self.assertEqual(repeated['status'], 'REVIEW')
        self.assertEqual(probe.call_count, 1)
        self.assertEqual(asr.call_count, 1)

    @patch('pipeline.probe', side_effect=StudioError('NO_AUDIO_TRACK', '没有音轨'))
    def test_failure_never_reports_complete(self, _):
        result = process_job(self.store, self.job['id'], 'source.mp4', None, {}, self.root / 'media')
        self.assertEqual(result['status'], 'ERROR')
        self.assertLess(result['progress'], 100)
        self.assertEqual(result['error']['code'], 'NO_AUDIO_TRACK')


if __name__ == '__main__':
    unittest.main()
