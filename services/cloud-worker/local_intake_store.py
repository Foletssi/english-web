"""Durable local originals. This is task input storage, never an evictable cache."""
import hashlib
import json
import os
import re
import shutil
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

CHUNK_BYTES = 8 * 1024 * 1024
MAX_BYTES = 2 * 1024 ** 3


class IntakeError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def digest_file(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(CHUNK_BYTES), b''):
            digest.update(block)
    return digest.hexdigest()


class LocalInputs:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.closed = False
        self.finalizers = {}
        self.finalize_errors = {}
        # One writer process owns these files; SQLite alone cannot fence file replacement.
        self._ownership = (self.root / 'owner.lock').open('a+b')
        try:
            self._initialize()
        except BaseException:
            self.closed = True
            self._ownership.close()
            raise

    def _initialize(self):
        self._ownership.seek(0)
        if os.name == 'nt':
            import msvcrt
            if not self._ownership.read(1):
                self._ownership.write(b'0')
                self._ownership.flush()
            self._ownership.seek(0)
            msvcrt.locking(self._ownership.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self._ownership, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with self.connect() as db:
            db.executescript('''
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS inputs (
                source_id TEXT PRIMARY KEY, declaration TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'RECEIVING', notified INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE IF NOT EXISTS chunks (
                source_id TEXT NOT NULL REFERENCES inputs(source_id), idx INTEGER NOT NULL,
                sha TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY(source_id,idx));
              CREATE TABLE IF NOT EXISTS stages (
                job_id TEXT NOT NULL, run_id TEXT NOT NULL, stage TEXT NOT NULL,
                value TEXT NOT NULL, PRIMARY KEY(job_id,run_id,stage));
            ''')
            if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise IntakeError('LOCAL_INPUT_DATABASE_DAMAGED')
            db.execute("UPDATE inputs SET state='RECEIVING' WHERE state='VERIFYING'")

    def close(self):
        with self.lock:
            if self.finalizers:
                raise IntakeError('LOCAL_INPUT_FINALIZATION_ACTIVE')
            self.closed = True
            self._ownership.close()

    def storage_usage(self):
        with self.connect() as db:
            ids = [row[0] for row in db.execute('SELECT source_id FROM inputs')]
        used = 0
        for source_id in ids:
            directory = self.directory(source_id)
            for path in directory.iterdir():
                if path.is_file() and not path.is_symlink():
                    try:
                        used += path.stat().st_size
                    except FileNotFoundError:
                        pass
        return {'applicationBytes': used, 'freeBytes': shutil.disk_usage(self.root).free}

    def reserve_capacity(self, db, size):
        receiving = list(db.execute("SELECT declaration FROM inputs WHERE state IN ('RECEIVING','VERIFYING')"))
        if len(receiving) >= 2:
            raise IntakeError('LOCAL_INTAKE_QUEUE_FULL')
        reserved = sum(json.loads(row[0])['size'] * 2 for row in receiving)
        if shutil.disk_usage(self.root).free - reserved < size * 3 + 2 * 1024 ** 3:
            raise IntakeError('LOCAL_DISK_SPACE_LOW')

    @contextmanager
    def connect(self):
        with self.lock:
            if self.closed:
                raise IntakeError('LOCAL_INPUT_STORE_CLOSED')
            db = sqlite3.connect(self.root / 'intakes.sqlite3', timeout=30)
            try:
                db.row_factory = sqlite3.Row
                db.execute('PRAGMA busy_timeout=30000')
                db.execute('PRAGMA synchronous=FULL')
                db.execute('PRAGMA foreign_keys=ON')
                with db:
                    yield db
            finally:
                db.close()

    def directory(self, source_id):
        if self.closed:
            raise IntakeError('LOCAL_INPUT_STORE_CLOSED')
        if str(uuid.UUID(source_id)) != source_id:
            raise IntakeError('SOURCE_ID_INVALID')
        path = self.root / source_id
        if path.is_symlink() or not path.resolve().is_relative_to(self.root):
            raise IntakeError('SOURCE_PATH_INVALID')
        path.mkdir(exist_ok=True)
        return path

    def file(self, source_id, name):
        path = self.directory(source_id) / name
        if path.is_symlink() or not path.resolve().is_relative_to(self.root):
            raise IntakeError('SOURCE_PATH_INVALID')
        return path

    def open(self, declaration):
        if not isinstance(declaration, dict):
            raise IntakeError('SOURCE_DECLARATION_INVALID')
        for key in ('sourceId', 'jobId'):
            value = declaration.get(key)
            if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}', value):
                raise IntakeError('SOURCE_DECLARATION_INVALID')
        if not re.fullmatch(r'[A-Za-z0-9._-]{3,80}', str(declaration.get('workerId', ''))):
            raise IntakeError('WORKER_ID_INVALID')
        if not isinstance(declaration.get('name'), str) or not 1 <= len(declaration['name']) <= 255:
            raise IntakeError('SOURCE_NAME_INVALID')
        source_id = declaration['sourceId']
        size = declaration.get('size')
        if type(size) is not int or not 0 < size <= MAX_BYTES:
            raise IntakeError('SOURCE_SIZE_INVALID')
        if not re.fullmatch(r'[0-9a-f]{64}', str(declaration.get('sha256', ''))):
            raise IntakeError('SOURCE_SHA_INVALID')
        if declaration.get('coverSha256') is not None and not re.fullmatch(r'[0-9a-f]{64}', str(declaration['coverSha256'])):
            raise IntakeError('COVER_INVALID')
        encoded = json.dumps(declaration, sort_keys=True)
        with self.lock, self.connect() as db:
            existing = db.execute('SELECT declaration FROM inputs WHERE source_id=?', (source_id,)).fetchone()
            if existing and existing['declaration'] != encoded:
                raise IntakeError('SOURCE_DECLARATION_CONFLICT')
            if existing:
                state = db.execute('SELECT state FROM inputs WHERE source_id=?', (source_id,)).fetchone()[0]
                if state == 'CANCELLED':
                    raise IntakeError('LOCAL_INPUT_CANCELLED')
                if state == 'READY':
                    path = self.file(source_id, 'source.bin')
                    if not path.is_file() or path.stat().st_size != size or digest_file(path) != declaration['sha256']:
                        db.execute("UPDATE inputs SET state='MISSING',notified=0 WHERE source_id=?", (source_id,))
                        state = 'MISSING'
                if state == 'MISSING':
                    self.reserve_capacity(db, size)
                    db.execute('DELETE FROM chunks WHERE source_id=?', (source_id,))
                    db.execute("UPDATE inputs SET state='RECEIVING',notified=0 WHERE source_id=?", (source_id,))
            if not existing:
                # Reserve both reception/assembly plus conservative PCM/output working space.
                self.reserve_capacity(db, size)
                self.directory(source_id)
                db.execute('INSERT INTO inputs(source_id,declaration) VALUES (?,?)', (source_id, encoded))
        return self.status(source_id, verify=True)

    def status(self, source_id, verify=False):
        with self.lock, self.connect() as db:
            row = db.execute('SELECT * FROM inputs WHERE source_id=?', (source_id,)).fetchone()
            if not row:
                raise IntakeError('LOCAL_SOURCE_MISSING')
            declaration = json.loads(row['declaration'])
            chunks = [dict(r) for r in db.execute('SELECT idx,sha,size FROM chunks WHERE source_id=? ORDER BY idx', (source_id,))]
            # Receipt is authoritative only while the durable block is still present and intact.
            if verify and row['state'] == 'RECEIVING':
                valid = []
                for chunk in chunks:
                    path = self.file(source_id, f"{chunk['idx']}.chunk")
                    if path.is_file() and not path.is_symlink() and path.stat().st_size == chunk['size'] and digest_file(path) == chunk['sha']:
                        valid.append(chunk)
                    else:
                        db.execute('DELETE FROM chunks WHERE source_id=? AND idx=?', (source_id, chunk['idx']))
                chunks = valid
            return {'sourceId': source_id, 'state': row['state'], 'notified': bool(row['notified']),
                    'error': self.finalize_errors.get(source_id),
                    'chunkBytes': CHUNK_BYTES, 'chunks': chunks, 'source': declaration}

    def chunk(self, source_id, index, data, sha):
        if type(index) is not int:
            raise IntakeError('CHUNK_CONTENT_INVALID')
        with self.lock:
            status = self.status(source_id)
            size = status['source']['size']
            expected = min(CHUNK_BYTES, size - index * CHUNK_BYTES)
            if index < 0 or expected <= 0 or len(data) != expected or hashlib.sha256(data).hexdigest() != sha:
                raise IntakeError('CHUNK_CONTENT_INVALID')
            if status['state'] != 'RECEIVING':
                raise IntakeError('INTAKE_ALREADY_COMPLETE')
            previous = next((r for r in status['chunks'] if r['idx'] == index), None)
            if previous:
                if previous['sha'] != sha:
                    raise IntakeError('CHUNK_CONFLICT')
                path = self.file(source_id, f'{index}.chunk')
                if path.is_file() and path.stat().st_size == len(data) and digest_file(path) == sha:
                    return
            path = self.file(source_id, f'{index}.chunk')
            temp = self.file(source_id, f'{index}.part')
            with temp.open('wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
            with self.connect() as db:
                db.execute('INSERT OR REPLACE INTO chunks VALUES (?,?,?,?)', (source_id, index, sha, len(data)))

    def cover(self, source_id, data):
        from PIL import Image
        import io
        status = self.status(source_id)
        expected = status['source'].get('coverSha256')
        if not expected or len(data) > 15 * 1024 ** 2 or hashlib.sha256(data).hexdigest() != expected:
            raise IntakeError('COVER_INVALID')
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {'JPEG', 'PNG', 'WEBP'} or image.width * image.height > 40_000_000:
                raise IntakeError('COVER_INVALID')
            image.verify()
        with self.lock:
            if self.status(source_id)['state'] != 'RECEIVING':
                raise IntakeError('INTAKE_ALREADY_COMPLETE')
            path = self.file(source_id, 'cover.input')
            temp = self.file(source_id, 'cover.part')
            with temp.open('wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)

    def begin_complete(self, source_id):
        with self.lock:
            status = self.status(source_id)
            if status['state'] == 'READY':
                return status
            if source_id in self.finalizers:
                return {**status, 'state': 'VERIFYING'}
            if status['state'] != 'RECEIVING':
                raise IntakeError('LOCAL_INPUT_CANCELLED')
            self.finalize_errors.pop(source_id, None)

            def finish():
                try:
                    self.complete(source_id)
                except Exception as error:
                    with self.lock:
                        self.finalize_errors[source_id] = str(error) if isinstance(error, IntakeError) else 'LOCAL_FINALIZE_FAILED'
                finally:
                    with self.lock:
                        self.finalizers.pop(source_id, None)

            thread = threading.Thread(target=finish, daemon=True, name='local-input-verify')
            self.finalizers[source_id] = thread
            thread.start()
            return {**status, 'state': 'VERIFYING'}

    def complete(self, source_id):
        with self.lock:
            status = self.status(source_id)
            if status['state'] == 'READY':
                self.require_ready(status['source'])
                return status
            if status['state'] != 'RECEIVING':
                raise IntakeError('LOCAL_INPUT_CANCELLED')
            source = status['source']
            count = (source['size'] + CHUNK_BYTES - 1) // CHUNK_BYTES
            if [r['idx'] for r in status['chunks']] != list(range(count)):
                raise IntakeError('CHUNKS_INCOMPLETE')
            if source.get('coverSha256') and (not self.file(source_id, 'cover.input').is_file() or
                    digest_file(self.file(source_id, 'cover.input')) != source['coverSha256']):
                raise IntakeError('COVER_INCOMPLETE')
            with self.connect() as db:
                db.execute("UPDATE inputs SET state='VERIFYING' WHERE source_id=?", (source_id,))
        # Assembly/probe can take minutes. Keep HTTP status and other sources responsive.
        try:
            temp = self.file(source_id, 'source.part')
            digest = hashlib.sha256()
            with temp.open('wb') as stream:
                for index in range(count):
                    with self.file(source_id, f'{index}.chunk').open('rb') as block:
                        for data in iter(lambda: block.read(1024 * 1024), b''):
                            digest.update(data)
                            stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            if digest.hexdigest() != source['sha256']:
                raise IntakeError('SOURCE_SHA_MISMATCH')
            if temp.stat().st_size != source['size']:
                raise IntakeError('SOURCE_SIZE_INVALID')
            from media_tools import probe
            probe(temp)  # Reject a complete but unsupported/no-audio source before queueing.
            os.replace(temp, self.file(source_id, 'source.bin'))
            with self.connect() as db:
                db.execute("UPDATE inputs SET state='READY',notified=0 WHERE source_id=?", (source_id,))
            # Original is durable. Reception block copies are now redundant, never user originals.
            for index in range(count):
                self.file(source_id, f'{index}.chunk').unlink(missing_ok=True)
            return self.status(source_id)
        except Exception:
            with self.lock, self.connect() as db:
                db.execute("UPDATE inputs SET state='RECEIVING' WHERE source_id=? AND state='VERIFYING'", (source_id,))
            raise

    def require_ready(self, descriptor):
        source_id = descriptor['sourceId']
        status = self.status(source_id)
        if status['state'] != 'READY':
            raise IntakeError('LOCAL_SOURCE_MISSING')
        for key in ('size', 'sha256', 'workerId', 'jobId'):
            if status['source'].get(key) != descriptor.get(key):
                raise IntakeError('SOURCE_DECLARATION_CONFLICT')
        try:
            path = self.file(source_id, 'source.bin')
        except IntakeError as error:
            if error.code == 'SOURCE_PATH_INVALID':
                self.mark_missing(source_id)
            raise
        if path.is_symlink() or not path.is_file() or path.stat().st_size != descriptor['size']:
            self.mark_missing(source_id)
            raise IntakeError('LOCAL_SOURCE_MISSING')
        if digest_file(path) != descriptor['sha256']:
            self.mark_missing(source_id)
            raise IntakeError('LOCAL_SOURCE_SHA_MISMATCH')
        return path

    def mark_missing(self, source_id):
        with self.connect() as db:
            db.execute("UPDATE inputs SET state='MISSING',notified=0 WHERE source_id=?", (source_id,))

    def drain_outbox(self, client):
        with self.connect() as db:
            pending = [(json.loads(r[0]), r[1]) for r in db.execute("SELECT declaration,state FROM inputs WHERE state IN ('READY','MISSING') AND notified=0")]
        for source, state in pending:
            try:
                if state == 'READY':
                    self.require_ready(source)
                client.call('worker-local-ready' if state == 'READY' else 'worker-local-missing',
                            sourceId=source['sourceId'], sha256=source['sha256'])
                with self.connect() as db:
                    db.execute('UPDATE inputs SET notified=1 WHERE source_id=? AND state=?', (source['sourceId'], state))
            except Exception as error:
                if getattr(error, 'code', '') in {'VIDEO_IN_TRASH', 'JOB_LEASE_LOST_OR_CANCELLED', 'LOCAL_INPUT_CANCELLED'}:
                    with self.connect() as db:
                        db.execute("UPDATE inputs SET state='CANCELLED' WHERE source_id=?", (source['sourceId'],))
                else:
                    print(f'[local-input-outbox] {type(error).__name__}', flush=True)

    def stage(self, job_id, run_id, stage, value):
        with self.connect() as db:
            db.execute('INSERT OR REPLACE INTO stages VALUES (?,?,?,?)',
                       (job_id, run_id, stage, json.dumps({**value, 'updatedAt': time.time()})))
