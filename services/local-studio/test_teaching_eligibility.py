import copy
import tempfile
import unittest
from unittest.mock import patch

from contracts import StudioError
from teaching_eligibility import refine_eligibility


def fixture():
    rows = []
    for index, word in enumerate(['like', 'gatekeeping']):
        rows.append({'id': str(index), 'english': f'It is {word}.', 'chinese': '原译文',
            'startTime': index, 'endTime': index + 1, 'textRevision': 1,
            'keyWords': [word], 'expressions': [{'surface': word, 'coreMeaningZh': '旧义',
                'pronunciationHint': '/laɪk/', 'expressionType': 'word'}],
            'wordLookup': {'tokens': [{'surface': word, 'coreMeaningZh': '原有逐词释义'}]},
            'teachingAnalysis': {}, 'coverageAnalysis': {'pairs': [{
                'pairId': 'p0', 'sentenceIds': ['0', '1'], 'sourceTextRevisions': [1, 1],
                'status': 'covered', 'reasonZh': '已检查'}]}})
    return rows


class EligibilityTests(unittest.TestCase):
    def answer(self, prompt, payload):
        return {'decisions': [{'itemId': item['itemId'],
            'keep': item['expression']['surface'] != 'like', 'reasonZh': '语境门槛判断',
            'coreMeaningZh': '藏私', 'contextMeaningZh': '这里表示不分享信息'}
            for item in payload['items']]}, {'model': 'fixture'}

    def test_pruning_preserves_tokens_source_timing_and_audio_hint(self):
        original = fixture()
        untouched = copy.deepcopy(original)
        calls = []
        def request(prompt, payload):
            calls.append(payload)
            return self.answer(prompt, payload)
        with tempfile.TemporaryDirectory() as cache:
            checked, _ = refine_eligibility(original, cache_dir=cache, request=request)
            refine_eligibility(original, cache_dir=cache, request=request)
        self.assertEqual(len(calls), 1)
        self.assertEqual(original, untouched)
        self.assertEqual(checked[0]['keyWords'], [])
        self.assertEqual(checked[1]['expressions'][0]['coreMeaningZh'], '藏私')
        for before, after in zip(original, checked):
            for field in ['english', 'chinese', 'startTime', 'endTime', 'wordLookup']:
                self.assertEqual(before[field], after[field])
        self.assertEqual(checked[1]['expressions'][0]['pronunciationHint'], '/laɪk/')
        self.assertEqual(checked[0]['coverageAnalysis']['pairs'][0]['status'], 'covered')

    def test_last_highlight_removed_requires_two_source_reviews(self):
        original = fixture()
        original[1]['keyWords'] = []
        original[1]['expressions'] = []
        calls = []
        def coverage_request(prompt, payload):
            calls.append(payload)
            return {'teachingSchemaVersion': 3, 'sentences': payload['sentences'],
                'decisions': [{'pairId': 'p0', 'status': 'no_eligible_source',
                               'reasonZh': '重新检查整组原文，只含基础 like。'}]}, {'model': 'fixture'}
        original[0]['grammar'] = original[1]['grammar'] = ''
        checked, _ = refine_eligibility(original, request=self.answer, coverage_request=coverage_request)
        self.assertEqual(len(calls), 2)
        self.assertIn('candidate', calls[1])
        reports = [row['coverageAnalysis']['pairs'][0] for row in checked]
        self.assertEqual(reports[0], reports[1])
        self.assertEqual(reports[0]['status'], 'no_eligible_source')
        self.assertIn('like', reports[0]['reasonZh'])

    def test_environment_model_and_endpoint_invalidate_cache(self):
        calls = []
        def request(prompt, payload):
            calls.append(payload)
            return self.answer(prompt, payload)
        with tempfile.TemporaryDirectory() as cache:
            for model, base in [('a', 'https://one'), ('b', 'https://one'), ('b', 'https://two')]:
                with patch.dict('os.environ', ZOSPEAK_AI_MODEL=model, ZOSPEAK_AI_BASE_URL=base):
                    refine_eligibility(fixture(), cache_dir=cache, request=request)
        self.assertEqual(len(calls), 3)

    def test_source_recheck_adds_advanced_expression_without_overwriting_details(self):
        original = fixture()
        original[0]['english'] = 'It is like we must persevere.'
        original[1]['keyWords'] = []
        original[1]['expressions'] = []
        for row in original:
            row['grammar'] = ''
        from test_teaching_coverage import highlight
        for ipa in ('/ˌpɜrsəˈvɪr/', ''):
            calls = []
            def coverage_request(prompt, payload):
                calls.append(copy.deepcopy(payload))
                candidate = copy.deepcopy(payload['sentences'])
                highlight(candidate[0])
                candidate[0]['expressions'][0]['pronunciationHint'] = ipa
                candidate[0]['chinese'] = '不应覆盖已有译文'
                return {'teachingSchemaVersion': 3, 'sentences': candidate,
                    'decisions': [{'pairId': 'p0', 'status': 'covered',
                                   'reasonZh': '原句 persevere 表示克服困难坚持。'}]}, {'model': 'fixture'}
            with self.subTest(ipa=ipa):
                if not ipa:
                    with self.assertRaises(StudioError):
                        refine_eligibility(original, request=self.answer, coverage_request=coverage_request)
                    self.assertEqual(len(calls), 3)
                    continue
                checked, _ = refine_eligibility(original, request=self.answer, coverage_request=coverage_request)
                self.assertEqual(len(calls), 2)
                self.assertEqual(checked[0]['keyWords'], ['persevere'])
                self.assertEqual(checked[0]['expressions'][0]['pronunciationHint'], ipa)
                for before, after in zip(original, checked):
                    for field in ['english', 'chinese', 'startTime', 'endTime', 'wordLookup']:
                        self.assertEqual(before[field], after[field])
                self.assertEqual(checked[0]['coverageAnalysis']['pairs'][0],
                                 checked[1]['coverageAnalysis']['pairs'][0])
                self.assertEqual(checked[0]['coverageAnalysis']['pairs'][0]['status'], 'covered')

    def test_manual_selection_is_not_sent_or_changed(self):
        original = fixture()
        original[0]['selectionLocked'] = True
        def request(prompt, payload):
            self.assertEqual(len(payload['items']), 1)
            return self.answer(prompt, payload)
        checked, _ = refine_eligibility(original, request=request)
        self.assertEqual(checked[0], original[0])

    def test_missing_or_duplicate_decisions_cannot_be_published(self):
        for duplicate in (False, True):
            def request(prompt, payload):
                value, meta = self.answer(prompt, payload)
                value['decisions'] = value['decisions'][:1] * (2 if duplicate else 1)
                return value, meta
            with self.assertRaises(StudioError):
                refine_eligibility(fixture(), request=request)


if __name__ == '__main__':
    unittest.main()
