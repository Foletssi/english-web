import copy
import unittest
from segmentation import build_rows, raw_words, segment_transcript, validate_ranges
from contracts import StudioError
from ai_tools import teaching_input


class SegmentationTests(unittest.TestCase):
    def words(self):
        return [{'id': i, 'text': text, 'start': i, 'end': i + .8}
                for i, text in enumerate(["I've", ' been', ' putting', ' off', ' this', ' decision.'])]

    def payload(self, first=0, last=5):
        return {'segmentationVersion': 1, 'segments': [{'firstWordId': first,
                'lastWordId': last, 'boundaryReason': 'sentence_end', 'needsReview': False}],
                'edgeReview': {'start': False, 'end': False}}

    def test_rejects_gaps_repetition_and_context_ranges(self):
        for first, last in [(1, 5), (0, 4), (-1, 5), (0, 6)]:
            with self.subTest(first=first, last=last), self.assertRaises(StudioError):
                validate_ranges(self.words(), self.payload(first, last))
        payload = self.payload()
        payload['segments'] *= 2
        with self.assertRaises(StudioError):
            validate_ranges(self.words(), payload)

    def test_preserves_raw_words_times_and_stable_ids(self):
        rows = build_rows(self.words(), self.payload(), 'v', 6)
        self.assertEqual(rows[0]['english'], "I've been putting off this decision.")
        self.assertEqual(rows[0]['id'], 'v-r1-w0-5')
        self.assertEqual(rows[0]['endTime'], 5.8)
        self.assertEqual(raw_words(rows, 6), self.words())
        shifted = [{**w, 'id': w['id'] + 9} for w in self.words()]
        self.assertEqual(build_rows(shifted, self.payload(9, 14), 'v', 6)[0]['id'], 'v-r1-w9-14')

    def test_speaker_change_cannot_be_merged(self):
        words = self.words()
        words[2]['speakerChangeBefore'] = True
        with self.assertRaises(StudioError):
            validate_ranges(words, self.payload())

    def test_unreliable_alignment_keeps_source_and_flags_review(self):
        rows = build_rows(self.words(), self.payload(), 'v', 6)
        rows[0]['wordTimings'][0]['rawText'] = 'Changed'
        before = copy.deepcopy(rows)
        def forbidden(*args):
            self.fail('unreliable alignment must not call AI')
        result = segment_transcript(rows, 'v', 6, forbidden, lambda *a, **kw: None)
        self.assertEqual(rows, before)
        self.assertEqual(result[0]['english'], before[0]['english'])
        self.assertTrue(result[0]['segmentationNeedsReview'])

    def test_all_window_seams_are_reviewed(self):
        rows = build_rows(self.words(), self.payload(), 'v', 6)
        calls = []
        def request(name, payload, validator):
            calls.append(name)
            words = payload['words']
            return validator(self.payload(words[0]['id'], words[-1]['id']))
        result = segment_transcript(rows, 'v', 6, request, lambda *a, **kw: None, window_size=2)
        self.assertEqual(calls, ['segments-0000', 'segments-0001', 'seam-0001', 'segments-0002', 'seam-0002'])
        self.assertEqual(result[0]['english'], rows[0]['english'])
        self.assertEqual(raw_words(result, 6), self.words())

    def test_completed_empty_selection_is_locked_only_for_fill(self):
        row = {'id': 'v-1', 'english': 'We love you.', 'keyWords': [],
               'teachingAnalysis': {'status': 'completed'}}
        self.assertTrue(teaching_input([row], 0, [row], 'fill_missing')['sentences'][0]['selectionLocked'])
        self.assertFalse(teaching_input([row], 0, [row], 'reextract')['sentences'][0]['selectionLocked'])
        self.assertEqual(row['keyWords'], [])


if __name__ == '__main__':
    unittest.main()
