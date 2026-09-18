"""Admin-authorized, loopback AI configuration with Windows user-bound secrets."""
import base64
import ctypes
import hashlib
import http.client
import json
import os
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from ai_tools import call_json, _open_api, normalize_api_base
from checkpoint import atomic_json
from local_intake_v2 import ORIGINS

AUTH_URL = 'https://ehxqtgakjgqgmghhdmjg.supabase.co/rest/v1/rpc/is_admin'
PUBLIC_KEY = 'sb_publishable_74G1tE79krJiq5P6DWHhZQ_QZkk6tdy'
SAMPLES = [
    {'id': 'meet', 'english': "I'm going to see her at the cafe. She works there; we're not dating.", 'word': 'see'},
    {'id': 'hardware', 'english': "The bag's gold hardware matches its leather strap.", 'word': 'hardware'},
    {'id': 'secret', 'english': "I won't spill the beans about the surprise party.", 'word': 'spill the beans'}]


class SettingsError(ValueError):
    pass


def dpapi(data, decrypt=False):
    if os.name != 'nt':
        raise SettingsError('ENCRYPTION_UNAVAILABLE')
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    operation = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    operation.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not operation(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise SettingsError('ENCRYPTION_UNAVAILABLE')
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


def validate_config(value, require_model=True):
    result = {k: str(value.get(k) or '').strip() for k in ('baseUrl', 'model', 'apiKey', 'thinkingMode')}
    result['baseUrl'] = result['baseUrl'].rstrip('/')
    try:
        url = urlsplit(result['baseUrl'])
        port = url.port
    except ValueError:
        raise SettingsError('AI_URL_INVALID') from None
    if (not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment
            or len(result['baseUrl']) > 2048 or any(c.isspace() for c in result['baseUrl'])
            or (url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in {'localhost', '127.0.0.1'}))):
        raise SettingsError('AI_URL_INVALID')
    for key, limit in [('model', 200), ('apiKey', 4096)]:
        if key == 'model' and not require_model:
            continue
        if not result[key] or len(result[key]) > limit or any(ord(c) < 32 or ord(c) == 127 for c in result[key]):
            raise SettingsError('AI_' + key.upper() + '_INVALID')
    if result['thinkingMode'] not in {'auto', 'enabled', 'disabled'}:
        raise SettingsError('AI_THINKING_MODE_INVALID')
    result['baseUrl'] = normalize_api_base(result['baseUrl'])
    return result


class SettingsStore:
    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        self.verified = {}

    def snapshot(self):
        with self.lock:
            if self.path.exists():
                value = json.loads(self.path.read_text(encoding='utf-8'))
                value['apiKey'] = dpapi(base64.b64decode(value.pop('encryptedKey')), decrypt=True).decode('utf-8')
                return value
            return {'baseUrl': os.getenv('ZOSPEAK_AI_BASE_URL', ''),
                    'model': os.getenv('ZOSPEAK_AI_MODEL', ''),
                    'apiKey': os.getenv('ZOSPEAK_AI_API_KEY', ''),
                    'thinkingMode': os.getenv('EASTUDY_AI_THINKING', 'disabled'), 'revision': 0}

    def public(self):
        value = self.snapshot()
        return {**{k: value[k] for k in ('baseUrl', 'model', 'thinkingMode', 'revision')},
                'hasApiKey': bool(value['apiKey']), 'detailReviewMode': 'full'}

    def candidate(self, value, require_model=True):
        current = self.snapshot()
        if value.get('revision') != current['revision']:
            raise SettingsError('SETTINGS_CHANGED')
        candidate = dict(value)
        if not str(candidate.get('apiKey') or '').strip():
            if normalize_api_base(candidate.get('baseUrl', '')) != normalize_api_base(current['baseUrl']):
                raise SettingsError('NEW_ENDPOINT_REQUIRES_KEY')
            candidate['apiKey'] = current['apiKey']
        return validate_config(candidate, require_model=require_model)

    def models(self, value, opener=None):
        with self.lock:
            candidate = self.candidate(value, require_model=False)
        base = candidate['baseUrl'].removesuffix('/chat/completions')
        request = urllib.request.Request(base + '/models', headers={
            'Authorization': 'Bearer ' + candidate['apiKey'], 'Accept': 'application/json',
            'User-Agent': 'EastudyLocalStudio/2.5'})
        try:
            with (opener or _open_api)(request, timeout=20, context=ssl.create_default_context()) as response:
                body = response.read(2 * 1024 * 1024 + 1)
            if len(body) > 2 * 1024 * 1024:
                raise SettingsError('AI_MODELS_INVALID')
            raw = json.loads(body)
        except urllib.error.HTTPError as error:
            code = {401: 'AI_MODELS_AUTH', 403: 'AI_MODELS_AUTH', 404: 'AI_MODELS_UNSUPPORTED',
                    405: 'AI_MODELS_UNSUPPORTED', 429: 'AI_MODELS_RATE_LIMIT'}.get(error.code, 'AI_MODELS_HTTP_ERROR')
            raise SettingsError(code) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException):
            raise SettingsError('AI_NETWORK_ERROR') from None
        except ValueError:
            raise SettingsError('AI_MODELS_INVALID') from None
        rows = raw.get('data') if isinstance(raw, dict) else None
        if not isinstance(rows, list) or len(rows) > 10000:
            raise SettingsError('AI_MODELS_INVALID')
        models = sorted({row['id'] for row in rows if isinstance(row, dict)
                         and isinstance(row.get('id'), str) and 0 < len(row['id']) <= 200
                         and not any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in row['id'])
                         and candidate['apiKey'] not in row['id']}, key=str.casefold)
        if not models:
            raise SettingsError('AI_MODELS_EMPTY')
        with self.lock:
            self.candidate(value, require_model=False)
        return {'models': models, 'baseUrl': candidate['baseUrl']}

    @staticmethod
    def digest(value):
        return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()

    def test(self, value, request=call_json):
        with self.lock:
            candidate = self.candidate(value)
        payload = {'sentences': SAMPLES}
        prompt = ('You teach English to Chinese students. Translate each full sentence naturally into Chinese, '
                  'preserving negation and context. Explain the specified word only in its current sense, '
                  'not unrelated dictionary meanings. Return JSON: {"sentences":[{"id":"...",'
                  '"chinese":"...","meaningZh":"..."}]}. Preserve all IDs.')
        first, _ = request(candidate, prompt, payload, timeout=90)
        reviewed, meta = request(candidate, prompt + ' Independently review and correct the candidate; '
                                 'return the complete corrected JSON.', {**payload, 'candidate': first}, timeout=90)
        rows = reviewed.get('sentences') if isinstance(reviewed, dict) else None
        if (not isinstance(rows, list) or len(rows) != len(SAMPLES)
                or any(not isinstance(row, dict) for row in rows)
                or {row.get('id') for row in rows} != {row['id'] for row in SAMPLES}
                or any(not isinstance(row.get(k), str) or not row[k].strip() or len(row[k]) > 2000
                       or not any('\u3400' <= c <= '\u9fff' for c in row[k])
                       for row in rows for k in ('chinese', 'meaningZh'))):
            raise SettingsError('AI_SAMPLE_INVALID')
        with self.lock:
            # A test of an obsolete revision cannot authorize a subsequent save.
            self.candidate(value)
            now = time.monotonic()
            self.verified = {k: v for k, v in self.verified.items() if v[1] > now}
            ticket = secrets.token_urlsafe(24)
            self.verified[ticket] = (self.digest(candidate), now + 600)
        return {'testId': ticket, 'baseUrl': candidate['baseUrl'], 'model': str(meta.get('model', candidate['model']))[:200],
                'sentences': [{**next(row for row in rows if row['id'] == source['id']), **source}
                              for source in SAMPLES]}

    def save(self, value):
        with self.lock:
            candidate = self.candidate(value)
            verified = self.verified.get(value.get('testId'))
            if not verified or verified[1] < time.monotonic() or verified[0] != self.digest(candidate):
                raise SettingsError('TEST_REQUIRED')
            candidate['encryptedKey'] = base64.b64encode(dpapi(candidate.pop('apiKey').encode())).decode()
            candidate['revision'] = self.snapshot()['revision'] + 1
            atomic_json(self.path, candidate)
            self.verified.clear()
            return self.public()


