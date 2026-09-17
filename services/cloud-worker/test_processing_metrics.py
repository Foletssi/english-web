import unittest
from unittest.mock import patch
from processing_metrics import stage_metrics


class ProcessingMetricsTests(unittest.TestCase):
    def test_history_freezes_prior_step_and_does_not_invent_progress(self):
        lease = {}
        with patch('processing_metrics.datetime') as clock:
            clock.now.return_value.isoformat.side_effect = ['t1', 't2', 't3', 't4']
            first = stage_metrics(lease, 'LOCAL_DOWNLOAD', {'current': 5, 'total': 10, 'unit': 'bytes'})
            steady = stage_metrics(lease, 'LOCAL_DOWNLOAD', {'current': 5, 'total': 10, 'unit': 'bytes'})
            next_step = stage_metrics(lease, 'PROBE', {})
            voice = stage_metrics(lease, 'ENRICH', {'substage': 'teaching-voice', 'current': 2, 'total': 5})
        self.assertEqual(steady['stepHistory']['download']['lastProgressAt'], 't1')
        self.assertEqual(next_step['stepHistory']['download']['completedAt'], 't3')
        self.assertNotIn('completedAt', first['stepHistory']['download'])
        self.assertEqual(voice['stepHistory']['voice']['current'], 2)
        self.assertEqual(voice['stepHistory']['probe']['completedAt'], 't4')
        self.assertEqual(stage_metrics({}, 'QUEUED', {}), {})
        self.assertEqual(set(stage_metrics({}, 'PROBE', {})['stepHistory']), {'probe'})
