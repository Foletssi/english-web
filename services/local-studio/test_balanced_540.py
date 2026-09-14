import json
import unittest
from unittest.mock import patch
from media_tools import ladder, probe, _profile_signature


class Balanced540(unittest.TestCase):
    def test_dimensions_and_profile(self):
        for source, expected in [((1920, 1080), (960, 540)), ((1080, 1920), (540, 960)),
                                 ((640, 360), (640, 360)), ((1920, 800), (960, 400)),
                                 ((1000, 1000), (540, 540))]:
            level = ladder(*source)[0]
            self.assertEqual((level['width'], level['height']), expected)
            self.assertEqual(level['label'], '540p')
            self.assertEqual(level['profileVersion'], 'balanced-540-v1')
            self.assertEqual(level['rateK'], 800)

    def test_fractional_frame_rates_and_integer_decimation(self):
        for source, expected in [('24000/1001', '24000/1001'), ('30000/1001', '30000/1001'),
                                 ('48', '24'), ('50', '25'), ('60000/1001', '30000/1001'),
                                 ('60', '30'), ('20', '20')]:
            level = ladder(1920, 1080, source)[0]
            self.assertEqual(level['fpsExpression'], expected)
            self.assertLessEqual(level['fps'], 30)
        self.assertNotEqual(_profile_signature(ladder(1920, 1080, '30000/1001')[0]),
                            _profile_signature(ladder(1920, 1080, 30)[0]))

    def test_probe_display_aspect_and_rotation(self):
        data = {'format': {'duration': '10'}, 'streams': [
            {'codec_type': 'video', 'width': 720, 'height': 576, 'sample_aspect_ratio': '16:15',
             'avg_frame_rate': '50/1', 'side_data_list': [{'rotation': -90}]}, {'codec_type': 'audio'}]}
        with patch('media_tools.run', return_value=json.dumps(data)):
            value = probe('unused')
        self.assertEqual((value['width'], value['height']), (576, 768))
        self.assertEqual(value['fpsExpression'], '50')


if __name__ == '__main__':
    unittest.main()
