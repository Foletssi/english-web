import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from contracts import StudioError
from teaching_details import complete_details, finalize_source_status, source_tokens, validate_details


class TeachingDetailsTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{'id': 'one', 'english': '🙂 I read my friend’s well-known book.',
                      'chinese': '人工译文', 'translationLocked': True, 'textRevision': 3,
                      'startTime': 1, 'endTime': 3, 'expressions': [], 'keyWords': []}]

    def candidate(self):
        return {'sentences': [{'id': r['id'], 'chinese': '自动译文', 'sourceConcerns': [],
            'tokens': [{**t, 'coreMeaningZh': '本句义', 'pronunciationHint': '/riːd/'}
                       for t in source_tokens(r)['tokens']]} for r in self.rows]}

    def test_exact_tokens_lock_and_source_immutable(self):
        before = copy.deepcopy(self.rows)
        result = validate_details(self.rows, self.candidate())
        self.assertEqual(self.rows, before)
        self.assertEqual(result[0]['chinese'], '人工译文')
        self.assertEqual(result[0]['wordLookup']['tokens'][0]['start'], 3)
        self.assertEqual(result[0]['wordLookup']['tokens'][-2]['surface'], 'well-known')
        self.assertEqual(result[0]['textRevision'], 3)

    def test_malformed_ids_and_missing_token_are_retryable(self):
        for field in ('id', 'tokenId', 'coverage', 'placeholder'):
            bad = self.candidate()
            if field == 'id': bad['sentences'][0]['id'] = []
            elif field == 'tokenId': bad['sentences'][0]['tokens'][0]['tokenId'] = {}
            elif field == 'coverage': bad['sentences'][0]['tokens'].pop()
            else: bad['sentences'][0]['tokens'][0]['coreMeaningZh'] = '释义待生成'
            with self.assertRaises(StudioError) as caught:
                validate_details(self.rows, bad)
            self.assertTrue(caught.exception.retryable)

    def test_independent_review_and_environment_cache_identity(self):
        calls = []
        def request(prompt, payload):
            calls.append(copy.deepcopy(payload))
            result = self.candidate()
            if 'candidate' in payload:
                result['sentences'][0]['tokens'][0]['coreMeaningZh'] = '独立核对义'
            return result, {'model': 'fixture'}
        with tempfile.TemporaryDirectory() as cache:
            with patch.dict(os.environ, {'ZOSPEAK_AI_MODEL': 'one'}):
                result, provenance = complete_details(self.rows, cache_dir=cache, request=request)
                self.assertEqual(len(calls), 2)
                self.assertIn('candidate', calls[1])
                self.assertEqual(result[0]['wordLookup']['tokens'][0]['coreMeaningZh'], '独立核对义')
                complete_details(self.rows, cache_dir=cache, request=request)
                self.assertEqual(len(calls), 2)
            with patch.dict(os.environ, {'ZOSPEAK_AI_MODEL': 'two'}):
                complete_details(self.rows, cache_dir=cache, request=request)
                self.assertEqual(len(calls), 4)

    def test_expression_hint_changes_only_pronunciation(self):
        self.rows[0]['expressions'] = [{'surface': 'read my friend’s well-known book',
            'coreMeaningZh': '读朋友的那本名著', 'reviewStatus': 'APPROVED', 'type': 'phrase'}]
        before = copy.deepcopy(self.rows)
        candidate = self.candidate()
        candidate['sentences'][0]['expressions'] = [{'expressionId': 'e0',
            'pronunciationHint': '/riːd maɪ fɹɛndz wɛl noʊn bʊk/',
            'surface': 'malicious change', 'reviewStatus': 'REJECTED'}]
        result = validate_details(self.rows, candidate)
        actual = result[0]['expressions'][0]
        self.assertEqual(self.rows, before)
        self.assertEqual({k: v for k, v in actual.items() if k != 'pronunciationHint'},
                         before[0]['expressions'][0])
        for hint in ('', '/riːd/ or /rɛd/', 'present tense', '/中文/'):
            candidate['sentences'][0]['expressions'][0]['pronunciationHint'] = hint
            with self.assertRaises(StudioError): validate_details(self.rows, candidate)

    def test_every_token_requires_single_ipa_and_retries_at_most_three(self):
        candidate = self.candidate()
        candidate['sentences'][0]['tokens'][0]['pronunciationHint'] = ''
        with self.assertRaises(StudioError): validate_details(self.rows, candidate)
        calls = []
        def request(prompt, payload):
            calls.append(payload)
            return candidate, {}
        with patch.dict(os.environ, {'EASTUDY_AI_ATTEMPTS': '20'}), patch('ai_tools.time.sleep'):
            with self.assertRaises(StudioError): complete_details(self.rows, request=request)
        self.assertEqual(len(calls), 3)

    def test_dictionary_ipa_accepts_common_non_ascii_sounds(self):
        candidate = self.candidate()
        candidate['sentences'][0]['tokens'][0]['pronunciationHint'] = '/ðæt θɪŋ/'
        result = validate_details(self.rows, candidate)
        self.assertEqual(result[0]['wordLookup']['tokens'][0]['pronunciationHint'], '/ðæt θɪŋ/')

    def test_source_concern_retains_source_and_reliable_teaching(self):
        candidate = self.candidate()
        candidate['sentences'][0]['sourceConcerns'] = ['句子可能存在转录漏词，不能根据文本确定。']
        result, _ = complete_details(self.rows, request=lambda *_: (candidate, {}))
        row = result[0]
        self.assertEqual(row['translationAnalysis']['status'], 'source_unresolved')
        self.assertEqual(row['translationAnalysis']['translationOrigin'], 'retained_source')
        self.assertEqual(row['chinese'], '人工译文')
        self.assertEqual(row['english'], self.rows[0]['english'])
        self.assertEqual(len(row['wordLookup']['tokens']), len(source_tokens(self.rows[0])['tokens']))
        self.assertEqual(finalize_source_status(result, self.rows), result)

    def test_source_concern_without_prior_chinese_is_explicit_candidate(self):
        self.rows[0].update(chinese='', translationLocked=False)
        candidate = self.candidate()
        candidate['sentences'][0]['sourceConcerns'] = ['疑似音频转录问题。']
        result, _ = complete_details(self.rows, request=lambda *_: (candidate, {}))
        self.assertEqual(result[0]['chinese'], '自动译文')
        self.assertEqual(result[0]['translationAnalysis']['status'], 'source_unresolved')
        self.assertEqual(result[0]['translationAnalysis']['translationOrigin'], 'reviewed_candidate')

    def test_finalizer_rejects_mismatched_source_and_no_concerns_completes(self):
        result = validate_details(self.rows, self.candidate())
        clean = finalize_source_status(result, self.rows)
        self.assertEqual(clean[0]['translationAnalysis']['status'], 'completed')
        self.assertNotIn('translationOrigin', clean[0]['translationAnalysis'])
        for field, value in [('english', 'Different'), ('textRevision', 4), ('startTime', 2)]:
            bad = copy.deepcopy(self.rows)
            bad[0][field] = value
            with self.assertRaises(StudioError): finalize_source_status(result, bad)
        with self.assertRaises(StudioError): finalize_source_status(result, [])

    def test_candidate_finalizer_separate_output_preserves_provenance_and_locks(self):
        candidates = validate_details(self.rows, self.candidate())
        candidates[0]['translationAnalysis'].update(status='completed', sourceConcerns=['原文疑似漏词。'])
        source = {'sentences': copy.deepcopy(self.rows), 'draftSentences': copy.deepcopy(self.rows)}
        source['sentences'][0].update(chinese='先前译文', translationLocked=False)
        candidate = {'sentences': candidates, 'provenance': [{'model': 'fixture'}]}
        script = Path(__file__).resolve().parents[2] / 'scripts/finalize-teaching-source-status.py'
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / name for name in ('source.json', 'candidates.json', 'finalized.json')]
            for path, value in zip(paths, (source, candidate)):
                path.write_text(json.dumps(value), encoding='utf-8')
            command = [sys.executable, str(script), '--source', str(paths[0]), '--candidates', str(paths[1]), '--output', str(paths[2])]
            first = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(first.returncode, 0, first.stderr)
            result = json.loads(paths[2].read_text(encoding='utf-8'))
            self.assertEqual(result['sentences'][0]['chinese'], '人工译文')
            self.assertEqual(result['provenance'], candidate['provenance'])
            self.assertEqual(json.loads(paths[1].read_text(encoding='utf-8')), candidate)
            self.assertEqual(json.loads(first.stdout)['sourceUnresolved'], 1)
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


if __name__ == '__main__': unittest.main()
