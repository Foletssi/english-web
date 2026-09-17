"""Authenticated loopback-only intake. Never exposes Worker credentials or disk paths."""
import hashlib
import json
import re
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from local_intake_store import CHUNK_BYTES, IntakeError

ORIGINS = {'https://english-web-lce.pages.dev', 'http://localhost:8080', 'http://127.0.0.1:8080'}


def start_local_intake(store, client, port=8790):
    sessions = {}
    lock = threading.RLock()
    slots = threading.BoundedSemaphore(2)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Tickets and private file names must not enter access logs.

        def origin(self):
            origin = self.headers.get('Origin', '')
            if origin not in ORIGINS or self.headers.get('Host') != f'127.0.0.1:{self.server.server_port}':
                raise IntakeError('ORIGIN_INVALID')
            return origin

        def reply(self, status, value=None):
            data = b'' if status == 204 else json.dumps(value or {}, ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            origin = self.headers.get('Origin', '')
            if origin in ORIGINS:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Chunk-SHA256')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def read_body(self, limit):
            if self.headers.get('Transfer-Encoding'):
                raise IntakeError('CONTENT_LENGTH_REQUIRED')
            value = self.headers.get('Content-Length', '')
            if not value.isdigit() or int(value) > limit:
                raise IntakeError('CONTENT_LENGTH_INVALID')
            self.connection.settimeout(60)
            data = self.rfile.read(int(value))
            if len(data) != int(value):
                raise IntakeError('BODY_INCOMPLETE')
            return data

        def authorize(self, origin, refresh=False):
            ticket = self.headers.get('Authorization', '').removeprefix('Bearer ')
            if not re.fullmatch(r'[0-9a-f]{64}', ticket):
                raise IntakeError('INTAKE_TICKET_INVALID')
            key = hashlib.sha256(ticket.encode()).hexdigest()
            with lock:
                for stale in [k for k, v in sessions.items() if v['expires'] <= time.time()]:
                    del sessions[stale]
                session = sessions.get(key)
            if session and not refresh:
                if session['origin'] != origin:
                    raise IntakeError('ORIGIN_INVALID')
                return session['source']
            result = client.call('worker-local-ticket', ticket=ticket, origin=origin)['intake']
            source = result['source']
            expires = datetime.fromisoformat(result['expiresAt'].replace('Z', '+00:00')).timestamp()
            if expires <= time.time() or source['workerId'] != client.worker_id:
                raise IntakeError('INTAKE_TICKET_INVALID')
            with lock:
                sessions[key] = {'origin': origin, 'source': source, 'expires': expires}
            return source

        def dispatch(self):
            acquired = False
            try:
                origin = self.origin()
                if self.command == 'OPTIONS':
                    self.reply(204)
                    return
                acquired = slots.acquire(blocking=False)
                if not acquired:
                    self.reply(429, {'error': 'LOCAL_INTAKE_BUSY'})
                    return
                if self.command == 'GET' and self.path == '/v2/capability':
                    if not all(client.capabilities.get(name) for name in
                               ('ffmpeg', 'whisper', 'deepseek', 'teachingVoiceV1', 'localInputV1')):
                        self.reply(503, {'error': 'LOCAL_PROCESSING_NOT_READY', 'ready': False})
                        return
                    challenge = str(uuid.uuid4())
                    client.call('worker-local-challenge', challenge=challenge, origin=origin)
                    self.reply(200, {'protocolVersion': 1, 'workerId': client.worker_id, 'challenge': challenge,
                                     'ready': True, 'storage': store.storage_usage()})
                    return
                source = self.authorize(origin, refresh=self.command == 'POST')
                source_id = source['sourceId']
                if self.path == '/v2/intakes' and self.command == 'POST':
                    self.read_body(4096)
                    self.reply(200, store.open(source))
                    return
                match = re.fullmatch(r'/v2/intakes/([0-9a-f-]{36})(?:/(complete|renew|cover|chunks/\d+))?', self.path)
                if not match or match[1] != source_id:
                    raise IntakeError('INTAKE_ROUTE_INVALID')
                operation = match[2]
                if self.command == 'GET' and not operation:
                    self.reply(200, store.status(source_id, verify=True))
                elif self.command == 'POST' and operation in {'complete', 'renew'}:
                    self.read_body(4096)
                    self.reply(202 if operation == 'complete' else 200,
                               store.begin_complete(source_id) if operation == 'complete' else store.open(source))
                elif self.command == 'PUT' and operation == 'cover':
                    store.cover(source_id, self.read_body(15 * 1024 ** 2))
                    self.reply(200, {'ok': True})
                elif self.command == 'PUT' and operation and operation.startswith('chunks/'):
                    store.chunk(source_id, int(operation.split('/')[1]), self.read_body(CHUNK_BYTES), self.headers.get('X-Chunk-SHA256', ''))
                    self.reply(200, {'ok': True})
                else:
                    raise IntakeError('INTAKE_ROUTE_INVALID')
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as error:
                code = str(error) if isinstance(error, IntakeError) else str(getattr(error, 'code', 'LOCAL_INTAKE_UNAVAILABLE'))
                self.reply(400 if isinstance(error, IntakeError) else 503, {'error': code[:100]})
            finally:
                if acquired:
                    slots.release()

        do_GET = do_POST = do_PUT = do_OPTIONS = dispatch

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True, name='local-input-http').start()
    stop = threading.Event()

    def outbox():
        while not stop.is_set():
            try:
                store.drain_outbox(client)
            except Exception as error:
                print(f'[local-input-outbox] {type(error).__name__}', flush=True)
            stop.wait(10)

    threading.Thread(target=outbox, daemon=True, name='local-input-outbox').start()
    server.outbox_stop = stop
    return server
