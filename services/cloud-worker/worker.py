import argparse
import json
import os
import platform
import re
import shutil
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCAL_STUDIO = ROOT / 'services' / 'local-studio'
sys.path.insert(0, str(LOCAL_STUDIO))

from pipeline import process_job  # noqa: E402
from ai_tools import prepare_asr_model  # noqa: E402
from checkpoint import atomic_json  # noqa: E402


VERSION = '2.0.0'
DEFAULT_ENDPOINT = 'https://ehxqtgakjgqgmghhdmjg.supabase.co/functions/v1/video-processing'
STAGE_MAP = {'probe': 'PROBE', 'transcode': 'TRANSCODE', 'asr': 'ASR', 'enrich': 'ENRICH'}


class ApiError(RuntimeError):
    pass


class EdgeClient:
    def __init__(self, endpoint, secret, worker_id, capabilities):
        self.endpoint = endpoint
        self.secret = secret
        self.worker_id = worker_id
        self.capabilities = capabilities

    def call(self, action, **values):
        payload = {'action': action, 'workerId': self.worker_id, 'version': VERSION,
                   'capabilities': self.capabilities, **values}
        request = urllib.request.Request(self.endpoint, data=json.dumps(payload).encode('utf-8'), method='POST', headers={
            'Content-Type': 'application/json', 'x-worker-secret': self.secret,
            'User-Agent': f'EastudyCloudWorker/{VERSION}'})
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                result = json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as error:
            detail = error.read().decode('utf-8', 'replace')[:500]
            raise ApiError(f'EDGE_HTTP_{error.code}:{detail}') from error
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            raise ApiError(f'EDGE_UNAVAILABLE:{error}') from error
        if not result.get('ok'):
            raise ApiError(str(result.get('error') or 'EDGE_REQUEST_FAILED'))
        return result

    def upload(self, base_url, token, job_id, path, source):
        url = base_url + '&path=' + urllib.parse.quote(path, safe='/')
        data = Path(source).read_bytes()
        request = urllib.request.Request(url, data=data, method='PUT', headers={
            'Content-Type': content_type(path), 'Content-Length': str(len(data)),
            'User-Agent': f'EastudyCloudWorker/{VERSION}'})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                result = json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as error:
            detail = error.read().decode('utf-8', 'replace')[:500]
            raise ApiError(f'OUTPUT_HTTP_{error.code}:{detail}') from error
        if not result.get('ok'):
            raise ApiError(str(result.get('error') or 'OUTPUT_UPLOAD_FAILED'))
        return result


class RemoteProgressStore:
    def __init__(self, client, lease):
        job = lease['job']
        self.client = client
        self.lease = lease
        self._last_metric = None
        self._rate = None
        self._samples = 0
        self.job = {'id': job['id'], 'status': 'PROCESSING', 'currentStep': 'upload', 'progress': 1,
                    'message': '正在下载云端原片', 'error': None, 'result': None,
                    'sourceName': Path(job['source_key']).name, 'metadata': job.get('input') or {}}

    def get(self, job_id):
        if job_id != self.job['id']:
            raise KeyError(job_id)
        return dict(self.job)

    def update(self, job_id, **changes):
        if job_id != self.job['id']:
            raise KeyError(job_id)
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
    current_run = run_id(lease)
    if current_run:
        return client.call('worker-telemetry-v2', jobId=lease['job']['id'], token=lease['token'],
                           runId=current_run, sequence=sequence(lease), stage=stage,
                           progress=progress, message=message, metrics=metrics or {})
    return client.call('worker-progress', jobId=lease['job']['id'], token=lease['token'],
                       stage=stage, progress=progress, message=message)


def report_failure(client, lease, error, retryable=True):
    current_run = run_id(lease)
    action = 'worker-fail-v2' if current_run else 'worker-fail'
    values = {'jobId': lease['job']['id'], 'token': lease['token'], 'error': error,
              'retryable': retryable}
    if current_run:
        values['runId'] = current_run
    return client.call(action, **values)


def content_type(path):
    if path.endswith('.m3u8'):
        return 'application/vnd.apple.mpegurl'
    if path.endswith('.ts'):
        return 'video/mp2t'
    if path.endswith('.webp'):
        return 'image/webp'
    return 'application/octet-stream'


