import copy
import unittest

from contracts import StudioError
from teaching_contract import validate_completed_teaching


def fixture():
    return {'id': 'sentence-1', 'english': 'Read this', 'chinese': '读一下这个。',
        'textRevision': 1, 'expressions': [],
        'wordLookup': {'schemaVersion': 1, 'sourceTextRevision': 1, 'sourceEnglish': 'Read this',
            'tokens': [
                {'tokenId': 't0', 'surface': 'Read', 'start': 0, 'end': 4,
                 'coreMeaningZh': '阅读', 'pronunciationHint': '/riːd/'},
                {'tokenId': 't1', 'surface': 'this', 'start': 5, 'end': 9,
                 'coreMeaningZh': '这个', 'pronunciationHint': '/ðɪs/'}]},
        'translationAnalysis': {'status': 'completed', 'promptVersion': 'context-lookup-v3-20260919',
            'reviewVersion': 'context-delta-review-v3-20260919', 'sourceTextRevision': 1,
            'sourceConcerns': []},
        'coverageAnalysis': {'schemaVersion': 1, 'status': 'completed',
            'promptVersion': 'adjacent-coverage-v2-20260916',
            'reviewVersion': 'adult-selection-review-v2-20260916',
            'sourceTextRevision': 1, 'pairs': []},
        'teachingAnalysis': {'reviewVersion': 'adult-selection-review-v2-20260916'}}


class TeachingContractTests(unittest.TestCase):
    def test_accepts_delta_review_contract(self):
        row = fixture()
        self.assertIs(validate_completed_teaching([row])[0], row)

    def test_reports_sentence_and_field_for_contract_drift(self):
        row = copy.deepcopy(fixture())
        row['translationAnalysis']['reviewVersion'] = 'unknown-review'
        with self.assertRaises(StudioError) as caught:
            validate_completed_teaching([row])
        self.assertEqual(caught.exception.code, 'TEACHING_DETAILS_INVALID')
        self.assertIn('sentence-1', caught.exception.message)
        self.assertIn('translationAnalysis.reviewVersion', caught.exception.message)


if __name__ == '__main__':
    unittest.main()
