import json
import io
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

    def test_models_without_selected_model_and_no_save_authorization(self):
        calls = []
        def opener(request, **kwargs):
            calls.append(request)
            return io.BytesIO(json.dumps({'data': [{'id': 'z-model'}, {'id': 'a-model'},
                {'id': 'a-model'}, {'id': 'bad\nmodel'}, {'id': 'old-secret'}, {'id': 3}, None]}).encode())
        result = self.store.models({**self.value, 'model': ''}, opener)
        self.assertEqual(result, {'models': ['a-model', 'z-model'], 'baseUrl': 'https://old.example/v1'})
        self.assertEqual(calls[0].full_url, 'https://old.example/v1/models')
        self.assertEqual(calls[0].get_method(), 'GET')
        self.assertEqual(calls[0].get_header('Authorization'), 'Bearer old-secret')
        self.assertEqual(self.store.verified, {})
        self.assertFalse(self.store.path.exists())
        with self.assertRaisesRegex(SettingsError, 'AI_MODEL_INVALID'):
            self.store.candidate({**self.value, 'model': ''})

    def test_models_paths_and_endpoint_key_binding(self):
        for base, expected in [('https://new.example', 'https://new.example/models'),
                               ('https://new.example/v1/', 'https://new.example/v1/models'),
                               ('https://new.example/v1/chat/completions', 'https://new.example/v1/models')]:
            def opener(request, **kwargs):
                self.assertEqual(request.full_url, expected)
                self.assertEqual(request.get_header('Authorization'), 'Bearer new-secret')
                return io.BytesIO(b'{"data":[{"id":"test"}]}')
            self.store.models({**self.value, 'baseUrl': base, 'apiKey': 'new-secret'}, opener)
        with self.assertRaisesRegex(SettingsError, 'NEW_ENDPOINT_REQUIRES_KEY'):
            self.store.models({**self.value, 'baseUrl': 'https://new.example'})
        with self.assertRaisesRegex(SettingsError, 'SETTINGS_CHANGED'):
            self.store.models({**self.value, 'revision': 99})

    def test_models_provider_errors_are_safe_and_actionable(self):
        for status, code in [(401, 'AI_MODELS_AUTH'), (403, 'AI_MODELS_AUTH'),
                             (404, 'AI_MODELS_UNSUPPORTED'), (429, 'AI_MODELS_RATE_LIMIT'),
                             (500, 'AI_MODELS_HTTP_ERROR'), (302, 'AI_MODELS_HTTP_ERROR')]:
            def opener(request, **kwargs):
                raise urllib.error.HTTPError(request.full_url, status, 'old-secret', {}, io.BytesIO(b'old-secret'))
            with self.subTest(status=status), self.assertRaisesRegex(SettingsError, '^' + code + '$'):
                self.store.models(self.value, opener)

    @unittest.skipUnless(os.name == 'nt', 'Windows user encryption')
    def test_provider_root_discovery_test_and_save_share_normalized_address(self):
        value = {**self.value, 'baseUrl': 'https://api.x5m5x.com', 'apiKey': 'new-secret'}
        def opener(request, **kwargs):
            self.assertEqual(request.full_url, 'https://api.x5m5x.com/v1/models')
            return io.BytesIO(b'{"data":[{"id":"test"}]}')
        listed = self.store.models(value, opener)
        self.assertEqual(listed['baseUrl'], 'https://api.x5m5x.com/v1')
        configs = []
        def request(config, *args, **kwargs):
            configs.append(config)
            return self.request()
        tested = self.store.test(value, request)
        self.assertEqual(len(configs), 2)
        self.assertTrue(all(c['baseUrl'] == listed['baseUrl'] for c in configs))
        saved = self.store.save({**value, 'baseUrl': tested['baseUrl'], 'testId': tested['testId']})
        self.assertEqual(saved['baseUrl'], listed['baseUrl'])
        self.assertEqual(self.store.candidate({**saved, 'baseUrl': value['baseUrl'], 'apiKey': ''})['apiKey'], 'new-secret')
        with self.assertRaisesRegex(SettingsError, 'NEW_ENDPOINT_REQUIRES_KEY'):
            self.store.candidate({**saved, 'baseUrl': 'https://other.example/v1', 'apiKey': ''})

    def test_models_reject_invalid_empty_and_oversized_responses(self):
        for body, code in [(b'<html>error</html>', 'AI_MODELS_INVALID'), (b'[]', 'AI_MODELS_INVALID'),
                           (b'{"data":[]}', 'AI_MODELS_EMPTY'), (b'x' * (2 * 1024 * 1024 + 1), 'AI_MODELS_INVALID')]:
            with self.subTest(code=code), self.assertRaisesRegex(SettingsError, code):
                self.store.models(self.value, lambda *a, **k: io.BytesIO(body))

    def test_models_does_not_forward_credentials_on_redirect(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading
        paths = []
        class RedirectHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                paths.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/credential-sink')
                self.end_headers()
        server = ThreadingHTTPServer(('127.0.0.1', 0), RedirectHandler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with self.assertRaisesRegex(SettingsError, 'AI_MODELS_HTTP_ERROR'):
            self.store.models({**self.value, 'baseUrl': f'http://127.0.0.1:{server.server_port}', 'apiKey': 'new-secret'})
        self.assertEqual(paths, ['/models'])

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
        with patch.object(self.store, 'models', return_value={'models': ['test-model']}) as models:
            for changed in ({'Origin': 'https://evil.example'}, {'Authorization': 'Bearer invalid'}, {'Host': 'evil.example'}):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(urllib.request.Request(url + '/models', data=b'{}', headers={**headers, **changed}))
                self.assertEqual(error.exception.code, 403)
            models.assert_not_called()
            with urllib.request.urlopen(urllib.request.Request(url + '/models', data=json.dumps(self.value).encode(), headers=headers)) as response:
                self.assertEqual(json.load(response), {'models': ['test-model']})
            models.assert_called_once_with(self.value)
        from contracts import StudioError
        for code in ['AI_ENDPOINT_HTML', 'AI_RESPONSE_INVALID', 'AI_NETWORK_ERROR']:
            with patch.object(self.store, 'test', side_effect=StudioError(code, 'private-provider-body')):
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(urllib.request.Request(url + '/test', data=b'{}', headers=headers))
                self.assertEqual(error.exception.code, 502)
                self.assertEqual(json.load(error.exception), {'error': code})


if __name__ == '__main__':
    unittest.main()
