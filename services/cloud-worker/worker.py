import argparse
import base64
import hashlib
import http.client
import json
import math
import os
import platform
import re
import shutil
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCAL_STUDIO = ROOT / 'services' / 'local-studio'
sys.path.insert(0, str(LOCAL_STUDIO))

from stage_scheduler import resource_slot, parallel_workers
from pipeline import process_job  # noqa: E402
from ai_tools import prepare_asr_model, repair_learning  # noqa: E402
from ai_usage import job_usage_config, summarize_usage  # noqa: E402
from checkpoint import atomic_json, file_sha256  # noqa: E402
from media_tools import ladder  # noqa: E402
from teaching_prompts import TEACHING_PROMPT_VERSION  # noqa: E402
from teaching_completion import complete_teaching  # noqa: E402
from teaching_contract import validate_completed_teaching  # noqa: E402
from voice_runtime import generate_worker_voice, voice_assets, voice_capability  # noqa: E402
from media_cancellation import cancellation_scope  # noqa: E402
from local_source import SourceCache, start_intake  # noqa: E402
from processing_metrics import stage_metrics, parallel_progress, record_stage  # noqa: E402
from local_intake_store import LocalInputs  # noqa: E402
from local_intake_v2 import start_local_intake  # noqa: E402
from ai_settings import SettingsStore, start_ai_settings  # noqa: E402
from final_output import restore_final_output, save_final_output  # noqa: E402


VERSION = '2.6.0'
DEFAULT_ENDPOINT = 'https://ehxqtgakjgqgmghhdmjg.supabase.co/functions/v1/video-processing'
STAGE_MAP = {'probe': 'PROBE', 'transcode': 'TRANSCODE', 'asr': 'ASR', 'enrich': 'ENRICH'}


class ApiError(RuntimeError):
    def __init__(self, code, message=None, status=None, detail=None):
        code = str(code or 'EDGE_REQUEST_FAILED')
        # Edge can wrap an upstream business rejection in an outer HTTP 500.
        wrapped = re.fullmatch(r'SUPABASE_(\d{3}):(.+)', code, re.DOTALL)
        self.code = (wrapped.group(2) if wrapped else code)[:120]
        self.status = int(wrapped.group(1)) if wrapped else status
        self.detail = detail
        super().__init__(str(message or code))


def api_error_from_http(error, prefix='EDGE'):
    raw = error.read().decode('utf-8', 'replace')[:2000]
    try:
        detail = json.loads(raw)
    except ValueError:
        detail = {'message': raw}
    if not isinstance(detail, dict):
        detail = {'message': raw}
    code = str(detail.get('error') or detail.get('code') or f'{prefix}_HTTP_{error.code}')
    message = str(detail.get('message') or code)
    return ApiError(code, message, error.code, detail)


def lease_cancelled(error):
    return isinstance(error, ApiError) and error.code in {
        'JOB_LEASE_LOST_OR_CANCELLED', 'VIDEO_IN_TRASH', 'JOB_NOT_FOUND', 'RUN_ID_MISMATCH'
    }


def transient_request_error(error):
    if not isinstance(error, ApiError) or lease_cancelled(error):
        return False
    if error.status is not None and error.status not in {429, 500, 502, 503, 504, 520, 521, 522, 523, 524}:
        return False
    # Named business errors, including unknown ones, must not inherit HTTP retries.
    transport_proxy_failure = error.status in {429, 500, 502, 503, 504, 520, 521, 522, 523, 524} and any(
        marker in error.code.lower() for marker in (
            'error sending request', 'connection reset', 'connection error',
            'read operation timed out', 'timed out'))
    return error.code in {'EDGE_UNAVAILABLE', 'EDGE_INVALID_RESPONSE', 'OUTPUT_UNAVAILABLE', 'OUTPUT_STATUS_UNAVAILABLE',
        'DB_STATEMENT_TIMEOUT', 'DB_LOCK_TIMEOUT', 'DB_SERIALIZATION_RETRY', 'DB_DEADLOCK_RETRY'} or (
        error.status is not None and error.code in {
            f'EDGE_HTTP_{error.status}', f'OUTPUT_HTTP_{error.status}', 'REQUEST_FAILED'}) or transport_proxy_failure


def recoverable_output_error(error):
    return transient_request_error(error) or error.code in {
        'OUTPUT_ACK_PENDING', 'OUTPUT_UPLOAD_RETRY', 'OUTPUT_INVALID_RESPONSE',
        'OUTPUT_AUTH_UNAVAILABLE'}


def batch_protocol_fallback(error):
    """Only compatibility/transport failures may use the idempotent v2 path."""
    return isinstance(error, ApiError) and (
        transient_request_error(error)
        or error.status in {404, 405}
        or error.code in {'ACTION_INVALID', 'METHOD_NOT_ALLOWED', 'OUTPUT_BATCH_INVALID',
                          'OUTPUT_STATUS_UNAVAILABLE'})


def request_json(request, timeout, prefix='EDGE', retryable=False):
    # Retry only operations whose server contract is idempotent, using the same bytes.
    attempts = 3 if retryable else 1
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                result = json.loads(response.read().decode('utf-8'))
            if not isinstance(result, dict):
                raise ValueError('Expected JSON object')
            if not result.get('ok'):
                raise ApiError(result.get('error') or f'{prefix}_REQUEST_FAILED', result.get('message'))
            return result
        except urllib.error.HTTPError as error:
            failure = api_error_from_http(error, prefix)
        except (urllib.error.URLError, OSError, http.client.HTTPException) as error:
            failure = ApiError(f'{prefix}_UNAVAILABLE', str(error))
        except ValueError as error:
            failure = ApiError(f'{prefix}_INVALID_RESPONSE', str(error))
        except ApiError as error:
            failure = error
        if attempt + 1 == attempts or not transient_request_error(failure):
            raise failure
        time.sleep(2 ** attempt)


