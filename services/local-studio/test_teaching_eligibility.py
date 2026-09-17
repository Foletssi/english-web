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
    def test_default_preserves_legacy_payload_and_table_cannot_reuse_full_cache(self):
        from teaching_eligibility import PROMPT, VERSION, CONTEXT_TABLE_VERSION
        calls = []
        def request(prompt, payload):
            calls.append((prompt, payload))
            return self.answer(prompt, payload)
        with tempfile.TemporaryDirectory() as cache, patch.dict(
                'os.environ', EASTUDY_ELIGIBILITY_CONTEXT_MODE='full'):
            _, records = refine_eligibility(fixture(), cache_dir=cache, request=request)
            self.assertEqual(records[0]['stage'], VERSION)
            self.assertEqual(calls[0][0], PROMPT)
            item = calls[0][1]['items'][0]
            self.assertEqual(set(item), {'itemId', 'english', 'before', 'after',
                                        'contextBefore', 'contextAfter', 'expression'})
            _, records = refine_eligibility(fixture(), {'eligibilityContextMode': 'table'},
                                           cache_dir=cache, request=request)
            self.assertEqual(records[0]['stage'], CONTEXT_TABLE_VERSION)
            self.assertIn('sentences', calls[1][1])
            refine_eligibility(fixture(), {'eligibilityContextMode': 'table'},
                               cache_dir=cache, request=request)
        self.assertEqual(len(calls), 2)

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

    def test_later_scene_evidence_reaches_eligibility_review(self):
        original = fixture()
        original[0]['english'] = 'I want to see this girl.'
        original[0]['expressions'][0]['surface'] = 'see'
        for index in range(2, 9):
            original.append({'english': 'She works at the drive-thru.' if index == 7 else 'Context.',
                             'expressions': [], 'keyWords': [], 'selectionLocked': True,
                             'coverageAnalysis': {'pairs': []}})
        for index, row in enumerate(original):
            row['coverageAnalysis']['pairs'] = [
                {'pairId': f'p{i}', 'status': 'no_eligible_source'}
                for i in (index-1, index) if 0 <= i < len(original)-1]
        def request(prompt, payload):
            target = payload['items'][0]
            sentences = {s['index']: s['english'] for s in payload['sentences']}
            after = [sentences[i] for i in target['contextAfter']]
            self.assertIn('She works at the drive-thru.', after)
            self.assertNotIn(sentences[target['sentenceIndex']], after)
            return self.answer(prompt, payload)
        refine_eligibility(original, {'eligibilityContextMode': 'table'}, request=request)

    def test_context_table_retains_all_original_windows_and_candidate_fields(self):
        from teaching_eligibility import eligibility_payload
        rows = [{'english': f'Sentence {i}.'} for i in range(30)]
        batch = [{'itemId': f'{i}:{p}', 'sentenceIndex': i,
                  'expression': {'surface': 'test', 'coreMeaningZh': '原义', 'extra': 'retained'}}
                 for i in (0, 12, 29) for p in range(2)]
        before = copy.deepcopy((rows, batch))
        payload = eligibility_payload(rows, batch)
        table = {r['index']: r['english'] for r in payload['sentences']}
        self.assertEqual(len(table), len(payload['sentences']))
        for source, item in zip(batch, payload['items']):
            index = source['sentenceIndex']
            self.assertEqual(table[index], rows[index]['english'])
            self.assertEqual([table[i] for i in item['contextBefore']],
                             [r['english'] for r in rows[max(0, index-8):index]])
            self.assertEqual([table[i] for i in item['contextAfter']],
                             [r['english'] for r in rows[index+1:index+9]])
            self.assertEqual(item['expression'], source['expression'])
        self.assertEqual((rows, batch), before)

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