def upload_concurrency():
    try:
        value = int(os.getenv('EASTUDY_UPLOAD_CONCURRENCY', '6'))
    except ValueError:
        value = 6
    return min(8, max(1, value))


def upload_assets(client, lease, output, assets):
    job_id = lease['job']['id']
    ordered = sorted(assets)
    manifest = {}

    def upload_one(path):
        relative = path.relative_to(output).as_posix()
        receipt = client.upload(lease['outputUrl'], lease['token'], job_id, relative, path)
        return relative, receipt

    with ThreadPoolExecutor(max_workers=min(upload_concurrency(), len(ordered))) as executor:
        futures = {executor.submit(upload_one, path): path for path in ordered}
        for completed, future in enumerate(as_completed(futures), 1):
            relative, receipt = future.result()
            item = {'path': relative, 'size': int(receipt['size']), 'sha256': str(receipt['sha256'])}
            manifest[relative] = item
            if run_id(lease):
                client.call('worker-output-receipt-v2', jobId=job_id, token=lease['token'],
                            runId=run_id(lease), path=relative, size=item['size'],
                            sha256=item['sha256'], etag=str(receipt['etag']))
            progress = 96 + int(3 * completed / len(ordered))
            report_progress(client, lease, 'LOCAL_UPLOAD', min(99, progress),
                            f'正在上传成品 {completed}/{len(ordered)}',
                            {'substage': relative, 'current': completed,
                             'total': len(ordered), 'unit': 'files'})
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
    return {'ffmpeg': bool(shutil.which('ffmpeg') and shutil.which('ffprobe')),
            'whisper': whisper, 'asr': whisper_detail,
            'deepseek': bool(deepseek), 'platform': platform.system().lower()}


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


def download(url, target, progress=None):
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
        saved = json.loads(sidecar.read_text(encoding='utf-8')) if sidecar.is_file() else None
    except (OSError, ValueError):
        saved = None
    if target.is_file() and target.stat().st_size == total and saved == expected:
        if progress:
            progress(total, total)
        return
    if partial.exists() and (saved != expected or partial.stat().st_size > total):
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


def selected_assets(output, result):
    output = Path(output)
    paths = [output / 'master.m3u8', output / 'cover.webp']
    variants = result.get('video', {}).get('playback', {}).get('variants', [])
    for row in variants:
        relative = str(row.get('path') or '')
        if not re.fullmatch(r'[0-9]{3,4}p/index\.m3u8', relative):
            raise ApiError('OUTPUT_VARIANT_PATH_INVALID')
        folder = (output / relative).parent
        paths.extend(path for path in folder.iterdir()
                     if path.is_file() and path.suffix.lower() in {'.m3u8', '.ts'})
    assets = sorted(set(paths))
    if any(not path.is_file() or path.stat().st_size <= 0 for path in assets):
        raise ApiError('OUTPUT_ASSETS_EMPTY')
    return assets


def rewrite_result(result, job_id, source_key):
    base = f'/api/processing/media/{job_id}'
    video = result['video']
    video['cover'] = f'{base}/cover.webp'
    video['mediaUrl'] = f'{base}/master.m3u8'
    playback = video.get('playback', {})
    original = dict(playback.get('original') or {})
    original['url'] = '/api/media?key=' + urllib.parse.quote(source_key, safe='')
    original.setdefault('label', '1080p 原画')
    video['playback'] = {'masterUrl': video['mediaUrl'], 'variants': [
        {**row, 'url': f"{base}/{row['path']}"} for row in playback.get('variants', [])
    ], 'original': original}
    result.setdefault('evidence', {})['storage'] = 'cloudflare-r2'
    result['evidence']['workerVersion'] = VERSION
    return result


def heartbeat_loop(client, lease, stop):
    while not stop.wait(30):
        try:
            current_run = run_id(lease)
            client.call('worker-job-heartbeat-v2' if current_run else 'worker-job-heartbeat',
                        jobId=lease['job']['id'], token=lease['token'], **({'runId': current_run} if current_run else {}))
        except Exception as error:
            print(f'[heartbeat] {error}', flush=True)