class EdgeClient:
    def __init__(self, endpoint, secret, worker_id, capabilities):
        self.endpoint = endpoint
        self.secret = secret
        self.worker_id = worker_id
        self.capabilities = capabilities
        self._network_metrics = threading.local()

    def reset_network_timing(self):
        self._network_metrics.value = {
            'queueSeconds': 0.0, 'activeSeconds': 0.0, 'requests': 0, 'retries': 0}

    def consume_network_timing(self):
        value = getattr(self._network_metrics, 'value', None) or {
            'queueSeconds': 0.0, 'activeSeconds': 0.0, 'requests': 0, 'retries': 0}
        self._network_metrics.value = None
        return value

    def _request_json(self, request, timeout, prefix='EDGE', retryable=False, gate=None):
        # Validation, telemetry, and receipt registration are idempotent. A
        # concurrent heartbeat/finalization can briefly hold the job row lock;
        # give transient DB lock errors a longer bounded retry window so they do
        # not become false terminal failures.
        attempts = 5 if retryable else 1
        for attempt in range(attempts):
            queued = time.monotonic()
            def perform():
                with resource_slot('network'):
                    active = time.monotonic()
                    try:
                        return request_json(request, timeout, prefix, False)
                    finally:
                        metrics = getattr(self._network_metrics, 'value', None)
                        if metrics is not None:
                            metrics['queueSeconds'] += active - queued
                            metrics['activeSeconds'] += time.monotonic() - active
                            metrics['requests'] += 1
            try:
                if gate:
                    with resource_slot(gate):
                        return perform()
                return perform()
            except ApiError as failure:
                if attempt + 1 == attempts or not transient_request_error(failure):
                    raise
                metrics = getattr(self._network_metrics, 'value', None)
                if metrics is not None:
                    metrics['retries'] += 1
                time.sleep(2 ** attempt)

    def call(self, action, **values):
        payload = {'action': action, 'workerId': self.worker_id, 'version': VERSION,
                   'capabilities': self.capabilities, **values}
        request = urllib.request.Request(self.endpoint, data=json.dumps(payload).encode('utf-8'), method='POST', headers={
            'Content-Type': 'application/json', 'x-worker-secret': self.secret,
            'User-Agent': f'EastudyCloudWorker/{VERSION}'})
        timeout = 15 if 'heartbeat' in action else (210 if action == 'worker-complete-v3' else 45)
        return self._request_json(request, timeout, retryable=action in {
            'worker-telemetry-v2', 'worker-output-receipt-v2', 'worker-output-receipts-v3',
            'worker-validate-teaching-v2', 'worker-finalization-status-v3',
            'worker-defer-v3', 'worker-fail-v3'})

    def upload(self, base_url, token, job_id, path, source):
        url = base_url + '&path=' + urllib.parse.quote(path, safe='/')
        if not 0 < Path(source).stat().st_size <= 15 * 1024 ** 2:
            raise ApiError('OUTPUT_SIZE_LIMIT')
        data = Path(source).read_bytes()
        request = urllib.request.Request(url, data=data, method='PUT', headers={
            'Content-Type': content_type(path), 'Content-Length': str(len(data)),
            'User-Agent': f'EastudyCloudWorker/{VERSION}'})
        # A PUT response can disappear after R2 committed it. Reconcile the
        # current run's object before sending bytes again, including on resume.
        expected_hash = hashlib.sha256(data).hexdigest()
        has_run = bool(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get('run'))
        for attempt in range(3):
            try:
                if has_run:
                    status = self._request_json(urllib.request.Request(url, method='GET', headers={
                        'User-Agent': f'EastudyCloudWorker/{VERSION}'}), 30, 'OUTPUT')
                    if status.get('found'):
                        if status.get('sha256') != expected_hash or status.get('size') != len(data):
                            raise ApiError('OUTPUT_RECEIPT_CONFLICT')
                        return status
                return self._request_json(request, 300, 'OUTPUT')
            except ApiError as error:
                recoverable = recoverable_output_error(error)
                if not recoverable or attempt == 2:
                    raise
                time.sleep(2 ** attempt)


    def upload_batch(self, base_url, items):
        if not 1 <= len(items) <= 32:
            raise ApiError('OUTPUT_BATCH_LIMIT')
        pending = {}
        for relative, source in items:
            if (not re.fullmatch(r'voice/[a-f0-9]{64}\.mp3', relative)
                    or relative in pending):
                raise ApiError('OUTPUT_PATH_INVALID')
            if not 0 < Path(source).stat().st_size <= 1024 ** 2:
                raise ApiError('OUTPUT_SIZE_LIMIT')
            data = Path(source).read_bytes()
            pending[relative] = {'path': relative, 'size': len(data),
                'sha256': hashlib.sha256(data).hexdigest(),
                'data': base64.b64encode(data).decode('ascii')}
        if sum(item['size'] for item in pending.values()) > 2 * 1024 ** 2:
            raise ApiError('OUTPUT_BATCH_LIMIT')
        accepted = {}
        for attempt in range(3):
            request = urllib.request.Request(base_url,
                data=json.dumps({'items': list(pending.values())}).encode('utf-8'),
                method='POST', headers={'Content-Type': 'application/json',
                    'User-Agent': f'EastudyCloudWorker/{VERSION}'})
            try:
                response = self._request_json(request, 300, 'OUTPUT', gate='voice_batch')
                rows = response.get('results')
                if (not isinstance(rows, list) or len(rows) != len(pending)
                        or any(not isinstance(row, dict) or not isinstance(row.get('path'), str) for row in rows)
                        or {row.get('path') for row in rows} != set(pending)):
                    raise ApiError('OUTPUT_RECEIPT_MISMATCH')
                failures = []
                for row in rows:
                    expected = pending[row['path']]
                    if row.get('ok'):
                        if (row.get('size') != expected['size'] or row.get('sha256') != expected['sha256']
                                or not row.get('etag')):
                            raise ApiError('OUTPUT_RECEIPT_MISMATCH')
                    else:
                        failures.append(ApiError(row.get('error') or 'OUTPUT_UPLOAD_RETRY'))
                # Validate the entire response before accepting any receipt.
                for row in rows:
                    if row.get('ok'):
                        accepted[row['path']] = row
                        del pending[row['path']]
                if not pending:
                    return [accepted[relative] for relative, _ in items]
                failure = next((error for error in failures if not recoverable_output_error(error)), failures[0])
                raise failure
            except ApiError as error:
                if attempt == 2 or not recoverable_output_error(error):
                    raise
                time.sleep(2 ** attempt)


