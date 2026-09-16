"""Run pronunciation generation in the isolated, hidden CPU voice runtime."""
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time

from checkpoint import atomic_json
from contracts import StudioError
from teaching_voice import collect_voice_items, file_hash

ROOT = Path(__file__).resolve().parents[2]


def runtime_paths():
    python = Path(os.getenv('EASTUDY_VOICE_PYTHON') or str(ROOT / 'tmp' / 'voice-venv' /
        ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')))
    cache = Path.home() / '.cache' / 'eastudy-kokoro-v1.0'
    config = {'modelPath': os.getenv('ZOSPEAK_TTS_MODEL_PATH') or str(cache / 'kokoro-v1.0.int8.onnx'),
              'voicesPath': os.getenv('ZOSPEAK_TTS_VOICES_PATH') or str(cache / 'voices-v1.0.bin'),
              'voice': 'af_heart', 'language': 'en-us'}
    if not python.is_file() or any(not Path(config[key]).is_file() for key in ('modelPath', 'voicesPath')):
        raise StudioError('VOICE_RUNTIME_MISSING', '本地发音服务尚未安装完整。', True)
    return python, config


def voice_assets(output, manifest):
    root = Path(output).resolve()
    if not isinstance(manifest, dict) or manifest.get('status') != 'complete':
        raise StudioError('VOICE_MANIFEST_INCOMPLETE', '发音生成未完成。', True)
    items = manifest.get('items') or []
    if not items or manifest.get('ready') != len(items) or manifest.get('total') != len(items):
        raise StudioError('VOICE_MANIFEST_INCOMPLETE', '发音数量不完整。', True)
    paths = {}
    for item in items:
        relative = str(item.get('storagePath') or '')
        path = root / relative
        if (item.get('status') != 'ready' or not re.fullmatch(r'voice/[a-f0-9]{64}\.mp3', relative)
                or relative != f"voice/{item.get('fingerprint')}.mp3"
                or not path.resolve().is_relative_to(root) or not path.is_file()
                or not 500 <= path.stat().st_size <= 1048576 or path.stat().st_size != item.get('bytes')):
            raise StudioError('VOICE_ASSET_INVALID', '发音文件缺失或映射不正确。', True)
        if relative not in paths:
            paths[relative] = file_hash(path)
        if paths[relative] != item.get('contentHash'):
            raise StudioError('VOICE_ASSET_HASH_MISMATCH', '发音文件校验失败。', True)
    return [root / relative for relative in sorted(paths)]


def generate_worker_voice(video_id, revision, rows, output, cancelled=None, progress=None,
                          timeout=21600, idle_timeout=180):
    python, config = runtime_paths()
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    request_path, manifest_path = output / 'voice-request.json', output / 'voice-manifest.json'
    previous = None
    if manifest_path.is_file():
        try:
            previous = json.loads(manifest_path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            pass
    expected = collect_voice_items(str(video_id), str(revision), rows)
    atomic_json(request_path, {'videoId': str(video_id), 'contentRevision': str(revision),
        'rows': rows, 'config': config, 'previousManifest': previous})
    if cancelled and cancelled.is_set():
        raise StudioError('JOB_LEASE_LOST_OR_CANCELLED', '任务已取消。')
    events = queue.Queue()
    environment = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'}
    process = subprocess.Popen([str(python), str(Path(__file__).with_name('teaching_voice.py')),
        '--request', str(request_path), '--output-dir', str(output), '--manifest', str(manifest_path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8', errors='replace',
        env=environment, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    def drain(stream):
        try:
            for line in stream:
                try:
                    event = json.loads(line)
                    if isinstance(event, dict) and (event.get('event') == 'progress' or event.get('status') == 'failed'):
                        events.put(event)
                except ValueError:
                    pass
        finally:
            stream.close()
    readers = [threading.Thread(target=drain, args=(stream,), daemon=True)
               for stream in (process.stdout, process.stderr)]
    for reader in readers:
        reader.start()
    started = last_progress = time.monotonic()
    failure_code = None
    try:
        while True:
            if cancelled and cancelled.is_set():
                raise StudioError('JOB_LEASE_LOST_OR_CANCELLED', '任务已取消。')
            now = time.monotonic()
            if now - started > timeout or now - last_progress > idle_timeout:
                raise StudioError('VOICE_GENERATION_TIMEOUT', '发音处理超时，可从已完成部分继续重试。', True)
            try:
                event = events.get(timeout=.2)
                last_progress = time.monotonic()
                if event.get('status') == 'failed':
                    candidate = str(event.get('errorCode') or '')
                    if re.fullmatch(r'VOICE_[A-Z_]{1,70}', candidate):
                        failure_code = candidate
                elif progress:
                    progress(event)
            except queue.Empty:
                if process.poll() is not None:
                    break
        if process.returncode != 0 or not manifest_path.is_file():
            raise StudioError(failure_code or 'VOICE_GENERATION_INCOMPLETE', '发音未全部生成，已保留完成内容供重试。', True)
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if (manifest.get('videoId') != str(video_id) or manifest.get('contentRevision') != str(revision)
                or len(manifest.get('items', [])) != len(expected)
                or {item.get('itemId') for item in manifest.get('items', [])} != {item['itemId'] for item in expected}):
            raise StudioError('VOICE_SOURCE_STALE', '发音版本与教学内容不一致。', True)
        voice_assets(output, manifest)
        return manifest
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for reader in readers:
            reader.join(timeout=1)


def voice_capability(output):
    row = {'id': 'probe', 'english': 'ready', 'textRevision': 1, 'expressions': [],
        'wordLookup': {'sourceEnglish': 'ready', 'sourceTextRevision': 1,
            'tokens': [{'tokenId': 't0', 'surface': 'ready', 'coreMeaningZh': '准备好了',
                        'pronunciationHint': '/ɹɛdi/'}]}}
    try:
        manifest = generate_worker_voice('runtime-probe', '1', [row], output, timeout=120)
        return {'inferenceReady': True, 'engine': 'kokoro-onnx', 'version': manifest.get('revision')}
    except Exception as error:
        return {'inferenceReady': False, 'errorCode': getattr(error, 'code', 'VOICE_RUNTIME_FAILED')}
