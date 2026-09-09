import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from ai_tools import LEARNING_PROMPT, ai_concurrency, asr_profile, call_json, endpoint, enrich, prepare_asr_model, retry_ai
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

    def test_ai_concurrency_is_bounded(self):
        with patch.dict('os.environ', {'EASTUDY_AI_CONCURRENCY': '99'}):
            self.assertEqual(ai_concurrency(), 4)
        with patch.dict('os.environ', {'EASTUDY_AI_CONCURRENCY': 'invalid'}):
            self.assertEqual(ai_concurrency(), 3)

    def test_retry_ai_only_retries_retryable_errors(self):
        operation = Mock(side_effect=[
            StudioError('AI_NETWORK_ERROR', 'temporary', True), {'ok': True}])
        with patch('ai_tools.time.sleep') as sleep:
            self.assertEqual(retry_ai(operation), {'ok': True})
        self.assertEqual(operation.call_count, 2)
        sleep.assert_called_once_with(1)

    def test_enrichment_reuses_validated_batches(self):
        rows = [{'id': 'v-1', 'english': 'Good morning', 'startTime': 0, 'endTime': 1}]
        learning = {'sentences': [{'id': 'v-1', 'chinese': '早上好',
            'keyWords': ['Good morning'], 'grammar': '问候语'}],
            'batchSummary': {'summary': '日常问候', 'evidenceIds': ['v-1']}}
        metadata = {'titleZh': '我的清晨日常',
            'descriptionZh': '跟着视频积累真实自然的清晨问候表达，并练习日常英语听力和口语。',
            'level': 'A2', 'levelReason': '短句为主', 'topicIds': ['daily'],
            'goalMappings': [{'goalId': 'daily', 'sentenceIds': ['v-1'], 'reason': '日常表达'}]}
        config = {'model': 'fixture', 'baseUrl': 'https://api.example.com', 'apiKey': 'secret'}
        info = {'title': 'Morning', 'creator': 'Alice', 'duration': 10, 'wordsPerMinute': 12}
        with tempfile.TemporaryDirectory() as folder, \
                patch('ai_tools.call_json', side_effect=[(learning, {'requestId': 'one'}),
                                                         (metadata, {'requestId': 'two'})]) as mocked:
            first = enrich(rows, info, config, cache_dir=Path(folder))
            self.assertEqual(mocked.call_count, 2)
            mocked.reset_mock()
            second = enrich(rows, info, config, cache_dir=Path(folder))
            self.assertEqual(mocked.call_count, 0)
            self.assertEqual(first[0], second[0])
            self.assertTrue(all(item['cacheReused'] for item in second[2]))

    def test_parallel_enrichment_preserves_subtitle_order(self):
        rows = [{'id': f'v-{index}', 'english': f'Line {index}',
                 'startTime': index, 'endTime': index + 1} for index in range(45)]
        config = {'model': 'fixture', 'baseUrl': 'https://api.example.com', 'apiKey': 'secret'}
        info = {'title': 'Morning', 'creator': 'Alice', 'duration': 45, 'wordsPerMinute': 60}

        def fake_call(_config, prompt, payload):
            if prompt == LEARNING_PROMPT:
                sentences = [{'id': item['id'], 'chinese': item['english'],
                    'keyWords': [item['english']], 'grammar': '句子'} for item in payload['sentences']]
                return {'sentences': sentences, 'batchSummary': {
                    'summary': '分批摘要', 'evidenceIds': [sentences[0]['id']]}}, {'requestId': sentences[0]['id']}
            return {'titleZh': '我的日常', 'descriptionZh': '通过真实生活视频积累自然英语表达，同时练习听力、词汇和日常口语。',
                'level': 'A2', 'levelReason': '短句为主', 'topicIds': ['daily'],
                'goalMappings': [{'goalId': 'daily', 'sentenceIds': ['v-0'], 'reason': '日常表达'}]}, {'requestId': 'metadata'}

        with tempfile.TemporaryDirectory() as folder, patch('ai_tools.call_json', side_effect=fake_call):
            learned, _, _ = enrich(rows, info, config, cache_dir=Path(folder))
        self.assertEqual([item['id'] for item in learned], [item['id'] for item in rows])


if __name__ == '__main__':
    unittest.main()