class RemoteProgressStore:
    def __init__(self, client, lease):
        job = lease['job']
        self.client = client
        self.lease = lease
        self._last_metric = None
        self._rate = None
        self._samples = 0
        self._lock = threading.RLock()
        self.job = {'id': job['id'], 'status': 'PROCESSING', 'currentStep': 'upload',
                    'progress': min(99, max(1, int(job.get('progress') or 0))),
                    'message': '正在读取并校验原片', 'error': None, 'result': None,
                    'sourceName': Path(job['source_key']).name, 'metadata': job.get('input') or {}}

    def get(self, job_id):
        if job_id != self.job['id']:
            raise KeyError(job_id)
        return dict(self.job)

    def update(self, job_id, **changes):
        with self._lock:
            return self._update(job_id, **changes)

    def _update(self, job_id, **changes):
        if job_id != self.job['id']:
            raise KeyError(job_id)
        if changes.get('status') == 'PROCESSING':
            changes['progress'] = max(self.job['progress'], changes.get('progress', 0))
        self.job.update(changes)
        if changes.get('status') == 'PROCESSING':
            step = str(changes.get('currentStep') or self.job.get('currentStep') or 'probe')
            metrics = dict(changes.get('telemetry') or {})
            current, total = metrics.get('current'), metrics.get('total')
            now = time.monotonic()
            work_key = (step, metrics.get('substage'), metrics.get('unit'))
            if isinstance(current, (int, float)) and self._last_metric and self._last_metric[0] == work_key:
                elapsed = now - self._last_metric[2]
                delta = current - self._last_metric[1]
                if elapsed > 0 and delta >= 0:
                    instant = delta / elapsed
                    self._rate = instant if self._rate is None else .3 * instant + .7 * self._rate
                    self._samples += 1
            else:
                self._rate, self._samples = None, 0
            if isinstance(current, (int, float)):
                self._last_metric = (work_key, current, now)
            metrics.update({'rate': self._rate, 'etaSampleCount': self._samples,
                'stageEtaSeconds': ((total - current) / self._rate if isinstance(total, (int, float))
                    and isinstance(current, (int, float)) and self._rate and self._rate > 0 and self._samples >= 3 else None)})
            report_progress(self.client, self.lease, STAGE_MAP.get(step, 'PROBE'),
                            min(99, int(changes.get('progress') or 0)),
                            str(changes.get('message') or ''), metrics)
        return dict(self.job)


def run_id(lease):
    return str(lease.get('job', {}).get('run_id') or '')


def sequence(lease):
    lease['_sequence'] = int(lease.get('_sequence') or 0) + 1
    return lease['_sequence']


def report_progress(client, lease, stage, progress, message, metrics=None):
    # One reducer and ordered sender for every branch; heartbeat never takes this lock.
    lock = lease.setdefault('_progress_lock', threading.RLock())
    with lock:
        progress = min(99, max(int(lease['job'].get('progress') or 0),
                               int(lease.get('_progress', 0)), parallel_progress(lease, progress)))
        lease['_progress'] = progress
        return _report_progress(client, lease, stage, progress, message, metrics)


def _report_progress(client, lease, stage, progress, message, metrics=None):
    current_run = run_id(lease)
    if current_run:
        metrics = stage_metrics(lease, stage, metrics)
        if lease.get('_resume'):
            metrics['resumePosition'] = dict(lease['_resume'])
        try:
            return client.call('worker-telemetry-v2', jobId=lease['job']['id'], token=lease['token'],
                               runId=current_run, sequence=sequence(lease), stage=stage,
                               progress=progress, message=message, metrics=metrics or {})
        except ApiError as error:
            if not transient_request_error(error):
                raise
            # Heartbeat and output receipts remain mandatory; a missed UI sample is not a failed video.
            print(f'Progress sample deferred: {error.code}', flush=True)
            return None
    return client.call('worker-progress', jobId=lease['job']['id'], token=lease['token'],
                       stage=stage, progress=progress, message=message)


def report_failure(client, lease, error, retryable=True):
    current_run = run_id(lease)
    if not current_run:
        raise ApiError('TERMINAL_PROTOCOL_REQUIRED')
    return client.call('worker-fail-v3', jobId=lease['job']['id'], token=lease['token'],
                       runId=current_run, error=error, retryable=retryable)


def finalization_status(client, lease):
    current_run = run_id(lease)
    if not current_run:
        raise ApiError('FINALIZATION_PROTOCOL_REQUIRED')
    response = client.call('worker-finalization-status-v3', jobId=lease['job']['id'],
                           token=lease['token'], runId=current_run)
    value = response.get('finalization')
    if not isinstance(value, dict) or value.get('state') not in {
            'COMMITTED', 'PENDING', 'DEFERRED', 'STALE'}:
        raise ApiError('FINALIZATION_STATUS_INVALID')
    return value


def finalize_result(client, lease, result, manifest, cancelled=None):
    current_run = run_id(lease)
    if not current_run:
        raise ApiError('FINALIZATION_PROTOCOL_REQUIRED')
    failure = None
    with resource_slot('finalize', cancelled):
        for attempt in range(2):
            try:
                client.call('worker-complete-v3', jobId=lease['job']['id'], token=lease['token'],
                            runId=current_run, result=result, manifest=manifest)
                return True
            except ApiError as error:
                if not transient_request_error(error):
                    raise
                failure = error
            try:
                state = finalization_status(client, lease)
            except ApiError as status_error:
                if not transient_request_error(status_error):
                    raise
                state = None
            if state and state['state'] == 'COMMITTED':
                return True
            if state and state['state'] == 'DEFERRED':
                return False
            if state and state['state'] == 'STALE':
                raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
            if attempt == 0:
                time.sleep(5)

        try:
            state = finalization_status(client, lease)
        except ApiError as status_error:
            if not transient_request_error(status_error):
                raise
            state = None
        if state and state['state'] == 'COMMITTED':
            return True
        if state and state['state'] == 'DEFERRED':
            return False
        if state and state['state'] == 'STALE':
            raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')

        code = getattr(failure, 'code', 'EDGE_UNAVAILABLE')
        allowed = {'DB_STATEMENT_TIMEOUT', 'DB_LOCK_TIMEOUT', 'DB_SERIALIZATION_RETRY',
                   'DB_DEADLOCK_RETRY', 'EDGE_UNAVAILABLE', 'EDGE_INVALID_RESPONSE',
                   'REQUEST_FAILED'}
        defer_error = {'code': code if code in allowed else 'EDGE_UNAVAILABLE',
                       'message': str(failure or 'finalization unavailable')[:500]}
        try:
            response = client.call('worker-defer-v3', jobId=lease['job']['id'],
                                   token=lease['token'], runId=current_run, error=defer_error)
            value = response.get('finalization')
            if not isinstance(value, dict) or value.get('state') not in {'COMMITTED', 'DEFERRED'}:
                raise ApiError('FINALIZATION_DEFER_INVALID')
            return value['state'] == 'COMMITTED'
        except ApiError as defer_failure:
            if not lease_cancelled(defer_failure):
                raise
            state = finalization_status(client, lease)
            if state['state'] == 'COMMITTED':
                return True
            if state['state'] == 'DEFERRED':
                return False
            raise

