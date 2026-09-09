import hashlib
import json
import os
import uuid
from pathlib import Path


def canonical_hash(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                     separators=(',', ':'), allow_nan=False).encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    data = json.dumps(value, ensure_ascii=False, sort_keys=True,
                      allow_nan=False).encode('utf-8')
    try:
        with temporary.open('xb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_valid_json(path, key, validator):
    path = Path(path)
    if not path.is_file():
        return None
    try:
        saved = json.loads(path.read_text(encoding='utf-8'))
        if saved.get('version') != 1 or saved.get('key') != key or saved.get('state') != 'COMPLETE':
            return None
        return validator(saved['value'])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save_json_checkpoint(path, key, value):
    atomic_json(path, {'version': 1, 'state': 'COMPLETE', 'key': key, 'value': value})
    return value
