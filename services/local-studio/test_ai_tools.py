import io
import json
import unittest
from ai_tools import asr_profile, call_json, endpoint, prepare_asr_model
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
    def test_asr_defaults_to_cached_multilingual_small(self):
        profile = asr_profile()
        self.assertEqual(profile['model'], 'small')
        self.assertTrue(profile['localFilesOnly'])

    def test_model_preflight_is_offline_and_consumes_inference(self):
        calls = []
        class FakeModel:
            def transcribe(self, *_args, **kwargs):
                calls.append(('transcribe', kwargs))
                return iter(()), object()
        def factory(source, **kwargs):
            calls.append(('factory', source, kwargs))
            return FakeModel()
        model, profile = prepare_asr_model('fixture', verify_inference=True, model_factory=factory)
        self.assertIsInstance(model, FakeModel)
        self.assertEqual(profile['model'], 'fixture')
        self.assertTrue(calls[0][2]['local_files_only'])
        self.assertEqual(calls[1][1]['language'], 'en')

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