def content_type(path):
    if path.endswith('.m3u8'):
        return 'application/vnd.apple.mpegurl'
    if path.endswith('.ts'):
        return 'video/mp2t'
    if path.endswith('.webp'):
        return 'image/webp'
    if path.endswith('.mp3'):
        return 'audio/mpeg'
    return 'application/octet-stream'


def upload_concurrency():
    try:
        value = int(os.getenv('EASTUDY_UPLOAD_CONCURRENCY', '4'))
    except ValueError:
        value = 4
    return min(4, max(1, value))


def upload_assets(client, lease, output, assets, cancelled=None):
    return _upload_assets(client, lease, output, assets, cancelled)


def _upload_assets(client, lease, output, assets, cancelled=None):
    job_id = lease['job']['id']
    ordered = sorted(assets)
    if not ordered:
        raise ApiError('OUTPUT_ASSETS_EMPTY')
    manifest = {}
    last_progress = None
    total_bytes = sum(path.stat().st_size for path in ordered)
    uploaded_bytes = 0
    network_queue = 0.0
    network_active = 0.0
    network_requests = 0
    network_retries = 0

    def check_cancelled():
        if cancelled and cancelled.is_set():
            raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')

    units, batch, batch_size = [], [], 0
    for path in ordered:
        relative = path.relative_to(output).as_posix()
        if path.is_symlink() or not path.resolve().is_relative_to(Path(output).resolve()):
            raise ApiError('OUTPUT_PATH_INVALID')
        size = path.stat().st_size
        if not 0 < size <= 15 * 1024 ** 2:
            raise ApiError('OUTPUT_SIZE_LIMIT')
        eligible = (run_id(lease) and callable(getattr(client, 'upload_batch', None))
                    and re.fullmatch(r'voice/[a-f0-9]{64}\.mp3', relative) and size <= 1024 ** 2)
        if batch and (not eligible or len(batch) == 32 or batch_size + size > 2 * 1024 ** 2):
            units.append((True, batch))
            batch, batch_size = [], 0
        if eligible:
            batch.append((relative, path))
            batch_size += size
        else:
            units.append((False, [(relative, path)]))
    if batch:
        units.append((True, batch))

    def upload_unit(unit):
        check_cancelled()
        if hasattr(client, 'reset_network_timing'):
            client.reset_network_timing()
        is_batch, items = unit
        used_batch = is_batch
        if is_batch:
            try:
                rows = client.upload_batch(lease['outputUrl'], items)
            except ApiError as error:
                if not batch_protocol_fallback(error):
                    raise
                rows = [client.upload(lease['outputUrl'], lease['token'], job_id, *item)
                        for item in items]
                used_batch = False
        else:
            rows = [client.upload(lease['outputUrl'], lease['token'], job_id, *items[0])]
        if len(rows) != len(items):
            raise ApiError('OUTPUT_RECEIPT_MISMATCH')
        for (relative, path), receipt in zip(items, rows):
            if (int(receipt['size']) != path.stat().st_size or str(receipt['sha256']) != file_sha256(path)
                    or (used_batch and receipt.get('path') != relative)):
                raise ApiError('OUTPUT_RECEIPT_MISMATCH')
        registrations = []
        for (relative, _), receipt in zip(items, rows):
            check_cancelled()
            item = {'path': relative, 'size': int(receipt['size']), 'sha256': str(receipt['sha256'])}
            registrations.append({**item, 'etag': str(receipt['etag'])})
        if run_id(lease):
            if used_batch:
                try:
                    client.call('worker-output-receipts-v3', jobId=job_id, token=lease['token'],
                                runId=run_id(lease), receipts=registrations)
                except ApiError as error:
                    if not batch_protocol_fallback(error):
                        raise
                    for item in registrations:
                        client.call('worker-output-receipt-v2', jobId=job_id, token=lease['token'],
                                    runId=run_id(lease), **item)
            else:
                for item in registrations:
                    client.call('worker-output-receipt-v2', jobId=job_id, token=lease['token'],
                                runId=run_id(lease), **item)
        result = []
        for item in registrations:
            check_cancelled()
            receipt_key = hashlib.sha256((item['path'] + ':' + item['sha256']).encode()).hexdigest()
            atomic_json(Path(output) / '_upload_receipts' / (receipt_key + '.json'),
                        {'jobId': job_id, 'runId': run_id(lease), **item})
            result.append({key: item[key] for key in ('path', 'size', 'sha256')})
        timing = client.consume_network_timing() if hasattr(client, 'consume_network_timing') else {}
        return result, timing

    with ThreadPoolExecutor(max_workers=min(upload_concurrency(), len(units))) as executor:
        remaining = iter(units)
        futures = {executor.submit(upload_unit, unit): unit for unit in
                   [next(remaining) for _ in range(min(upload_concurrency(), len(units))) ]}
        completed = 0
        while futures:
            if cancelled and cancelled.is_set():
                for pending in futures:
                    pending.cancel()
                raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
            finished, _ = wait(futures, timeout=.25, return_when=FIRST_COMPLETED)
            if not finished:
                continue
            future = next(iter(finished))
            futures.pop(future)
            results, timing = future.result()
            completed += len(results)
            uploaded_bytes += sum(item['size'] for item in results)
            network_queue += float(timing.get('queueSeconds') or 0)
            network_active += float(timing.get('activeSeconds') or 0)
            network_requests += int(timing.get('requests') or 0)
            network_retries += int(timing.get('retries') or 0)
            for item in results:
                manifest[item['path']] = item
            relative = results[-1]['path']
            following = next(remaining, None)
            if following is not None:
                futures[executor.submit(upload_unit, following)] = following
            now = time.monotonic()
            if last_progress is None or completed == len(ordered) or now - last_progress >= 5:
                progress = 96 + int(3 * completed / len(ordered))
                report_progress(client, lease, 'LOCAL_UPLOAD', min(99, progress),
                                f'正在上传成品 {completed}/{len(ordered)}',
                                {'substage': relative, 'current': completed,
                                 'total': len(ordered), 'unit': 'files',
                                 'uploadedBytes': uploaded_bytes, 'totalBytes': total_bytes,
                                 'networkQueueSeconds': round(network_queue, 3),
                                 'networkActiveSeconds': round(network_active, 3),
                                 'networkRequests': network_requests,
                                 'networkRetries': network_retries})
                last_progress = time.monotonic()
    return [manifest[path.relative_to(output).as_posix()] for path in ordered]


