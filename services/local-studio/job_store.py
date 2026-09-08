import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class JobStore:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _path(self, job_id):
        if not job_id or any(char not in '0123456789abcdef-' for char in str(job_id).lower()):
            raise KeyError(job_id)
        return self.root / f'{job_id}.json'

    def create(self, metadata, source_name):
        now = utc_now()
        job = {
            'id': str(uuid.uuid4()), 'status': 'QUEUED', 'currentStep': 'upload',
            'progress': 5, 'message': '文件已保存，等待后台处理', 'retryable': False,
            'error': None, 'sourceName': source_name, 'metadata': metadata,
            'result': None, 'createdAt': now, 'updatedAt': now,
        }
        self.write(job)
        return job

    def get(self, job_id):
        path = self._path(job_id)
        if not path.is_file():
            raise KeyError(job_id)
        with self._lock:
            return json.loads(path.read_text(encoding='utf-8'))

    def write(self, job):
        data = dict(job)
        data['updatedAt'] = utc_now()
        path = self._path(data['id'])
        temp = path.with_suffix(f'.{os.getpid()}.{threading.get_ident()}.tmp')
        with self._lock:
            temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
            temp.replace(path)
        return data

    def update(self, job_id, **changes):
        job = self.get(job_id)
        job.update(changes)
        return self.write(job)

    def list(self):
        rows = []
        for path in self.root.glob('*.json'):
            try:
                rows.append(json.loads(path.read_text(encoding='utf-8')))
            except (OSError, ValueError):
                continue
        return sorted(rows, key=lambda row: row.get('createdAt', ''), reverse=True)
