import copy
import tempfile
import unittest
from unittest.mock import Mock, patch

from contracts import StudioError
from teaching_details import complete_details, source_tokens, validate_details
from teaching_review import apply_review, REVIEW_VERSION


class DeltaReviewTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{'id': 's1', 'english': 'I read it.', 'chinese': '我读了它。',
            'startTime': 1, 'endTime': 2, 'textRevision': 4, 'keyWords': ['read'],
            'expressions': [{'expressionId': 'e1', 'surface': 'read', 'coreMeaningZh': '阅读'}]}]
        self.candidate = {'sentences': [{'id': 's1', 'chinese': '我读了它。', 'sourceConcerns': [],
            'tokens': [{**t, 'coreMeaningZh': '原义', 'pronunciationHint': '/riːd/'}
                       for t in source_tokens(self.rows[0])['tokens']],
            'expressions': [{'expressionId': 'e1', 'pronunciationHint': '/riːd/'}]}]}
        self.response = {'schemaVersion': 1, 'reviewedIds': ['s1'], 'patches': []}

    def test_typed_patch_preserves_source_and_every_identity(self):
        before = copy.deepcopy((self.rows, self.candidate))
        self.response['patches'] = [{'id': 's1', 'tokens': [
            {'tokenId': 't1', 'coreMeaningZh': '读过', 'pronunciationHint': '/rɛd/'}],
            'expressions': [{'expressionId': 'e1', 'pronunciationHint': '/rɛd/'}]}]
        result = apply_review(self.rows, self.candidate, self.response)[0]
        self.assertEqual((self.rows, self.candidate), before)
        for key in ('id', 'english', 'startTime', 'endTime', 'textRevision', 'keyWords'):
            self.assertEqual(result[key], self.rows[0][key])
        self.assertEqual(len(result['wordLookup']['tokens']), 3)
        self.assertEqual(result['wordLookup']['tokens'][1]['coreMeaningZh'], '读过')
        self.assertEqual(result['expressions'][0]['coreMeaningZh'], '阅读')
        self.assertEqual(result['expressions'][0]['pronunciationHint'], '/rɛd/')

    def test_rejects_coverage_schema_and_unknown_fields(self):
        for field, value in [('schemaVersion', True), ('schemaVersion', 2),
                ('reviewedIds', []), ('reviewedIds', ['s1', 's1']), ('reviewedIds', ['wrong']),
                ('reviewedIds', [{}]), ('patches', {}), ('extra', 'not allowed')]:
            with self.subTest(field=field, value=value), self.assertRaises(StudioError):
                apply_review(self.rows, self.candidate, {**self.response, field: value})

    def test_rejects_unauthorized_invalid_or_duplicate_patches(self):
        cases = [[{'id': 's1'}], [{'id': 's1', 'english': 'changed'}],
            [{'id': [], 'chinese': '变更'}], [{'id': 'missing', 'chinese': '变更'}],
            [{'id': 's1', 'tokens': [{'tokenId': 't8', 'coreMeaningZh': '错'}]}],
            [{'id': 's1', 'tokens': [{'tokenId': 't1', 'start': 30}]}],
            [{'id': 's1', 'tokens': [{'tokenId': 't1', 'pronunciationHint': ''}]}],
            [{'id': 's1', 'tokens': [{'tokenId': 't1', 'coreMeaningZh': '待生成'}]}],
            [{'id': 's1', 'expressions': [{'expressionId': 'e1', 'coreMeaningZh': '改义'}]}],
            [{'id': 's1', 'sourceConcerns': 'bad'}],
            [{'id': 's1', 'chinese': '变化'}, {'id': 's1', 'chinese': '再变'}],
            [{'id': 's1', 'tokens': [{'tokenId': 't1', 'coreMeaningZh': '一'},
                                    {'tokenId': 't1', 'coreMeaningZh': '二'}]}]]
        for patches in cases:
            with self.subTest(patches=patches), self.assertRaises(StudioError):
                apply_review(self.rows, self.candidate, {**self.response, 'patches': patches})

    def test_empty_patch_still_validates_full_candidate(self):
        self.candidate['sentences'][0]['tokens'].pop()
        with self.assertRaises(StudioError):
            apply_review(self.rows, self.candidate, self.response)

    def test_empty_collection_with_real_translation_fix_is_valid(self):
        response = {**self.response, 'patches': [
            {'id': 's1', 'chinese': '我已经读过它了。', 'tokens': [], 'expressions': []}]}
        result = apply_review(self.rows, self.candidate, response)
        self.assertEqual(result[0]['chinese'], '我已经读过它了。')
        self.assertEqual(len(result[0]['wordLookup']['tokens']), 3)

    def test_redundant_known_fields_do_not_trigger_another_paid_request(self):
        response = {**self.response, 'patches': [{'id': 's1', 'chinese': '我读了它。',
            'tokens': [{'tokenId': 't1', 'coreMeaningZh': '原义'}], 'expressions': []}]}
        self.assertEqual(apply_review(self.rows, self.candidate, response),
                         apply_review(self.rows, self.candidate, self.response))

    def test_locked_translation_and_source_concerns(self):
        self.rows[0]['translationLocked'] = True
        self.response['patches'] = [{'id': 's1', 'chinese': '变化'}]
        with self.assertRaises(StudioError): apply_review(self.rows, self.candidate, self.response)
        self.response['patches'] = [{'id': 's1', 'sourceConcerns': ['疑似漏词']}]
        result = apply_review(self.rows, self.candidate, self.response)
        self.assertEqual(result[0]['chinese'], self.rows[0]['chinese'])
        self.assertEqual(result[0]['translationAnalysis']['sourceConcerns'], ['疑似漏词'])

    def test_delta_matches_full_validation_for_semantic_boundaries(self):
        rows = [
            {'id': 's1', 'english': "I don't think she means it.", 'chinese': '我不觉得她是认真的。',
             'startTime': 1, 'endTime': 2, 'textRevision': 2, 'keyWords': ["don't think"],
             'expressions': [{'expressionId': 'e1', 'surface': "don't think", 'coreMeaningZh': '不认为'}]},
            {'id': 's2', 'english': 'She read it yesterday.', 'chinese': '她昨天读过了。',
             'translationLocked': True, 'startTime': 2, 'endTime': 3, 'textRevision': 3,
             'keyWords': ['read'], 'expressions': [
                 {'expressionId': 'e2', 'surface': 'read', 'coreMeaningZh': '读过'}]},
        ]
        candidate = {'sentences': []}
        for row in rows:
            candidate['sentences'].append({'id': row['id'],
                'chinese': '我不觉得她昨天是认真的。' if row['id'] == 's1' else row['chinese'],
                'sourceConcerns': [],
                'tokens': [{**token, 'coreMeaningZh': '原义', 'pronunciationHint': '/aɪ/'}
                           for token in source_tokens(row)['tokens']],
                'expressions': [{'expressionId': expression['expressionId'],
                                 'pronunciationHint': '/riːd/'} for expression in row['expressions']]})
        expected_candidate = copy.deepcopy(candidate)
        expected_candidate['sentences'][0]['chinese'] = rows[0]['chinese']
        expected_candidate['sentences'][0]['sourceConcerns'] = ['it 的指代需结合前文确认。']
        first_tokens = expected_candidate['sentences'][0]['tokens']
        first_tokens[1].update(coreMeaningZh='不', pronunciationHint='/doʊnt/')
        first_tokens[-1].update(coreMeaningZh='这件事', pronunciationHint='/ɪt/')
        second_tokens = expected_candidate['sentences'][1]['tokens']
        second_tokens[1].update(coreMeaningZh='读过', pronunciationHint='/rɛd/')
        expected_candidate['sentences'][1]['expressions'][0]['pronunciationHint'] = '/rɛd/'
        response = {'schemaVersion': 1, 'reviewedIds': ['s1', 's2'], 'patches': [
            {'id': 's1', 'chinese': rows[0]['chinese'],
             'sourceConcerns': ['it 的指代需结合前文确认。'],
             'tokens': [
                 {'tokenId': first_tokens[1]['tokenId'], 'coreMeaningZh': '不', 'pronunciationHint': '/doʊnt/'},
                 {'tokenId': first_tokens[-1]['tokenId'], 'coreMeaningZh': '这件事', 'pronunciationHint': '/ɪt/'}]},
            {'id': 's2', 'tokens': [
                 {'tokenId': second_tokens[1]['tokenId'], 'coreMeaningZh': '读过', 'pronunciationHint': '/rɛd/'}],
             'expressions': [{'expressionId': 'e2', 'pronunciationHint': '/rɛd/'}]},
        ]}
        self.assertEqual(apply_review(rows, candidate, response),
                         validate_details(rows, expected_candidate))
        self.assertEqual(rows[1]['chinese'], '她昨天读过了。')

    def test_delta_cache_is_separate_but_generation_reused_and_revalidated(self):
        with tempfile.TemporaryDirectory() as cache:
            full = Mock(return_value=(self.candidate, {}))
            complete_details(self.rows, {'detailReviewMode': 'full'}, cache_dir=cache, request=full)
            self.assertEqual(full.call_count, 2)
            delta = Mock(return_value=(self.response, {}))
            result, provenance = complete_details(self.rows, {'detailReviewMode': 'delta'}, cache_dir=cache, request=delta)
            self.assertEqual(delta.call_count, 1)
            self.assertTrue(provenance[0]['cacheReused'])
            self.assertEqual(result[0]['translationAnalysis']['reviewVersion'], REVIEW_VERSION)
            self.assertEqual(len(delta.call_args.args[1]['candidate']['sentences'][0]['tokens']), 3)
            repeated, _ = complete_details(self.rows, {'detailReviewMode': 'delta'}, cache_dir=cache, request=delta)
            self.assertEqual(delta.call_count, 1)
            self.assertEqual(result, repeated)

    def test_review_failure_retries_review_only(self):
        request = Mock(side_effect=[(self.candidate, {}), ({}, {}), (self.response, {})])
        with tempfile.TemporaryDirectory() as cache, patch('ai_tools.time.sleep'):
            complete_details(self.rows, {'detailReviewMode': 'delta'}, cache_dir=cache, request=request)
        self.assertEqual(request.call_count, 3)
        self.assertNotIn('candidate', request.call_args_list[0].args[1])
        self.assertTrue(all('candidate' in c.args[1] for c in request.call_args_list[1:]))


if __name__ == '__main__':
    unittest.main()