def capabilities():
    try:
        _, profile = prepare_asr_model(verify_inference=True)
        whisper = True
        whisper_detail = {**profile, 'inferenceReady': True}
    except Exception as error:
        whisper = False
        whisper_detail = {'inferenceReady': False, 'error': str(error)[:240]}
    deepseek = all(os.getenv(name, '').strip() for name in
                   ('ZOSPEAK_AI_API_KEY', 'ZOSPEAK_AI_BASE_URL', 'ZOSPEAK_AI_MODEL'))
    voice = voice_capability(worker_root() / 'voice-health')
    return {'ffmpeg': bool(shutil.which('ffmpeg') and shutil.which('ffprobe')),
            'whisper': whisper, 'asr': whisper_detail,
            'deepseek': bool(deepseek), 'learningRepairV4': True,
            'learningRepairV5': True, 'teachingSchemaVersion': 3,
            'teachingVoiceV1': voice['inferenceReady'], 'voice': voice,
            'teachingPromptVersion': TEACHING_PROMPT_VERSION,
            'platform': platform.system().lower(), 'mediaProfile': ladder(1280, 720)[0]['profileVersion']}


def configure_ai_environment():
    aliases = {
        'ZOSPEAK_AI_API_KEY': 'DEEPSEEK_API_KEY',
        'ZOSPEAK_AI_BASE_URL': 'DEEPSEEK_BASE_URL',
        'ZOSPEAK_AI_MODEL': 'AI_DEEPSEEK_TRANSLATE_MODEL'
    }
    for target, source in aliases.items():
        if not os.getenv(target) and os.getenv(source):
            os.environ[target] = os.environ[source]


def default_worker_id(hostname=None):
    hostname = socket.gethostname() if hostname is None else str(hostname)
    host_id = re.sub(r'[^a-z0-9._-]+', '-', hostname.lower()).strip('.-_')
    if len(host_id) < 3:
        host_id = hostname.encode('utf-8').hex()[:32]
    return 'eastudy-' + host_id[:60]


def download_response_mode(status, headers, offset, total, etag):
    if str(headers.get('ETag') or '') != etag:
        raise ApiError('SOURCE_VERSION_CHANGED')
    if status == 206:
        expected = f'bytes {offset}-{total - 1}/{total}'
        if headers.get('Content-Range') != expected:
            raise ApiError('SOURCE_CONTENT_RANGE_MISMATCH')
        return 'ab', total - offset
    if status == 200:
        return 'wb', total
    raise ApiError(f'SOURCE_HTTP_{status}')


def worker_root():
    configured = os.getenv('EASTUDY_WORK_ROOT', '').strip()
    base = Path(configured) if configured else Path(os.getenv('LOCALAPPDATA', str(ROOT))) / 'Eastudy' / 'processing-jobs'
    base.mkdir(parents=True, exist_ok=True)
    return base.resolve()


def download(url, target, progress=None, source_key=None):
    target = Path(target)
    partial = target.with_suffix(target.suffix + '.part')
    sidecar = target.with_suffix(target.suffix + '.source.json')
    headers = {'User-Agent': f'EastudyCloudWorker/{VERSION}'}
    head_request = urllib.request.Request(url, method='HEAD', headers=headers)
    with urllib.request.urlopen(head_request, timeout=90) as response:
        total = int(response.headers.get('Content-Length') or 0)
        etag = str(response.headers.get('ETag') or '')
    if total <= 0 or not etag:
        raise ApiError('SOURCE_METADATA_INCOMPLETE')
    expected = {'version': 1, 'etag': etag, 'totalBytes': total}
    try:
        local_hit = bool(source_key) and SourceCache(worker_root() / 'source-intake').restore(source_key, total, etag, target)
    except (OSError, ValueError):
        local_hit = False
    if local_hit:
        if progress:
            progress(total, total)
        return
    try:
        saved = json.loads(sidecar.read_text(encoding='utf-8')) if sidecar.is_file() else None
    except (OSError, ValueError):
        saved = None
    metadata_matches = isinstance(saved, dict) and all(saved.get(k) == v for k, v in expected.items())
    digest = saved.get('contentHash', '') if metadata_matches else ''
    if (target.is_file() and target.stat().st_size == total
            and isinstance(digest, str) and re.fullmatch(r'[a-f0-9]{64}', digest)
            and file_sha256(target) == digest):
        if progress:
            progress(total, total)
        return
    if partial.exists() and (not metadata_matches or partial.stat().st_size >= total):
        partial.write_bytes(b'')
    atomic_json(sidecar, expected)
    offset = partial.stat().st_size if partial.is_file() else 0
    request_headers = dict(headers)
    if offset:
        request_headers.update({'Range': f'bytes={offset}-', 'If-Range': etag})
    request = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(request, timeout=300) as response:
        mode, expected_bytes = download_response_mode(response.status, response.headers, offset, total, etag)
        received = 0
        with partial.open(mode) as output:
            if mode == 'wb':
                offset = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                received += len(chunk)
                if progress:
                    progress(offset + received, total)
            output.flush()
            os.fsync(output.fileno())
        if received != expected_bytes:
            raise ApiError('SOURCE_DOWNLOAD_TRUNCATED')
    if partial.stat().st_size != total:
        raise ApiError('SOURCE_DOWNLOAD_SIZE_MISMATCH')
    os.replace(partial, target)
    if not target.is_file() or target.stat().st_size == 0:
        raise ApiError('SOURCE_DOWNLOAD_EMPTY')
    atomic_json(sidecar, {**expected, 'contentHash': file_sha256(target)})


