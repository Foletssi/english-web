import copy
import tempfile
import unittest

from contracts import StudioError
from teaching_coverage import complete_coverage, COVERAGE_REVIEW_PROMPT


def rows(count):
    return [{'id': f's{i}', 'english': 'We can persevere.', 'chinese': '我们能坚持下去。',
             'grammar': '', 'keyWords': [], 'expressions': [], 'textRevision': 2,
             'startTime': i, 'endTime': i + 1} for i in range(count)]


def highlight(row):
    row['keyWords'] = ['persevere']
    row['expressions'] = [{'surface': 'persevere', 'lemma': 'persevere',
        'expressionType': 'word', 'coreMeaningZh': '坚持不懈', 'contextMeaningZh': '坚持下去',
        'usageNoteZh': '', 'selectionReasonZh': '进阶动词，强调克服困难继续努力',
        'needsReview': False}]


class CoverageTests(unittest.TestCase):
    def answer(self, prompt, payload):
        result = {'teachingSchemaVersion': 3, 'sentences': copy.deepcopy(payload['sentences'])}
        if payload.get('pairs'):
            result['decisions'] = [{'pairId': p['pairId'], 'status': 'no_eligible_source',
                                   'reasonZh': '本句没有漏掉的合格原文表达。'} for p in payload['pairs']]
        return result, {'model': 'fixture'}

    def test_every_overlapping_pair_including_batch_edges_and_cache(self):
        calls = []
        def request(prompt, payload):
            calls.append((prompt, copy.deepcopy(payload)))
            return self.answer(prompt, payload)
        original = rows(35)
        with tempfile.TemporaryDirectory() as cache:
            checked, provenance = complete_coverage(original, cache_dir=cache, request=request)
            count = len(calls)
            complete_coverage(original, cache_dir=cache, request=request)
            self.assertEqual(len(calls), count)
        self.assertNotIn('coverageAnalysis', original[0])
        reports = {}
        for row in checked:
            for report in row['coverageAnalysis']['pairs']:
                if report['pairId'] in reports:
                    self.assertEqual(reports[report['pairId']], report)
                reports[report['pairId']] = report
        self.assertEqual(set(reports), {f'p{i}' for i in range(34)})
        review_pairs = [p['pairId'] for prompt, payload in calls if prompt == COVERAGE_REVIEW_PROMPT
                        for p in payload['pairs']]
        self.assertCountEqual(review_pairs, reports)
        self.assertTrue(all(r['status'] == 'no_eligible_source' for r in reports.values()))
        self.assertTrue(all('reviewVersion' in r['teachingAnalysis'] for r in checked))

    def test_review_added_highlight_updates_neighbor_report(self):
        def request(prompt, payload):
            result, meta = self.answer(prompt, payload)
            if prompt == COVERAGE_REVIEW_PROMPT and payload['pairs'][0]['pairId'] == 'p1':
                highlight(result['sentences'][0])
                result['decisions'][0]['status'] = 'covered'
            return result, meta
        checked, _ = complete_coverage(rows(3), request=request)
        self.assertEqual(checked[0]['coverageAnalysis']['pairs'][0]['status'], 'covered')
        self.assertEqual(checked[1]['keyWords'], ['persevere'])

    def test_locked_empty_and_manual_meaning_are_preserved(self):
        original = rows(2)
        for row in original:
            row.update(selectionLocked=True, selectionSource='manual', translationLocked=True)
        def request(prompt, payload):
            result, meta = self.answer(prompt, payload)
            for row in result['sentences']:
                row['chinese'] = '错误的自动译文'
            for decision in result.get('decisions', []):
                decision['status'] = 'locked'
            return result, meta
        checked, _ = complete_coverage(original, request=request)
        self.assertEqual(checked[0]['chinese'], original[0]['chinese'])
        self.assertEqual(checked[0]['keyWords'], [])
        self.assertEqual(checked[0]['coverageAnalysis']['pairs'][0]['status'], 'locked')
        highlight(original[0])
        original[0]['expressions'][0]['reviewStatus'] = 'APPROVED'
        checked, _ = complete_coverage(original, request=self.answer)
        self.assertEqual(checked[0]['expressions'], original[0]['expressions'])

    def test_malformed_decision_retries_exactly_twice(self):
        count = [0]
        def request(prompt, payload):
            result, meta = self.answer(prompt, payload)
            if payload.get('pairs'):
                count[0] += 1
                result['decisions'][0]['pairId'] = []
            return result, meta
        with self.assertRaises(StudioError):
            complete_coverage(rows(2), request=request)
        self.assertEqual(count[0], 3)

    def test_single_sentence_has_no_fake_pair(self):
        checked, _ = complete_coverage(rows(1), request=self.answer)
        self.assertEqual(checked[0]['coverageAnalysis']['pairs'], [])


if __name__ == '__main__':
    unittest.main()
