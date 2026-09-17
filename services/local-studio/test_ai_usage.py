import json
import tempfile
import threading
import unittest
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import Mock, patch

from ai_tools import _cached_ai, call_json, retry_ai
from ai_usage import job_usage_config, summarize_usage
from contracts import StudioError
from test_ai_tools import FakeResponse


class UsageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = job_usage_config({'baseUrl': 'https://example.test/v1',
            'apiKey': 'private-key', 'model': 'configured'}, 'job', self.root, 'run')

    def response(self, content='{"ok": true}', finish='stop'):
        return FakeResponse({'model': 'actual-model', 'id': 'req',
            'usage': {'prompt_tokens': 20, 'completion_tokens': 10, 'total_tokens': 30,
                'completion_tokens_details': {'reasoning_tokens': 8}},
            'choices': [{'finish_reason': finish, 'message': {'content': content}}]})

    def summary(self):
        return summarize_usage(self.config['usageLogPath'], 'run')

    def test_success_and_cache_are_not_double_billed(self):
        opener = Mock(side_effect=lambda *a, **k: self.response())
        request = lambda: call_json(self.config, 'private-prompt', {'secretText': 'private-text'}, opener=opener)
        for _ in range(2):
            _cached_ai(self.root, 'stage', 'key', request, lambda x: x, self.config)
        self.assertEqual(opener.call_count, 1)
        report = self.summary()
        self.assertEqual((report['requests'], report['cacheHits']), (1, 1))
        self.assertEqual(report['usage']['totalTokens'], 30)
        self.assertTrue(report['complete'])
        raw = Path(self.config['usageLogPath']).read_text(encoding='utf-8')
        self.assertIn('actual-model', raw)
        for private in ('private-key', 'private-prompt', 'private-text'):
            self.assertNotIn(private, raw)

    def test_failed_outputs_keep_paid_usage(self):
        for response in (self.response('not json'), self.response('{}', 'length')):
            with self.assertRaises(StudioError):
                call_json(self.config, 'json', {}, opener=lambda *a, **k: response)
        report = self.summary()
        self.assertEqual(report['failedRequests'], 2)
        self.assertEqual(report['usage']['totalTokens'], 60)
        self.assertEqual(report['unknownUsageRequests'], 0)

    def test_network_and_http_failures_have_unknown_usage(self):
        for error in (TimeoutError(), urllib.error.HTTPError('https://example.test', 429, 'busy', {}, None)):
            with self.assertRaises(StudioError):
                call_json(self.config, 'json', {}, opener=Mock(side_effect=error))
        self.assertEqual(self.summary()['unknownUsageRequests'], 2)
        self.assertFalse(self.summary()['complete'])

    def test_preflight_and_cancel_do_not_count_as_requests(self):
        cancelled = threading.Event()
        cancelled.set()
        opener = Mock()
        for config in ({**self.config, 'baseUrl': 'http://example.test'},
                       {**self.config, 'cancelled': cancelled}):
            with self.assertRaises(StudioError):
                call_json(config, 'json', {}, opener=opener)
        opener.assert_not_called()
        self.assertEqual(self.summary()['requests'], 0)
        self.assertEqual(self.summary()['preflightFailures'], 2)
        with self.assertRaisesRegex(StudioError, 'JOB_LEASE_LOST_OR_CANCELLED'):
            _cached_ai(self.root, 'stage', 'key', opener, lambda x: x,
                       {**self.config, 'cancelled': cancelled})

    def test_validation_retry_retains_both_attempts(self):
        validator = Mock(side_effect=[StudioError('BAD', 'bad', True), {}])
        opener = Mock(side_effect=lambda *a, **k: self.response())
        with patch('ai_tools.time.sleep'):
            retry_ai(lambda: _cached_ai(self.root, 'stage', 'key',
                lambda: call_json(self.config, 'json', {}, opener=opener), validator, self.config))
        report = self.summary()
        self.assertEqual((report['requests'], report['validationFailures']), (2, 1))
        self.assertEqual(report['usage']['totalTokens'], 60)
        records = [json.loads(s) for s in Path(self.config['usageLogPath']).read_text().splitlines()]
        requests = [r for r in records if r['event'] == 'request']
        self.assertNotEqual(requests[0]['attemptId'], requests[1]['attemptId'])

    def test_parallel_scopes_and_run_filter(self):
        def process(index):
            config = {**self.config, 'runId': str(index)}
            return _cached_ai(self.root, str(index), str(index),
                lambda: call_json(config, 'json', {}, opener=lambda *a, **k: self.response()),
                lambda x: x, config)
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(process, range(8)))
        for i in range(8):
            report = summarize_usage(self.config['usageLogPath'], str(i))
            self.assertEqual(report['requests'], 1)
            self.assertEqual(set(report['stages']), {str(i)})

    def test_logging_failure_does_not_repeat_paid_request(self):
        opener = Mock(side_effect=lambda *a, **k: self.response())
        with patch('ai_usage._write_failures', 0), patch('ai_usage.Path.open', side_effect=OSError()):
            value, _ = retry_ai(lambda: call_json(self.config, 'json', {}, opener=opener))
            self.assertEqual(value, {'ok': True})
            self.assertFalse(self.summary()['complete'])
        self.assertEqual(opener.call_count, 1)

    def test_missing_or_corrupt_ledger_is_not_zero_cost_proof(self):
        self.assertFalse(summarize_usage(self.root / 'absent')['complete'])
        path = self.root / 'broken'
        path.write_text('oops\n' + json.dumps({'event': 'request', 'stage': [], 'usage': []}), encoding='utf-8')
        report = summarize_usage(path)
        self.assertEqual(report['malformedRecords'], 2)
        self.assertFalse(report['complete'])

    def test_truncated_utf8_ledger_does_not_block_processing(self):
        path = Path(self.config['usageLogPath'])
        with path.open('ab') as stream:
            stream.write(b'{"stage":"\xe4\xb8\n')
        call_json(self.config, 'json', {}, opener=lambda *a, **k: self.response())
        report = self.summary()
        self.assertEqual(report['requests'], 1)
        self.assertEqual(report['malformedRecords'], 1)
        self.assertEqual(report['usage']['totalTokens'], 30)
        self.assertFalse(report['complete'])


if __name__ == '__main__':
    unittest.main()