def selected_assets(output, result):
    output = Path(output)
    paths = [output / 'master.m3u8', output / 'cover.webp']
    for row in result.get('video', {}).get('coverImages', []):
        relative = str(row.get('path') or '')
        if not re.fullmatch(r'cover-(320|640|960)\.webp', relative):
            raise ApiError('OUTPUT_COVER_PATH_INVALID')
        paths.append(output / relative)
    variants = result.get('video', {}).get('playback', {}).get('variants', [])
    for row in variants:
        relative = str(row.get('path') or '')
        if not re.fullmatch(r'[0-9]{3,4}p/index\.m3u8', relative):
            raise ApiError('OUTPUT_VARIANT_PATH_INVALID')
        folder = (output / relative).parent
        paths.extend(path for path in folder.iterdir()
                     if path.is_file() and path.suffix.lower() in {'.m3u8', '.ts'})
    voice = result.get('video', {}).get('voiceManifest')
    if voice is not None:
        paths.extend(voice_assets(output, voice))
    assets = sorted(set(paths))
    if any(path.is_symlink() or not path.resolve().is_relative_to(output.resolve()) for path in assets):
        raise ApiError('OUTPUT_PATH_INVALID')
    if any(not path.is_file() or path.stat().st_size <= 0 for path in assets):
        raise ApiError('OUTPUT_ASSETS_EMPTY')
    return assets


def validate_teaching(client, lease, rows):
    if not run_id(lease):
        raise ApiError('TEACHING_VALIDATION_PROTOCOL_REQUIRED')
    validate_completed_teaching(rows)
    response = client.call('worker-validate-teaching-v2', jobId=lease['job']['id'],
        runId=run_id(lease), token=lease['token'], sentences=rows)
    value = response.get('validation')
    if not isinstance(value, dict) or value.get('valid') is not True:
        raise ApiError('TEACHING_VALIDATION_FAILED')
    return value


def preflight_output(lease):
    return request_json(urllib.request.Request(lease['outputUrl'] + '&path=cover.webp',
        method='GET', headers={'User-Agent': f'EastudyCloudWorker/{VERSION}'}), 30, 'OUTPUT', retryable=True)


def prepare_voice(client, lease, rows, output, cancelled):
    with resource_slot('gpu', cancelled):
        return _prepare_voice(client, lease, rows, output, cancelled)


def _prepare_voice(client, lease, rows, output, cancelled):
    video_id = str(lease['job'].get('video_id') or '')
    if not video_id or not run_id(lease):
        raise ApiError('VOICE_JOB_IDENTITY_REQUIRED')
    last_reported = [0.0]
    report_progress(client, lease, 'ENRICH', 95, '正在生成单词与短语发音',
                    {'substage': 'teaching-voice', 'current': 0, 'unit': 'items'})
    def progress(event):
        now = time.monotonic()
        current, total = int(event['current']), int(event['total'])
        if current < total and now - last_reported[0] < 5:
            return
        last_reported[0] = now
        metrics = {'substage': 'teaching-voice', 'current': current, 'total': total, 'unit': 'items'}
        for key in ('uniqueTotal', 'uniqueReady', 'generated', 'reused', 'failed',
                    'elapsedSeconds', 'cacheWriteFailures'):
            value = event.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
                metrics[key] = value
        message = f'已处理发音位置 {current}/{total}'
        if 'generated' in metrics and 'reused' in metrics:
            message += f"；新生成 {metrics['generated']}，复用 {metrics['reused']}"
        if metrics.get('failed'):
            message += f"，失败 {metrics['failed']}"
        report_progress(client, lease, 'ENRICH', 95, message, metrics)
    return generate_worker_voice(video_id, run_id(lease), rows, output, cancelled, progress)


def rewrite_result(result, job_id, source_key):
    base = f'/api/processing/media/{job_id}'
    video = result['video']
    video['cover'] = f'{base}/cover.webp'
    video['coverImages'] = [{**row, 'url': f"{base}/{row['path']}"}
                            for row in video.get('coverImages', [])]
    playback = video.get('playback', {})
    published_variants = [{**row, 'url': f"{base}/{row['path']}"}
                          for row in playback.get('variants', [])]
    video['mediaUrl'] = published_variants[0]['url']
    video['playback'] = {'policy': 'single-standard-v2', 'masterUrl': video['mediaUrl'],
                         'variants': published_variants}
    result.setdefault('evidence', {})['storage'] = 'cloudflare-r2'
    result['evidence']['workerVersion'] = VERSION
    return result


def heartbeat_loop(client, lease, stop, cancelled):
    last_success = time.monotonic()
    while not stop.wait(5):
        try:
            current_run = run_id(lease)
            client.call('worker-job-heartbeat-v2' if current_run else 'worker-job-heartbeat',
                        jobId=lease['job']['id'], token=lease['token'], **({'runId': current_run} if current_run else {}))
            last_success = time.monotonic()
        except Exception as error:
            print(f'[heartbeat] {error}', flush=True)
            if lease_cancelled(error) or time.monotonic() - last_success >= 120:
                cancelled.set()
                stop.set()
                return


def resolve_input_source(lease, local_inputs, cloud_download, target, progress=None):
    descriptor = lease.get('inputSource') or {'kind': 'cloud_r2', 'key': lease['job']['source_key']}
    if descriptor.get('kind') == 'local_file':
        if not local_inputs or descriptor.get('workerId') != lease.get('workerId'):
            raise ApiError('LOCAL_SOURCE_WRONG_WORKER')
        if descriptor.get('jobId') != lease['job']['id']:
            raise ApiError('SOURCE_DECLARATION_CONFLICT')
        source = local_inputs.require_ready(descriptor)
        cover = local_inputs.file(descriptor['sourceId'], 'cover.input') if descriptor.get('coverSha256') else None
        if cover and (not cover.is_file() or file_sha256(cover) != descriptor['coverSha256']):
            raise ApiError('COVER_INCOMPLETE')
        return source, cover
    if descriptor.get('kind') != 'cloud_r2':
        raise ApiError('SOURCE_KIND_INVALID')
    cloud_download(lease['downloadUrl'], target, progress, descriptor['key'])
    return target, None