def process_lease(client, lease):
    job_id = lease['job']['id']
    stop = threading.Event()
    thread = threading.Thread(target=heartbeat_loop, args=(client, lease, stop), daemon=True)
    thread.start()
    try:
        if not re.fullmatch(r'[0-9a-f-]{36}', job_id, re.I):
            raise ApiError('JOB_ID_INVALID')
        work = worker_root() / job_id
        work.mkdir(parents=True, exist_ok=True)
        if not work.resolve().is_relative_to(worker_root()):
            raise ApiError('WORK_PATH_INVALID')
        source = work / Path(lease['job']['source_key']).name
        report_progress(client, lease, 'LOCAL_DOWNLOAD', 2, '正在从 R2 下载原片')
        last_reported = [0.0]
        def report_download(current, total):
            now = time.monotonic()
            if current < total and now - last_reported[0] < 5:
                return
            last_reported[0] = now
            percent = min(8, 2 + int(6 * current / max(total, 1)))
            report_progress(client, lease, 'LOCAL_DOWNLOAD', percent,
                            f'正在下载原片 {current}/{total} 字节',
                            {'substage': 'source', 'current': current, 'total': total, 'unit': 'bytes'})
        download(lease['downloadUrl'], source, report_download)
        store = RemoteProgressStore(client, lease)
        result_job = process_job(store, job_id, source, None, {}, work / 'output', base_url='')
        if result_job.get('status') != 'REVIEW':
            error = result_job.get('error') or {'code': 'PIPELINE_FAILED', 'message': result_job.get('message', '处理失败')}
            report_failure(client, lease, error, bool(error.get('retryable', True)))
            return
        report_progress(client, lease, 'LOCAL_UPLOAD', 96, '正在把 HLS 与封面上传回 R2')
        output = work / 'output' / job_id
        assets = selected_assets(output, result_job['result'])
        manifest = upload_assets(client, lease, output, assets)
        final = rewrite_result(result_job['result'], job_id, lease['job']['source_key'])
        if run_id(lease):
            client.call('worker-complete-v2', jobId=job_id, token=lease['token'], runId=run_id(lease),
                        result=final, manifest=manifest)
        else:
            client.call('worker-complete', jobId=job_id, token=lease['token'], result=final)
        print(f'[complete] {job_id}', flush=True)
    except Exception as error:
        print(f'[error] {job_id}: {error}', flush=True)
        try:
            report_failure(client, lease,
                           {'code': type(error).__name__[:80], 'message': str(error)[:500]}, True)
        except Exception as report_error:
            print(f'[error-report] {report_error}', flush=True)
    finally:
        stop.set()
        thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description='Eastudy production R2/Supabase desktop video worker')
    parser.add_argument('--once', action='store_true', help='poll once and exit')
    parser.add_argument('--check', action='store_true', help='report local readiness and exit')
    args = parser.parse_args()
    configure_ai_environment()
    caps = capabilities()
    if args.check:
        print(json.dumps({'ready': all(caps.get(x) for x in ('ffmpeg', 'whisper', 'deepseek')), 'capabilities': caps}, ensure_ascii=False))
        return 0 if all(caps.get(x) for x in ('ffmpeg', 'whisper', 'deepseek')) else 2
    secret = os.getenv('EASTUDY_WORKER_SECRET', '').strip()
    if not secret:
        print('缺少 EASTUDY_WORKER_SECRET；请运行安装脚本或设置用户环境变量。', file=sys.stderr)
        return 2
    worker_id = os.getenv('EASTUDY_WORKER_ID', '').strip() or default_worker_id()
    client = EdgeClient(os.getenv('EASTUDY_PROCESSING_ENDPOINT', DEFAULT_ENDPOINT).strip(), secret, worker_id, caps)
    print(f'Eastudy Worker {VERSION} started: {worker_id} {caps}', flush=True)
    while True:
        try:
            lease = client.call('worker-claim')
            if lease.get('job'):
                process_lease(client, lease)
            elif args.once:
                return 0
            else:
                time.sleep(15)
        except KeyboardInterrupt:
            return 0
        except Exception as error:
            print(f'[poll] {error}', flush=True)
            if args.once:
                return 1
            time.sleep(20)


if __name__ == '__main__':
    raise SystemExit(main())