def authorize_admin(token):
    if not token or len(token) > 8192 or any(c.isspace() for c in token):
        raise SettingsError('ADMIN_REQUIRED')
    request = urllib.request.Request(AUTH_URL, data=b'{}', headers={
        'Authorization': 'Bearer ' + token, 'apikey': PUBLIC_KEY, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if json.load(response) is not True:
                raise SettingsError('ADMIN_REQUIRED')
    except Exception:
        raise SettingsError('ADMIN_REQUIRED') from None


def start_ai_settings(store, port=8791, authorize=authorize_admin):
    slots = threading.BoundedSemaphore(2)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, value):
            data = json.dumps(value, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            origin = self.headers.get('Origin', '')
            if origin in ORIGINS:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def dispatch(self):
            acquired = False
            try:
                if (self.headers.get('Origin') not in ORIGINS
                        or self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}'):
                    self.reply(403, {'error': 'ORIGIN_INVALID'})
                    return
                if self.command == 'OPTIONS':
                    self.reply(200, {})
                    return
                acquired = slots.acquire(blocking=False)
                if not acquired:
                    self.reply(429, {'error': 'SETTINGS_BUSY'})
                    return
                header = self.headers.get('Authorization', '')
                authorize(header[7:] if header.startswith('Bearer ') else '')
                if self.command == 'GET' and self.path == '/v1/ai-settings':
                    self.reply(200, store.public())
                    return
                if self.command != 'POST' or self.path not in {'/v1/ai-settings', '/v1/ai-settings/test', '/v1/ai-settings/models'}:
                    self.reply(404, {'error': 'NOT_FOUND'})
                    return
                length = self.headers.get('Content-Length', '')
                if self.headers.get('Transfer-Encoding') or not length.isdigit() or not 0 < int(length) <= 16384:
                    raise SettingsError('BODY_INVALID')
                self.connection.settimeout(15)
                body = self.rfile.read(int(length))
                value = json.loads(body)
                if not isinstance(value, dict):
                    raise SettingsError('BODY_INVALID')
                if self.path.endswith('/models'):
                    result = store.models(value)
                else:
                    result = store.test(value) if self.path.endswith('/test') else store.save(value)
                self.reply(200, result)
            except SettingsError as error:
                self.reply(403 if str(error) == 'ADMIN_REQUIRED' else 400, {'error': str(error)})
            except Exception as error:
                # Provider bodies and local exceptions may contain credentials.
                code = getattr(error, 'code', '')
                self.reply(502, {'error': code if code in {'AI_HTTP_ERROR', 'AI_NETWORK_ERROR',
                    'AI_ENDPOINT_HTML', 'AI_RESPONSE_INVALID', 'AI_OUTPUT_INCOMPLETE',
                    'AI_RESPONSE_SCHEMA', 'AI_JSON_INVALID'} else 'SETTINGS_UNAVAILABLE'})
            finally:
                if acquired:
                    slots.release()

        do_GET = do_POST = do_OPTIONS = dispatch

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