def process_lease(client, lease, local_inputs=None, ai_settings=None):
    job_id = lease['job']['id']
    stop = threading.Event()
    cancelled = threading.Event()
    thread = threading.Thread(target=heartbeat_loop, args=(client, lease, stop, cancelled), daemon=True)
    thread.start()
    try:
        if not re.fullmatch(r'[0-9a-f-]{36}', job_id, re.I):
            raise ApiError('JOB_ID_INVALID')
        current_run = run_id(lease)
        if current_run and not re.fullmatch(r'[0-9a-f-]{36}', current_run, re.I):
            raise ApiError('RUN_ID_INVALID')
        job_root = worker_root() / job_id
        work = job_root / (current_run or 'legacy')
        work.mkdir(parents=True, exist_ok=True)
        if not work.resolve().is_relative_to(worker_root()):
            raise ApiError('WORK_PATH_INVALID')
        configured = ai_settings.snapshot() if ai_settings is not None else {}
        ai_config = job_usage_config({**configured, 'detailReviewMode': 'delta',
                                      'eligibilityContextMode': 'table', 'cancelled': cancelled},
                                    job_id, work, run_id(lease))
        job_input = lease['job'].get('input') or {}
        if job_input.get('kind') == 'MEDIA_REENCODE':
            # A generic admin retry must never send a media-only job through AI.
            report_failure(client, lease, {'code': 'MEDIA_REENCODE_OPERATOR_REQUIRED',
                'message': '请通过媒体维护命令继续此任务，现有视频与学习内容保持不变。'}, False)
            return
        if job_input.get('kind') == 'LEARNING_REPAIR':
            if not run_id(lease):
                raise ApiError('LEARNING_REPAIR_PROTOCOL_REQUIRED')
            rows = job_input.get('sentences')
            if not isinstance(rows, list) or not rows:
                raise ApiError('LEARNING_REPAIR_INPUT_INVALID')
            report_progress(client, lease, 'ENRICH', 72, '正在补齐缺失翻译与释义',
                            {'substage': 'learning-repair', 'current': 0, 'total': len(rows), 'unit': 'sentences'})
            def repair_progress(_stage, progress, message, **metrics):
                if cancelled.is_set():
                    raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
                report_progress(client, lease, 'ENRICH', min(99, int(progress)), message, metrics)
            repair_mode = str(job_input.get('mode') or 'fill_missing')
            preflight_output(lease)
            repaired, provenance = repair_learning(rows, ai_config, repair_progress,
                                                   work / 'learning-repair-cache', repair_mode)
            repaired, completion_provenance = complete_teaching(
                repaired, ai_config, repair_progress, work / 'teaching-completion-cache')
            validate_teaching(client, lease, repaired)
            provenance.extend(completion_provenance)
            if cancelled.is_set():
                raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
            output = work / 'output' / job_id
            voice = prepare_voice(client, lease, repaired, output, cancelled)
            upload_assets(client, lease, output, voice_assets(output, voice), cancelled)
            if cancelled.is_set():
                raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
            client.call('worker-complete-learning-v5', jobId=job_id, token=lease['token'],
                        runId=run_id(lease), result={'teachingSchemaVersion': 3, 'sentences': repaired,
                        'voiceManifest': voice,
                        'evidence': {'kind': 'learning-repair-v5', 'teachingSchemaVersion': 3,
                            'aiUsage': summarize_usage(ai_config['usageLogPath'], ai_config['runId']),
                            'provenance': provenance}})
            print(f'[complete-learning-repair] {job_id}', flush=True)
            return
        source = work / Path(lease['job']['source_key']).name
        has_checkpoint = (job_root / 'final-output.json').is_file()
        previous_progress = int(lease['job'].get('progress') or 0)
        if has_checkpoint or previous_progress > 0 or (lease['job'].get('work') or {}).get('resumePosition'):
            lease['_resume'] = {'verified': False, 'phase': 'validating',
                                'progress': min(99, max(0, previous_progress))}
        if has_checkpoint:
            report_progress(client, lease, 'LOCAL_UPLOAD', 96, '发现成品断点，正在校验原片与成品；不会重新调用 AI')
        else:
            report_progress(client, lease, 'LOCAL_DOWNLOAD', 2, '正在检查原片与阶段断点')
        last_reported = [0.0]
        def report_download(current, total):
            if cancelled.is_set():
                raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
            now = time.monotonic()
            if current < total and now - last_reported[0] < 5:
                return
            last_reported[0] = now
            percent = 96 if has_checkpoint else min(8, 2 + int(6 * current / max(total, 1)))
            report_progress(client, lease, 'LOCAL_UPLOAD' if has_checkpoint else 'LOCAL_DOWNLOAD', percent,
                            f'正在读取原片以校验断点 {current}/{total} 字节',
                            {'substage': 'source', 'current': current, 'total': total, 'unit': 'bytes'})
        source, cover = resolve_input_source(lease, local_inputs, download, source, report_download)
        if cancelled.is_set():
            raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
        restored = restore_final_output(job_root, lease['job'], source, cover, current_run, selected_assets)
        if restored is not None:
            output, final = restored
            validate_teaching(client, lease, final['sentences'])
            lease['_resume'] = {**lease['_resume'], 'verified': True, 'phase': 'final'}
            report_progress(client, lease, 'LOCAL_UPLOAD', 96, '正在续传已完成的成品，无需重新生成')
            manifest = upload_assets(client, lease, output, selected_assets(output, final), cancelled)
            if cancelled.is_set():
                raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
            final = rewrite_result(final, job_id, lease['job']['source_key'])
            if not finalize_result(client, lease, final, manifest, cancelled):
                print(f'[deferred-finalization] {job_id}', flush=True)
                return
            print(f'[complete-restored] {job_id}', flush=True)
            return
        if lease.get('_resume'):
            lease['_resume'] = {**lease['_resume'], 'phase': 'stages'}
        store = RemoteProgressStore(client, lease)
        def upload_media(value, output):
            partial = {'video': {'coverImages': value['coverImages'], 'playback': {'variants': value['variants']}}}
            return upload_assets(client, lease, output, selected_assets(output, partial), cancelled)

        def observe(stage, state):
            with lease.setdefault('_progress_lock', threading.RLock()):
                record_stage(lease, stage, state)
                wire_stage = {'media': 'TRANSCODE', 'asr': 'ASR', 'teaching': 'ENRICH',
                              'voice': 'ENRICH', 'upload_media': 'LOCAL_UPLOAD', 'upload_voice': 'LOCAL_UPLOAD'}[stage]
                message = '正在复用有效阶段断点并处理剩余内容' if lease.get('_resume') else '正在自动制作视频'
                report_progress(client, lease, wire_stage, 15, message, {'stageName': stage})
            if local_inputs:
                local_inputs.stage(job_id, current_run, stage, state)

        execution = {'cache_root': job_root / 'artifacts', 'observe': observe,
            'preflight_output': lambda: preflight_output(lease),
            'validate_teaching': lambda rows: validate_teaching(client, lease, rows),
            'voice': lambda rows, output: prepare_voice(client, lease, rows, output, cancelled),
            'upload_media': upload_media,
            'upload_voice': lambda voice, output: upload_assets(client, lease, output, voice_assets(output, voice), cancelled)}
        with cancellation_scope(cancelled):
            result_job = process_job(store, job_id, source, cover, ai_config, work / 'output', base_url='', execution=execution)
        if cancelled.is_set():
            raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
        if result_job.get('status') != 'REVIEW':
            error = result_job.get('error') or {'code': 'PIPELINE_FAILED', 'message': result_job.get('message', '处理失败')}
            message = f'[pipeline-error] {job_id}: {error.get("code")}: {error.get("message")}'
            print(message, flush=True)
            print(message, file=sys.stderr, flush=True)
            report_failure(client, lease, error, bool(error.get('retryable', True)))
            return
        output = work / 'output' / job_id
        manifest = result_job['result'].pop('_uploadedManifest')
        expected = sorted((path.relative_to(output).as_posix(), path.stat().st_size, file_sha256(path))
                          for path in selected_assets(output, result_job['result']))
        actual = sorted((item['path'], item['size'], item['sha256']) for item in manifest)
        if actual != expected:
            raise ApiError('OUTPUT_MANIFEST_MISMATCH')
        save_final_output(job_root, lease['job'], source, cover, output, result_job['result'], manifest)
        if cancelled.is_set():
            raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
        final = rewrite_result(result_job['result'], job_id, lease['job']['source_key'])
        if not finalize_result(client, lease, final, manifest, cancelled):
            print(f'[deferred-finalization] {job_id}', flush=True)
            return
        print(f'[complete] {job_id}', flush=True)
    except Exception as error:
        message = f'[error] {job_id}: {error}'
        print(message, flush=True)
        print(message, file=sys.stderr, flush=True)
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        if cancelled.is_set() or lease_cancelled(error):
            print(f'[cancelled] {job_id}: stale lease stopped before the next stage', flush=True)
            return
        try:
            report_failure(client, lease,
                           {'code': str(getattr(error, 'code', type(error).__name__))[:80],
                            'message': str(error)[:500]}, bool(getattr(error, 'retryable', True)))
        except Exception as report_error:
            print(f'[error-report] {report_error}', flush=True)
    finally:
        stop.set()
        thread.join(timeout=2)
        if 'ai_config' in locals():
            print('[ai-usage] ' + json.dumps(summarize_usage(
                ai_config['usageLogPath'], ai_config['runId']), ensure_ascii=False), flush=True)


