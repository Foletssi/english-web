import io
import json
import unittest
from ai_tools import call_json, endpoint
from contracts import StudioError


class FakeResponse:
    def __init__(self, value):
        self.value = value
    def __enter__(self):
        return self
    def __exit__(self, *_):
        return False
    def read(self):
        return json.dumps(self.value).encode()


class AiTools(unittest.TestCase):
    def test_endpoint(self):
        self.assertEqual(endpoint('https://api.deepseek.com'), 'https://api.deepseek.com/chat/completions')

    def test_json_response(self):
        def open_fake(request, **_):
            self.assertEqual(request.get_method(), 'POST')
            return FakeResponse({'id': 'fixture', 'choices': [{'finish_reason': 'stop',
                'message': {'content': '{"ok":true}'}}]})
        value, meta = call_json({'baseUrl': 'https://api.example.com', 'model': 'fixture', 'apiKey': 'fixture'},
                                'return json', {'x': 1}, opener=open_fake)
        self.assertTrue(value['ok'])
        self.assertEqual(meta['requestId'], 'fixture')

    def test_missing_config(self):
        with self.assertRaisesRegex(StudioError, 'AI_NOT_CONFIGURED'):
            call_json({}, 'x', {})


if __name__ == '__main__':
    unittest.main()
