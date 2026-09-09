import unittest
from contracts import StudioError, strict_json, validate_learning, validate_metadata, validate_transcript


SOURCE = [{'id': 'v:1', 'english': 'I am going to the market.', 'startTime': 0, 'endTime': 3}]
GOOD = {'sentences': [{'id': 'v:1', 'chinese': '我要去市场。', 'keyWords': ['going to'],
                       'expressions': [{'surface': 'going to', 'coreMeaningZh': '将要；打算',
                                       'contextMeaningZh': '这里表示去市场的计划。',
                                       'usageNoteZh': 'be going to 后接动词原形。'}],
                       'grammar': 'be going to 表示计划。'}]}


class Contracts(unittest.TestCase):
    def test_empty_transcript_is_error(self):
        with self.assertRaisesRegex(StudioError, 'ASR_EMPTY'):
            validate_transcript([], 5)

    def test_learning_keeps_source_timing(self):
        result = validate_learning(SOURCE, GOOD)
        self.assertEqual(result[0]['startTime'], 0)
        self.assertEqual(result[0]['reviewStatus'], 'REVIEW')

    def test_hallucinated_phrase_is_error(self):
        wrong = {'sentences': [{**GOOD['sentences'][0], 'keyWords': ['rocket science']}]}
        with self.assertRaisesRegex(StudioError, 'AI_PHRASE_NOT_FOUND'):
            validate_learning(SOURCE, wrong)

    def test_metadata_requires_known_ids(self):
        value = {'titleZh': '日常生活英语记录', 'descriptionZh': '跟着博主完成一天的安排，练习自然的日常表达和跟读。',
                 'level': 'A2', 'topicIds': ['daily'], 'goalMappings': [],
                 'tags': [{'tagId': x, 'sentenceIds': ['v:1'], 'reasonZh': '字幕证据'}
                          for x in ('vlog', 'daily-life', 'spoken-english')]}
        self.assertEqual(validate_metadata(value, {'daily'}, {'general'}, {'v:1'})['level'], 'A2')

    def test_metadata_requires_three_evidence_tags(self):
        value = {'titleZh': '日常生活英语记录', 'descriptionZh': '跟着博主完成一天的安排，练习自然的日常表达和跟读。',
                 'level': 'A2', 'topicIds': ['daily'], 'goalMappings': [], 'tags': []}
        with self.assertRaisesRegex(StudioError, 'AI_TAG_COUNT'):
            validate_metadata(value, {'daily'}, {'general'}, {'v:1'}, {'vlog'})

    def test_invalid_json_is_error(self):
        with self.assertRaisesRegex(StudioError, 'AI_INVALID_JSON'):
            strict_json('not json')


if __name__ == '__main__':
    unittest.main()