def worker_loop(client, caps, local_inputs, ai_settings, once=False):
    limit = min(2, parallel_workers())
    running = set()
    with ThreadPoolExecutor(max_workers=limit, thread_name_prefix='processing-job') as pool:
        while True:
            try:
                finished = {future for future in running if future.done()}
                for future in finished:
                    running.remove(future)
                    future.result()
                if len(running) >= limit:
                    wait(running, timeout=.25, return_when=FIRST_COMPLETED)
                    continue
                configured = ai_settings.snapshot()
                caps['deepseek'] = all(configured.get(k) for k in ('baseUrl', 'model', 'apiKey'))
                if not all(caps.get(name) for name in ('ffmpeg', 'whisper', 'deepseek', 'teachingVoiceV1')):
                    client.call('worker-heartbeat')
                    if once:
                        return 2
                    time.sleep(60)
                    caps = capabilities()
                    caps['localInputV1'] = local_inputs is not None
                    client.capabilities = caps
                    continue
                lease = client.call('worker-claim-local-v1') if caps.get('localInputV1') else {}
                if not lease.get('job'):
                    lease = client.call('worker-claim')
                if lease.get('job'):
                    running.add(pool.submit(process_lease, client, lease, local_inputs, ai_settings))
                elif running:
                    wait(running, timeout=1, return_when=FIRST_COMPLETED)
                elif once:
                    return 0
                else:
                    time.sleep(15)
            except KeyboardInterrupt:
                return 0
            except Exception as error:
                print(f'[poll] {error}', flush=True)
                if once:
                    return 1
                time.sleep(20)


def main():
    parser = argparse.ArgumentParser(description='Eastudy production R2/Supabase desktop video worker')
    parser.add_argument('--once', action='store_true', help='drain available jobs and exit when idle')
    parser.add_argument('--check', action='store_true', help='report local readiness and exit')
    args = parser.parse_args()
    configure_ai_environment()
    ai_settings = SettingsStore(worker_root() / 'settings' / 'ai.json')
    caps = capabilities()
    caps['deepseek'] = all(ai_settings.snapshot().get(k) for k in ('baseUrl', 'model', 'apiKey'))
    if args.check:
        print(json.dumps({'ready': all(caps.get(x) for x in ('ffmpeg', 'whisper', 'deepseek', 'teachingVoiceV1')), 'capabilities': caps}, ensure_ascii=False))
        return 0 if all(caps.get(x) for x in ('ffmpeg', 'whisper', 'deepseek', 'teachingVoiceV1')) else 2
    secret = os.getenv('EASTUDY_WORKER_SECRET', '').strip()
    if not secret:
        print('缺少 EASTUDY_WORKER_SECRET；请运行安装脚本或设置用户环境变量。', file=sys.stderr)
        return 2
    worker_id = os.getenv('EASTUDY_WORKER_ID', '').strip() or default_worker_id()
    client = EdgeClient(os.getenv('EASTUDY_PROCESSING_ENDPOINT', DEFAULT_ENDPOINT).strip(), secret, worker_id, caps)
    try:
        start_ai_settings(ai_settings)
        print('[ai-settings] loopback ready', flush=True)
    except OSError:
        print('[ai-settings] unavailable: port 8791 is occupied', flush=True)
    local_inputs = None
    try:
        local_inputs = LocalInputs(worker_root() / 'local-inputs-v1')
        start_local_intake(local_inputs, client)
        caps['localInputV1'] = True
    except (OSError, ValueError) as error:
        if local_inputs:
            local_inputs.close()
        local_inputs = None
        caps['localInputV1'] = False
        print(f'[local-input] unavailable: {type(error).__name__}', flush=True)
    try:
        start_intake(SourceCache(worker_root() / 'source-intake'))
        print('[source-intake] loopback ready', flush=True)
    except OSError:
        print('[source-intake] unavailable; cloud download remains active', flush=True)
    print(f'Eastudy Worker {VERSION} started: {worker_id} {caps}', flush=True)
    try:
        client.call('worker-heartbeat')
    except Exception as error:
        print(f'[startup-heartbeat] {error}', flush=True)
    return worker_loop(client, caps, local_inputs, ai_settings, once=args.once)

if __name__ == '__main__':
    raise SystemExit(main())

