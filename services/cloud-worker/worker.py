import argparse
import json
import os
import platform
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LOCAL_STUDIO = ROOT / 'services' / 'local-studio'
sys.path.insert(0, str(LOCAL_STUDIO))

from pipeline import process_job  # noqa: E402
from ai_tools import prepare_asr_model  # noqa: E402


VERSION = '1.0.0'
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
            self.client.call('worker-progress', jobId=job_id, token=self.lease['token'],
                             stage=STAGE_MAP.get(step, 'PROBE'), progress=min(99, int(changes.get('progress') or 0)),
                             message=str(changes.get('message') or ''))
        return dict(self.job)


def content_type(path):
    if path.endswith('.m3u8'):
        return 'application/vnd.apple.mpegurl'
    if path.endswith('.ts'):
        return 'video/mp2t'
    if path.endswith('.webp'):
        return 'image/webp'
    return 'application/octet-stream'


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


def download(url, target):
    request = urllib.request.Request(url, headers={'User-Agent': f'EastudyCloudWorker/{VERSION}'})
    with urllib.request.urlopen(request, timeout=300) as response, Path(target).open('wb') as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    if not Path(target).is_file() or Path(target).stat().st_size == 0:
        raise ApiError('SOURCE_DOWNLOAD_EMPTY')


def rewrite_result(result, job_id):
    base = f'/api/processing/media/{job_id}'
    video = result['video']
    video['cover'] = f'{base}/cover.webp'
    video['mediaUrl'] = f'{base}/master.m3u8'
    video['playback'] = {'masterUrl': video['mediaUrl'], 'variants': [
        {**row, 'url': f"{base}/{row['path']}"} for row in video.get('playback', {}).get('variants', [])
    ]}
    result.setdefault('evidence', {})['storage'] = 'cloudflare-r2'
    result['evidence']['workerVersion'] = VERSION
    return result


def heartbeat_loop(client, lease, stop):
    while not stop.wait(60):
        try:
            client.call('worker-job-heartbeat', jobId=lease['job']['id'], token=lease['token'])
        except Exception as error:
            print(f'[heartbeat] {error}', flush=True)


def process_lease(client, lease):
    job_id = lease['job']['id']
    stop = threading.Event()
    thread = threading.Thread(target=heartbeat_loop, args=(client, lease, stop), daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix=f'eastudy-{job_id[:8]}-') as folder:
            work = Path(folder)
            source = work / Path(lease['job']['source_key']).name
            client.call('worker-progress', jobId=job_id, token=lease['token'], stage='LOCAL_DOWNLOAD',
                        progress=2, message='正在从 R2 下载原片')
            download(lease['downloadUrl'], source)
            store = RemoteProgressStore(client, lease)
            result_job = process_job(store, job_id, source, None, {}, work / 'output', base_url='')
            if result_job.get('status') != 'REVIEW':
                error = result_job.get('error') or {'code': 'PIPELINE_FAILED', 'message': result_job.get('message', '处理失败')}
                client.call('worker-fail', jobId=job_id, token=lease['token'], error=error,
                            retryable=bool(error.get('retryable', True)))
                return
            client.call('worker-progress', jobId=job_id, token=lease['token'], stage='LOCAL_UPLOAD',
                        progress=96, message='正在把 HLS 与封面上传回 R2')
            output = work / 'output' / job_id
            assets = [path for path in output.rglob('*') if path.is_file() and path.suffix.lower() in {'.m3u8', '.ts', '.webp'}]
            if not assets or not (output / 'master.m3u8').is_file():
                raise ApiError('OUTPUT_ASSETS_EMPTY')
            for index, path in enumerate(sorted(assets)):
                relative = path.relative_to(output).as_posix()
                client.upload(lease['outputUrl'], lease['token'], job_id, relative, path)
                progress = 96 + int(3 * (index + 1) / len(assets))
                client.call('worker-progress', jobId=job_id, token=lease['token'], stage='LOCAL_UPLOAD',
                            progress=min(99, progress), message=f'正在上传成品 {index + 1}/{len(assets)}')
            final = rewrite_result(result_job['result'], job_id)
            client.call('worker-complete', jobId=job_id, token=lease['token'], result=final)
            print(f'[complete] {job_id}', flush=True)
    except Exception as error:
        print(f'[error] {job_id}: {error}', flush=True)
        try:
            client.call('worker-fail', jobId=job_id, token=lease['token'],
                        error={'code': type(error).__name__[:80], 'message': str(error)[:500]}, retryable=True)
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
