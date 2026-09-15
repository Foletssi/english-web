import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from ai_tools import LEARNING_PROMPT, LEARNING_REPAIR_PROMPT, LEARNING_REEXTRACT_PROMPT, TEACHING_PROMPT_VERSION, ai_concurrency, asr_profile, call_json, endpoint, enrich, prepare_asr_model, repair_learning, retry_ai
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


def v5_payload(payload):
    value = json.loads(json.dumps(payload))
    value['teachingSchemaVersion'] = 3
    for sentence in value.get('sentences', []):
        for expression in sentence.get('expressions', []):
            expression.setdefault('lemma', expression.get('surface', '').lower())
            expression.setdefault('expressionType', 'collocation')
            expression.setdefault('selectionReasonZh', '可迁移的常用表达。')
            expression.setdefault('needsReview', False)
    return value


class AiTools(unittest.TestCase):
    def test_locked_empty_analysis_and_cache_keep_real_provenance(self):
        rows = [{'id': 's1', 'english': 'We love you.', 'keyWords': [],
                 'selectionLocked': True, 'textRevision': 7, 'startTime': 0, 'endTime': 2}]
        payload = v5_payload({'sentences': [{'id': 's1', 'chinese': '我们爱你。',
                    'keyWords': [], 'expressions': [], 'grammar': ''}]})
        with tempfile.TemporaryDirectory() as folder, patch('ai_tools.call_json', return_value=(payload, {})) as call:
            learned, _ = repair_learning(rows, cache_dir=Path(folder), mode='reextract')
            self.assertTrue(call.call_args.args[2]['sentences'][0]['selectionLocked'])
            self.assertEqual(learned[0]['keyWords'], [])
            self.assertEqual(learned[0]['teachingAnalysis'], {'status': 'completed',
                'promptVersion': TEACHING_PROMPT_VERSION, 'sourceTextRevision': 7})
            rows[0]['textRevision'] = 8
            cached, evidence = repair_learning(rows, cache_dir=Path(folder), mode='reextract')
            self.assertEqual(call.call_count, 1)
            self.assertTrue(evidence[0]['cacheReused'])
            self.assertEqual(cached[0]['teachingAnalysis']['sourceTextRevision'], 8)

    def test_locked_empty_selection_rejects_new_ai_words(self):
        rows = [{'id': 's1', 'english': 'We love you.', 'keyWords': [],
                 'selectionLocked': True, 'startTime': 0, 'endTime': 2}]
        payload = v5_payload({'sentences': [{'id': 's1', 'chinese': '我们爱你。',
            'keyWords': ['love'], 'expressions': [{'surface': 'love', 'coreMeaningZh': '爱',
                'contextMeaningZh': '表达爱意'}], 'grammar': ''}]})
        with patch('ai_tools.call_json', return_value=(payload, {})), patch('ai_tools.time.sleep'):
            with self.assertRaisesRegex(StudioError, 'AI_REPAIR_KEYWORDS_CHANGED'):
                repair_learning(rows, mode='reextract')

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
        learning = v5_payload({'sentences': [{'id': 'v-1', 'chinese': '早上好',
            'keyWords': ['Good morning'], 'expressions': [{'surface': 'Good morning',
                'coreMeaningZh': '早上好', 'contextMeaningZh': '这里是清晨问候。',
                'usageNoteZh': '用于上午见面问候。'}], 'grammar': '问候语'}],
            'batchSummary': {'summary': '日常问候', 'evidenceIds': ['v-1']}})
        metadata = {'titleZh': '我的清晨日常',
            'descriptionZh': '跟着视频积累真实自然的清晨问候表达，并练习日常英语听力和口语。',
            'level': 'A2', 'levelReason': '短句为主', 'topicIds': ['daily'],
            'tags': [{'tagId': tag, 'sentenceIds': ['v-1'], 'reasonZh': '字幕证据'}
                     for tag in ('daily-life', 'spoken-english')],
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
                    'keyWords': [item['english']], 'expressions': [{'surface': item['english'],
                        'coreMeaningZh': '本句表达', 'contextMeaningZh': '当前句中的表达。',
                        'usageNoteZh': '结合上下文使用。'}], 'grammar': '句子'} for item in payload['sentences']]
                return v5_payload({'sentences': sentences, 'batchSummary': {
                    'summary': '分批摘要', 'evidenceIds': [sentences[0]['id']]}}), {'requestId': sentences[0]['id']}
            return {'titleZh': '我的日常', 'descriptionZh': '通过真实生活视频积累自然英语表达，同时练习听力、词汇和日常口语。',
                'level': 'A2', 'levelReason': '短句为主', 'topicIds': ['daily'],
                'tags': [{'tagId': tag, 'sentenceIds': ['v-0'], 'reasonZh': '字幕证据'}
                         for tag in ('daily-life', 'spoken-english')],
                'goalMappings': [{'goalId': 'daily', 'sentenceIds': ['v-0'], 'reason': '日常表达'}]}, {'requestId': 'metadata'}

        with tempfile.TemporaryDirectory() as folder, patch('ai_tools.call_json', side_effect=fake_call):
            learned, _, _ = enrich(rows, info, config, cache_dir=Path(folder))
        self.assertEqual([item['id'] for item in learned], [item['id'] for item in rows])

    def test_learning_repair_preserves_requested_keywords_and_timing(self):
        rows = [{'id': 'v-1', 'english': "I've been doing this", 'chinese': '',
                 'keyWords': ["I've been doing"], 'startTime': 1.25, 'endTime': 2.75,
                 'wordTimings': [{'text': "I've", 'start': 1.25, 'end': 1.6}]}]
        payload = v5_payload({'sentences': [{'id': 'v-1', 'chinese': '我一直在做这件事',
            'keyWords': ["I've been doing"], 'expressions': [{'surface': "I've been doing",
                'coreMeaningZh': '一直在做', 'contextMeaningZh': '表示此前持续进行的事情。',
                'usageNoteZh': '现在完成进行时。'}], 'grammar': '现在完成进行时'}]})
        with tempfile.TemporaryDirectory() as folder, patch('ai_tools.call_json', return_value=(payload, {'requestId': 'repair'})) as mocked:
            learned, evidence = repair_learning(rows, {'model': 'fixture', 'baseUrl': 'https://api.example.com', 'apiKey': 'secret'}, cache_dir=Path(folder))
        self.assertEqual(mocked.call_args.args[1], LEARNING_REPAIR_PROMPT)
        self.assertEqual(learned[0]['keyWords'], ["I've been doing"])
        self.assertEqual(learned[0]['startTime'], 1.25)
        self.assertEqual(learned[0]['wordTimings'], rows[0]['wordTimings'])
        self.assertEqual(evidence[0]['requestId'], 'repair')

    def test_learning_repair_uses_same_number_agnostic_phrase_contract_as_web(self):
        rows = [{'id': 'v-1', 'english': 'We were launching at 11 a.m. today',
                 'keyWords': ['launching at a m'], 'startTime': 1.25, 'endTime': 2.75,
                 'wordTimings': []}]
        payload = v5_payload({'sentences': [{'id': 'v-1', 'chinese': '我们今天上午十一点发布。',
                    'keyWords': ['launching at a m'], 'expressions': [{
                        'surface': 'launching at a m', 'coreMeaningZh': '在某时发布',
                        'contextMeaningZh': '本句指上午十一点发布。', 'usageNoteZh': 'launch at + 时间'}],
                    'grammar': '过去进行时。'}]})
        with tempfile.TemporaryDirectory() as folder, patch('ai_tools.call_json', return_value=(payload, {'requestId': 'repair'})):
            learned, _ = repair_learning(rows, {'model': 'fixture', 'baseUrl': 'https://api.example.com', 'apiKey': 'secret'}, cache_dir=Path(folder))
        self.assertEqual(learned[0]['keyWords'], ['launching at a m'])

    def test_learning_repair_rejects_changed_requested_keywords(self):
        rows = [{'id': 'v-1', 'english': 'Good morning guys', 'keyWords': ['Good morning'],
                 'startTime': 0, 'endTime': 2}]
        payload = v5_payload({'sentences': [{'id': 'v-1', 'chinese': '大家早上好',
            'keyWords': ['morning guys'], 'expressions': [{'surface': 'morning guys',
                'coreMeaningZh': '早上的大家', 'contextMeaningZh': '错误替换', 'usageNoteZh': '测试'}],
            'grammar': '问候'}]})
        with tempfile.TemporaryDirectory() as folder, patch('ai_tools.call_json', return_value=(payload, {'requestId': 'changed'})):
            with self.assertRaisesRegex(StudioError, 'AI_REPAIR_KEYWORDS_CHANGED'):
                repair_learning(rows, {'model': 'fixture', 'baseUrl': 'https://api.example.com', 'apiKey': 'secret'}, cache_dir=Path(folder))

    def test_learning_reextract_can_replace_unlocked_ai_selection(self):
        rows = [{'id': 'v-1', 'english': 'Okay, my makeup is done.',
                 'keyWords': ['my makeup', 'is done'], 'selectionLocked': False,
                 'startTime': 0, 'endTime': 2}]
        payload = v5_payload({'sentences': [{'id': 'v-1', 'chinese': '好了，我的妆化好了。',
            'keyWords': ['makeup'], 'expressions': [{'surface': 'makeup',
                'coreMeaningZh': '妆容；化妆品', 'contextMeaningZh': '这里指已经完成的妆容。',
                'usageNoteZh': '这里是不可数名词。'}], 'grammar': ''}]})
        with tempfile.TemporaryDirectory() as folder, patch('ai_tools.call_json', return_value=(payload, {'requestId': 'reextract'})) as mocked:
            learned, _ = repair_learning(rows, {'model': 'fixture', 'baseUrl': 'https://api.example.com', 'apiKey': 'secret'}, cache_dir=Path(folder), mode='reextract')
        self.assertEqual(mocked.call_args.args[1], LEARNING_REEXTRACT_PROMPT)
        self.assertEqual(learned[0]['keyWords'], ['makeup'])
        self.assertEqual(mocked.call_args.args[2]['sentences'][0]['requestedKeyWords'], [])


if __name__ == '__main__':
    unittest.main()
