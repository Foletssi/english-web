import unittest
from contracts import StudioError, strict_json, validate_learning, validate_metadata, validate_transcript, validate_difficulty


SOURCE = [{'id': 'v:1', 'english': 'I am going to the market.', 'startTime': 0, 'endTime': 3}]
GOOD = {'teachingSchemaVersion': 3, 'sentences': [{'id': 'v:1', 'chinese': '我要去市场。', 'keyWords': ['going to'],
                       'expressions': [{'surface': 'going to', 'coreMeaningZh': '将要；打算',
                                       'contextMeaningZh': '这里表示去市场的计划。',
                                       'usageNoteZh': 'be going to 后接动词原形。',
                                       'lemma': 'be going to', 'expressionType': 'pattern',
                                       'selectionReasonZh': '可迁移的计划表达。', 'needsReview': False}],
                       'grammar': 'be going to 表示计划。'}]}


class Contracts(unittest.TestCase):
    def test_all_supported_difficulty_tracks_require_evidence(self):
        for track in ('gaokao', 'zsb', 'cet4', 'cet6', 'tem4', 'tem8', 'ielts', 'toefl'):
            value = {'primaryTrack': track, 'targetTracks': [track],
                     'evidence': [{'sentenceIds': ['v:1'], 'reasonZh': '原句依据'}]}
            with self.subTest(track=track):
                self.assertEqual(validate_difficulty(value, {'v:1'})['primaryTrack'], track)
        with self.assertRaises(StudioError):
            validate_difficulty({**value, 'primaryTrack': 'invented', 'targetTracks': ['invented']}, {'v:1'})

    def test_difficulty_requires_explicit_result_and_real_evidence(self):
        valid = {'primaryTrack': 'cet6', 'targetTracks': ['cet6'],
                 'evidence': [{'sentenceIds': ['v:1'], 'reasonZh': '结合原句义项与结构审核。'}]}
        self.assertEqual(validate_difficulty(valid, {'v:1'})['reviewStatus'], 'approved')
        for invalid in ({}, {'difficulty': valid}, {**valid, 'targetTracks': ['cet4']},
                        {**valid, 'evidence': []},
                        {**valid, 'evidence': [{'sentenceIds': ['unknown'], 'reasonZh': '依据'}]},
                        {**valid, 'evidence': [{'sentenceIds': ['v:1'], 'reasonZh': None}]}):
            with self.subTest(invalid=invalid), self.assertRaises(StudioError):
                validate_difficulty(invalid, {'v:1'})
        self.assertIsNone(validate_difficulty(None, {'v:1'}))
        self.assertIsNone(validate_difficulty({'primaryTrack': None, 'targetTracks': [], 'evidence': []}, {'v:1'})['primaryTrack'])

    def test_empty_transcript_is_error(self):
        with self.assertRaisesRegex(StudioError, 'ASR_EMPTY'):
            validate_transcript([], 5)

    def test_learning_keeps_source_timing(self):
        result = validate_learning(SOURCE, GOOD)
        self.assertEqual(result[0]['startTime'], 0)
        self.assertEqual(result[0]['reviewStatus'], 'REVIEW')

    def test_teaching_v3_requires_professional_selection_fields(self):
        value = {'teachingSchemaVersion': 3, 'sentences': [{
            **GOOD['sentences'][0], 'expressions': [{
                **GOOD['sentences'][0]['expressions'][0], 'lemma': 'be going to',
                'expressionType': 'pattern', 'selectionReasonZh': '常用计划表达，能够迁移使用。',
                'needsReview': False}]}]}
        result = validate_learning(SOURCE, value)
        self.assertEqual(result[0]['learningContractVersion'], 5)
        self.assertEqual(result[0]['expressions'][0]['lemma'], 'be going to')

        missing_expression = {key: value for key, value in GOOD['sentences'][0]['expressions'][0].items() if key != 'expressionType'}
        missing = {'teachingSchemaVersion': 3, 'sentences': [{**GOOD['sentences'][0], 'expressions': [missing_expression]}]}
        with self.assertRaisesRegex(StudioError, 'AI_EXPRESSION_TYPE'):
            validate_learning(SOURCE, missing)

    def test_missing_teaching_version_cannot_downgrade_validation(self):
        missing_version = {key: value for key, value in GOOD.items() if key != 'teachingSchemaVersion'}
        with self.assertRaisesRegex(StudioError, 'AI_TEACHING_SCHEMA'):
            validate_learning(SOURCE, missing_version)

    def test_hallucinated_phrase_is_error(self):
        wrong = {'teachingSchemaVersion': 3, 'sentences': [{**GOOD['sentences'][0], 'keyWords': ['rocket science'], 'expressions': [{**GOOD['sentences'][0]['expressions'][0], 'surface': 'rocket science'}]}]}
        with self.assertRaisesRegex(StudioError, 'AI_PHRASE_NOT_FOUND'):
            validate_learning(SOURCE, wrong)

    def test_metadata_requires_known_ids(self):
        value = {'titleZh': '日常生活英语记录', 'descriptionZh': '跟着博主完成一天的安排，练习自然的日常表达和跟读。',
                 'level': 'A2', 'topicIds': ['daily'], 'goalMappings': [],
                 'tags': [{'tagId': x, 'sentenceIds': ['v:1'], 'reasonZh': '字幕证据'}
                          for x in ('vlog', 'daily-life', 'spoken-english')]}
        self.assertEqual(validate_metadata(value, {'daily'}, {'general'}, {'v:1'})['level'], 'A2')

    def test_metadata_requires_at_least_one_evidence_tag(self):
        value = {'titleZh': '日常生活英语记录', 'descriptionZh': '跟着博主完成一天的安排，练习自然的日常表达和跟读。',
                 'level': 'A2', 'topicIds': ['daily'], 'goalMappings': [], 'tags': []}
        with self.assertRaisesRegex(StudioError, 'AI_TAG_COUNT'):
            validate_metadata(value, {'daily'}, {'general'}, {'v:1'}, {'daily-life'})

    def test_metadata_allows_one_or_two_evidence_tags(self):
        base = {'titleZh': '日常生活英语记录', 'descriptionZh': '跟着博主完成一天的安排，练习自然的日常表达和跟读。',
                'level': 'A2', 'topicIds': ['daily'], 'goalMappings': []}
        for ids in (('daily-life',), ('daily-life', 'spoken-english')):
            value = {**base, 'tags': [{'tagId': tag, 'sentenceIds': ['v:1'], 'reasonZh': '字幕证据'} for tag in ids]}
            self.assertEqual(validate_metadata(value, {'daily'}, {'general'}, {'v:1'}, set(ids))['tagIds'], list(ids))

    def test_invalid_json_is_error(self):
        with self.assertRaisesRegex(StudioError, 'AI_INVALID_JSON'):
            strict_json('not json')


if __name__ == '__main__':
    unittest.main()
