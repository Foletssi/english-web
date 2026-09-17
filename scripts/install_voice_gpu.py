"""Install the optional isolated GPU runtime and download the official FP32 model.

Does not enable GPU automatically: the worker chooses it only after a real probe.
No change is made to the existing CPU environment.
"""
from concurrent.futures import ThreadPoolExecutor
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
MODEL_BYTES = 325532387
MODEL_SHA256 = '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5'
MODEL_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx'


def model_valid(path):
    if not path.is_file() or path.stat().st_size != MODEL_BYTES:
        return False
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest() == MODEL_SHA256


def verify(python, target):
    """No paid API: uncached CUDA and same-model CPU MP3, then cross-video reuse."""
    sys.path.insert(0, str(ROOT / 'services/local-studio'))
    from checkpoint import atomic_json
    from teaching_voice import validate_audio
    from voice_runtime import _generate_worker_voice
    rows = [{'id': 'gpu-probe', 'english': 'ready', 'textRevision': 1, 'expressions': [],
        'wordLookup': {'sourceEnglish': 'ready', 'sourceTextRevision': 1,
            'tokens': [{'tokenId': 't0', 'surface': 'ready', 'coreMeaningZh': '准备好',
                        'pronunciationHint': '/ɹɛdi/'}]}}]
    report = {}
    with tempfile.TemporaryDirectory(prefix='eastudy-gpu-probe-', dir=ROOT / 'tmp') as folder:
        root = Path(folder)
        for provider in ('cuda', 'cpu'):
            config = {'modelPath': str(target), 'voicesPath': str(target.with_name('voices-v1.0.bin')),
                'voice': 'af_heart', 'language': 'en-us', 'provider': provider,
                'cacheDirectory': str(root / (provider + '-cache'))}
            started = time.monotonic()
            manifest = _generate_worker_voice('gpu-probe', '1', rows, root / provider,
                None, None, 120, 90, python, config)
            for item in manifest['items']:
                validate_audio(root / provider / item['storagePath'])
            actual = manifest.get('inferenceProvider')
            if provider == 'cuda' and (actual != 'CUDAExecutionProvider' or manifest.get('cpuFallback')):
                raise RuntimeError('Uncached MP3 probe did not use CUDA; GPU remains disabled')
            report[provider] = {'provider': actual, 'seconds': round(time.monotonic() - started, 3),
                                'ready': manifest['ready'], 'total': manifest['total']}
        config['provider'] = 'cuda'
        config['cacheDirectory'] = str(root / 'cuda-cache')
        started = time.monotonic()
        cached = _generate_worker_voice('other-video', '2', rows, root / 'warm', None, None, 120, 90, python, config)
        report['warm'] = {'seconds': round(time.monotonic() - started, 3),
                           'provider': cached.get('inferenceProvider'), 'ready': cached['ready']}
    marker = python.parent.parent / 'verified-gpu.json'
    atomic_json(marker, {'provider': 'CUDAExecutionProvider', 'modelHash': MODEL_SHA256,
                          'probe': report, 'verifiedAt': time.time()})
    print(json.dumps(report, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    runtime = ROOT / 'tmp' / 'voice-gpu-venv'
    python = runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.is_file() and not args.verify_only:
        subprocess.run([sys.executable, '-m', 'venv', str(runtime)], check=True)
    if not args.verify_only:
        subprocess.run([str(python), '-m', 'pip', 'install', '--no-deps', '-r',
            str(ROOT / 'services/local-studio/requirements-voice-gpu.txt')], check=True)
    target = Path.home() / '.cache/eastudy-kokoro-v1.0/kokoro-v1.0.onnx'
    target.parent.mkdir(parents=True, exist_ok=True)
    if model_valid(target):
        verify(python, target)
        return
    if args.verify_only:
        raise RuntimeError('Official FP32 model missing or hash mismatch')
    chunks = target.parent / (target.name + '.chunks')
    chunks.mkdir(exist_ok=True)
    step = 2 * 1024 * 1024

    def fetch(start):
        end = min(MODEL_BYTES, start + step) - 1
        path = chunks / str(start)
        if path.is_file() and path.stat().st_size == end - start + 1:
            return path
        for _ in range(3):
            result = subprocess.run(['curl.exe' if os.name == 'nt' else 'curl', '-L', '--fail',
                '--connect-timeout', '10', '--max-time', '45', '--silent', '--show-error',
                '-r', f'{start}-{end}', MODEL_URL, '-o', str(path)], capture_output=True)
            if result.returncode == 0 and path.stat().st_size == end - start + 1:
                return path
        raise RuntimeError(f'Model range download failed: {start}')

    with ThreadPoolExecutor(max_workers=8) as pool:
        parts = list(pool.map(fetch, range(0, MODEL_BYTES, step)))
    staging = target.with_suffix('.complete')
    digest = hashlib.sha256()
    with staging.open('wb') as output:
        for part in parts:
            block = part.read_bytes()
            digest.update(block)
            output.write(block)
    if staging.stat().st_size != MODEL_BYTES or digest.hexdigest() != MODEL_SHA256:
        raise RuntimeError('Model size/hash mismatch')
    os.replace(staging, target)
    print('Official model installed; SHA256=' + digest.hexdigest())
    verify(python, target)


if __name__ == '__main__':
    main()
