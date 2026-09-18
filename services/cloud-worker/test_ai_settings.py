import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local-studio'))
from ai_settings import SettingsStore, SettingsError, SAMPLES, dpapi, start_ai_settings, authorize_admin


class SettingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = SettingsStore(Path(self.temp.name) / 'settings.json')
        self.env = patch.dict(os.environ, {'ZOSPEAK_AI_BASE_URL': 'https://old.example/v1',
            'ZOSPEAK_AI_MODEL': 'model', 'ZOSPEAK_AI_API_KEY': 'old-secret', 'EASTUDY_AI_THINKING': 'disabled'})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.value = {**self.store.public(), 'apiKey': ''}

    @staticmethod
    def request(*args, **kwargs):
        return {'sentences': [{'id': row['id'], 'chinese': '完整的中文翻译', 'meaningZh': '语境词义'}
                             for row in SAMPLES]}, {'model': 'fixture'}

    def test_secret_not_returned_and_environment_not_changed(self):
        self.assertNotIn('old-secret', json.dumps(self.store.public()))
        self.assertTrue(self.store.public()['hasApiKey'])
        self.assertEqual(self.store.candidate(self.value)['apiKey'], 'old-secret')
        self.assertEqual(os.environ['ZOSPEAK_AI_API_KEY'], 'old-secret')

    def test_endpoint_change_needs_new_key(self):
        with self.assertRaisesRegex(SettingsError, 'NEW_ENDPOINT_REQUIRES_KEY'):
            self.store.candidate({**self.value, 'baseUrl': 'https://new.example/v1'})

    def test_invalid_urls_rejected(self):
        for url in ['http://remote.test', 'https://user:secret@remote.test', 'https://x.test?key=s',
                    'https://x.test/#secret', 'https://', 'file://localhost/tmp', 'https://a.test:bad',
                    'https://a.test/\nheader']:
            with self.subTest(url=url), self.assertRaisesRegex(SettingsError, 'AI_URL_INVALID'):
                self.store.candidate({**self.value, 'baseUrl': url, 'apiKey': 'new-secret'})

    def test_test_must_match_exact_saved_config(self):
        tested = self.store.test(self.value, self.request)
        with self.assertRaisesRegex(SettingsError, 'TEST_REQUIRED'):
            self.store.save({**self.value, 'testId': tested['testId'], 'model': 'other'})
        with self.assertRaisesRegex(SettingsError, 'TEST_REQUIRED'):
            self.store.save({**self.value, 'testId': 'forged'})

    @unittest.skipUnless(os.name == 'nt', 'Windows user encryption')
    def test_save_encrypted_reload_and_snapshot_isolation(self):
        old = self.store.snapshot()
        candidate = {**self.value, 'baseUrl': 'https://new.example/v1', 'apiKey': 'replacement-secret', 'thinkingMode': 'auto'}
        tested = self.store.test(candidate, self.request)
        public = self.store.save({**candidate, 'testId': tested['testId']})
        self.assertEqual(public['revision'], 1)
        self.assertNotIn('replacement-secret', self.store.path.read_text())
        self.assertNotIn('apiKey', public)
        self.assertEqual(SettingsStore(self.store.path).snapshot()['apiKey'], 'replacement-secret')
        self.assertEqual(old['apiKey'], 'old-secret')
        with self.assertRaisesRegex(SettingsError, 'SETTINGS_CHANGED'):
            self.store.save({**candidate, 'testId': tested['testId']})

    @unittest.skipUnless(os.name == 'nt', 'Windows user encryption')
    def test_dpapi_roundtrip(self):
        encrypted = dpapi(b'synthetic-test-key')
        self.assertNotIn(b'synthetic-test-key', encrypted)
        self.assertEqual(dpapi(encrypted, decrypt=True), b'synthetic-test-key')

    def test_incomplete_or_nonchinese_samples_fail(self):
        for result in ({'sentences': []}, {'sentences': [{'id': row['id'], 'chinese': 'English', 'meaningZh': 'wrong'} for row in SAMPLES]}):
            with self.assertRaisesRegex(SettingsError, 'AI_SAMPLE_INVALID'):
                self.store.test(self.value, lambda *a, **k: (result, {}))
        self.assertEqual(self.store.verified, {})

    def test_independent_review_required(self):
        calls = []
        def request(*args, **kwargs):
            calls.append(args)
            return self.request()
        self.store.test(self.value, request)
        self.assertEqual(len(calls), 2)
        self.assertIn('candidate', calls[1][2])

    def test_authorization_requires_server_verified_admin(self):
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'false'
        with patch('ai_settings.urllib.request.urlopen', return_value=response):
            with self.assertRaisesRegex(SettingsError, 'ADMIN_REQUIRED'):
                authorize_admin('valid-but-nonadmin-jwt')
        response.__enter__.return_value.read.return_value = b'true'
        with patch('ai_settings.urllib.request.urlopen', return_value=response) as call:
            authorize_admin('admin-jwt')
            self.assertEqual(call.call_args.args[0].get_header('Authorization'), 'Bearer admin-jwt')

    def test_http_origin_host_auth_and_no_secret(self):
        def authorize(token):
            if token != 'admin-jwt':
                raise SettingsError('ADMIN_REQUIRED')
        server = start_ai_settings(self.store, port=0, authorize=authorize)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f'http://127.0.0.1:{server.server_port}/v1/ai-settings'
        headers = {'Origin': 'https://english-web-lce.pages.dev', 'Authorization': 'Bearer admin-jwt'}
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers)) as response:
            raw = response.read()
            self.assertNotIn(b'old-secret', raw)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
        for changed in ({'Origin': 'https://evil.example'}, {'Authorization': 'Bearer invalid'}, {'Host': 'evil.example'}):
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(url, headers={**headers, **changed}))
            self.assertEqual(error.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
