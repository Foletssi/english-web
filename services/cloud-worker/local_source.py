"""Optional loopback intake: cloud-persisted uploads only; never accepts disk paths."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import threading
import time
from urllib.parse import parse_qs, urlsplit
import uuid

from checkpoint import atomic_json, file_sha256

PART_BYTES = 8 * 1024 * 1024  # shared/cloud-content.js multipart contract
MAX_BYTES = 2 * 1024 ** 3
ALLOWED_ORIGINS = frozenset(('https://english-web-lce.pages.dev',
    'http://localhost:8080', 'http://127.0.0.1:8080'))
_cache_locks, _registry_lock = {}, threading.Lock()


class SourceCache:
    def __init__(self, root, limit=10 * 1024 ** 3):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.limit = limit
        with _registry_lock:
            self.lock = _cache_locks.setdefault(str(self.root), threading.RLock())

    def paths(self, key):
        if not re.fullmatch(r'videos/[0-9a-f-]{36}/source\.(mp4|mov|webm|m4v)', key):
            raise ValueError('SOURCE_KEY_INVALID')
        stem = hashlib.sha256(key.encode()).hexdigest()
        return self.root / (stem + '.source'), self.root / (stem + '.json')

    def prune(self, reserve=0):
        # Only our own abandoned staging files; active saves hold the shared lock.
        for path in self.root.glob('*.part'):
            if re.fullmatch(r'[a-f0-9]{32}\.part', path.name) and time.time() - path.stat().st_mtime > 86400:
                path.unlink(missing_ok=True)
        files = sorted((p for p in self.root.glob('*.source')
                        if re.fullmatch(r'[a-f0-9]{64}\.source', p.name)), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        for path in files:
            if total + reserve <= self.limit and time.time() - path.stat().st_mtime < 7 * 86400:
                continue
            total -= path.stat().st_size
            path.unlink()
            path.with_suffix('.json').unlink(missing_ok=True)

    def save(self, key, size, etag, stream):
        target, receipt = self.paths(key)
        if not 0 < size <= min(MAX_BYTES, self.limit):
            raise ValueError('SOURCE_SIZE_INVALID')
        etag = etag.strip('"')
        if not re.fullmatch(r'[a-f0-9]{32}-[1-9][0-9]*', etag):
            raise ValueError('SOURCE_ETAG_INVALID')
        # Serialize cache mutation and bound disk consumption, including staging.
        with self.lock:
            self.prune(size)
            if shutil.disk_usage(self.root).free < size + 256 * 1024 ** 2:
                raise ValueError('SOURCE_DISK_SPACE_LOW')
            temporary = self.root / (uuid.uuid4().hex + '.part')
            digest, parts, remaining = hashlib.sha256(), [], size
            try:
                with temporary.open('xb') as output:
                    while remaining:
                        block = stream.read(min(PART_BYTES, remaining))
                        if len(block) != min(PART_BYTES, remaining):
                            raise ValueError('SOURCE_TRUNCATED')
                        remaining -= len(block)
                        digest.update(block)
                        parts.append(hashlib.md5(block).digest())
                        output.write(block)
                    output.flush()
                    os.fsync(output.fileno())
                actual = hashlib.md5(b''.join(parts)).hexdigest() + '-' + str(len(parts))
                if actual != etag:
                    raise ValueError('SOURCE_CONTENT_MISMATCH')
                os.replace(temporary, target)
                atomic_json(receipt, {'key': key, 'etag': etag, 'size': size, 'sha256': digest.hexdigest()})
                self.prune()
            finally:
                temporary.unlink(missing_ok=True)

    def restore(self, key, size, cloud_etag, destination):
        """Caller supplies HEAD metadata from the lease-authorized cloud route."""
        try:
            target, receipt = self.paths(key)
            with self.lock:
                data = json.loads(receipt.read_text(encoding='utf-8'))
                if (not isinstance(data, dict) or data.get('key') != key or data.get('size') != size
                        or data.get('etag') != cloud_etag.strip('"')
                        or target.stat().st_size != size or file_sha256(target) != data.get('sha256')):
                    return False
                destination = Path(destination)
                destination.parent.mkdir(parents=True, exist_ok=True)
                temporary = destination.with_suffix(destination.suffix + '.local-part')
                try:
                    shutil.copyfile(target, temporary)
                    os.replace(temporary, destination)
                    atomic_json(destination.with_suffix(destination.suffix + '.source.json'), {
                        'version': 1, 'etag': cloud_etag, 'totalBytes': size, 'contentHash': data['sha256']})
                    os.utime(target, None)
                finally:
                    temporary.unlink(missing_ok=True)
                return True
        except (ValueError, OSError, TypeError):
            return False


def start_intake(cache, port=8789):
    tokens, token_lock = {}, threading.Lock()
    admissions = threading.BoundedSemaphore(2)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log query strings, nonce values or filenames.

        def trusted(self):
            return (self.headers.get('Origin') in ALLOWED_ORIGINS
                    and self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}')

        def reply(self, status, data=None):
            body = json.dumps(data or {}).encode()
            self.send_response(status)
            if self.trusted():
                self.send_header('Access-Control-Allow-Origin', self.headers['Origin'])
                self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Eastudy-Intake')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Vary', 'Origin')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.reply(200 if self.trusted() else 403)

        def do_GET(self):
            if not self.trusted() or self.path != '/capability':
                self.reply(403)
                return
            with token_lock:
                now = time.monotonic()
                for key in list(tokens):
                    if tokens[key][1] < now:
                        del tokens[key]
                if len(tokens) >= 64:
                    self.reply(429)
                    return
                token = secrets.token_urlsafe(32)
                tokens[token] = (self.headers['Origin'], now + 90)
            self.reply(200, {'token': token})

        def do_PUT(self):
            if not self.trusted():
                self.reply(403)
                return
            with token_lock:
                token = tokens.pop(self.headers.get('X-Eastudy-Intake', ''), None)
            if not token or token[0] != self.headers['Origin'] or token[1] < time.monotonic():
                self.reply(403)
                return
            if not admissions.acquire(blocking=False):
                self.reply(429)
                return
            try:
                self.connection.settimeout(15)
                url = urlsplit(self.path)
                query = parse_qs(url.query, strict_parsing=True)
                size = int(query['size'][0])
                if (url.path != '/source' or self.headers.get('Transfer-Encoding')
                        or int(self.headers.get('Content-Length', '0')) != size):
                    raise ValueError('SOURCE_REQUEST_INVALID')
                cache.save(query['key'][0], size, query['etag'][0], self.rfile)
                self.reply(200, {'saved': True})
            except (KeyError, ValueError, OSError):
                try:
                    self.reply(400, {'saved': False})
                except OSError:
                    pass
            finally:
                admissions.release()

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True, name='source-intake').start()
    return server
