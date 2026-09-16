import json
import mimetypes
import shutil
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from contracts import StudioError
from job_store import JobStore
from pipeline import process_job
from upload_parser import parse_multipart


HOST, PORT = '127.0.0.1', 8788
ALLOWED_ORIGINS = {'http://127.0.0.1:8080', 'http://localhost:8080'}
EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix='eastudy-studio')


def public_job(job):
    return {key: value for key, value in job.items() if key not in {'sourcePath', 'coverPath'}}


class StudioHandler(BaseHTTPRequestHandler):
    server_version = 'EastudyLocalStudio/2.0'

    def log_message(self, fmt, *args):
        print('[Eastudy Studio]', fmt % args)

    def cors(self):
        origin = self.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def json_response(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == '/health':
            self.json_response(200, {'ok': True, 'service': 'eastudy-local-studio',
                                     'activeJobs': sum(x['status'] in {'QUEUED', 'PROCESSING'}
                                                       for x in self.server.store.list())})
            return
        if path == '/jobs':
            self.json_response(200, {'jobs': [public_job(row) for row in self.server.store.list()]})
            return
        if path.startswith('/jobs/'):
            try:
                self.json_response(200, public_job(self.server.store.get(path.split('/')[2])))
            except KeyError:
                self.json_response(404, {'error': {'code': 'JOB_NOT_FOUND', 'message': '任务不存在。'}})
            return
        if path.startswith('/media/'):
            self.serve_media(path[len('/media/'):])
            return
        self.json_response(404, {'error': {'code': 'NOT_FOUND', 'message': '接口不存在。'}})

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path == '/jobs':
                self.create_job()
                return
            if path.startswith('/jobs/') and path.endswith('/retry'):
                self.retry_job(path.split('/')[2])
                return
            self.json_response(404, {'error': {'code': 'NOT_FOUND', 'message': '接口不存在。'}})
        except StudioError as error:
            self.json_response(400, {'error': {'code': error.code, 'message': error.message,
                                                'retryable': error.retryable}})
        except (ValueError, json.JSONDecodeError):
            self.json_response(400, {'error': {'code': 'REQUEST_INVALID', 'message': '请求参数格式不正确。'}})

    def create_job(self):
        length = int(self.headers.get('Content-Length', '0'))
        fields, files = parse_multipart(self.rfile, self.headers.get('Content-Type', ''), length,
                                        self.server.root / 'incoming')
        if 'video' not in files:
            raise StudioError('VIDEO_REQUIRED', '请选择视频文件。')
        metadata = json.loads(fields.get('metadata') or '{}')
        ai_config = json.loads(fields.get('aiConfig') or '{}')
        if not isinstance(metadata, dict) or not isinstance(ai_config, dict):
            raise StudioError('REQUEST_INVALID', '任务信息必须是 JSON 对象。')
        video = files['video']
        metadata['title'] = str(metadata.get('title') or Path(video['filename']).stem).strip()
        metadata['creator'] = str(metadata.get('creator') or '').strip()
        job = self.server.store.create(metadata, video['filename'])
        source_dir = self.server.root / 'sources' / job['id']
        source_dir.mkdir(parents=True, exist_ok=True)
        source = source_dir / ('source' + Path(video['filename']).suffix.lower())
        shutil.move(video['path'], source)
        cover = None
        if 'cover' in files:
            cover = source_dir / ('cover' + Path(files['cover']['filename']).suffix.lower())
            shutil.move(files['cover']['path'], cover)
        job = self.server.store.update(job['id'], sourcePath=str(source),
                                       coverPath=str(cover) if cover else None)
        self.server.configs[job['id']] = ai_config
        self.server.submitter(job['id'])
        self.json_response(202, public_job(job))

    def retry_job(self, job_id):
        try:
            job = self.server.store.queue_retry(job_id)
        except KeyError as error:
            raise StudioError('JOB_NOT_FOUND', '任务不存在。') from error
        if job is None:
            raise StudioError('JOB_NOT_RETRYABLE', '只有失败任务可以重试。')
        try:
            self.server.submitter(job_id)
        except Exception as error:
            self.server.store.update(job_id, status='ERROR',
                                     error={'code': 'QUEUE_UNAVAILABLE', 'message': '处理队列暂时不可用，请稍后继续处理。'})
            raise StudioError('QUEUE_UNAVAILABLE', '处理队列暂时不可用，请稍后继续处理。') from error
        self.json_response(202, public_job(self.server.store.get(job_id)))

    def serve_media(self, relative):
        root = self.server.root / 'media'
        target = (root / relative).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            self.json_response(404, {'error': {'code': 'MEDIA_NOT_FOUND', 'message': '媒体不存在。'}})
            return
        if not target.is_file():
            self.json_response(404, {'error': {'code': 'MEDIA_NOT_FOUND', 'message': '媒体不存在。'}})
            return
        mime = {'.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t',
                '.webp': 'image/webp'}.get(target.suffix.lower()) or mimetypes.guess_type(target)[0] or 'application/octet-stream'
        self.send_response(200)
        self.cors()
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(target.stat().st_size))
        self.send_header('Cache-Control', 'public, max-age=3600')
        self.end_headers()
        with target.open('rb') as source:
            shutil.copyfileobj(source, self.wfile)


def build_server(root, port=PORT, submitter=None):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, port), StudioHandler)
    server.root = root
    server.store = JobStore(root / 'jobs')
    server.configs = {}

    def run(job_id):
        job = server.store.get(job_id)
        return process_job(server.store, job_id, job['sourcePath'], job.get('coverPath'),
                           server.configs.get(job_id, {}), root / 'media')

    server.submitter = submitter or (lambda job_id: EXECUTOR.submit(run, job_id))
    return server


if __name__ == '__main__':
    data_root = Path(__file__).resolve().parents[2] / 'local-data' / 'studio'
    httpd = build_server(data_root)
    print(f'Eastudy 本地智能处理服务已启动：http://{HOST}:{PORT}')
    print('关闭管理网页不会停止已上传任务；请保留此窗口，按 Ctrl+C 停止服务。')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n正在停止 Eastudy 本地智能处理服务…')
    finally:
        httpd.shutdown()
        httpd.server_close()
        EXECUTOR.shutdown(wait=False, cancel_futures=False)
