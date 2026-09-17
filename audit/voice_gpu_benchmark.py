"""Explicit local-only throughput check; isolated caches, no task mutation or AI API."""
import json
from pathlib import Path
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/local-studio'))
from teaching_voice import validate_audio
from voice_runtime import _generate_worker_voice


def main():
    readings = [('ready', 'ɹɛdi'), ('word', 'wɜɹd'), ('language', 'læŋɡwɪdʒ'),
                ('understand', 'ʌndɚstænd'), ('coffee', 'kɔfi'), ('beautiful', 'bjutɪfəl'),
                ('opportunity', 'ɑpɚtunɪti'), ('culture', 'kʌltʃɚ'), ('practice', 'pɹæktɪs'),
                ('conversation', 'kɑnvɚseɪʃən'), ('read', 'ɹid'), ('read', 'ɹɛd'),
                ('thought', 'θɔt'), ('through', 'θɹu'), ('world', 'wɜɹld'),
                ('interesting', 'ɪntɚəstɪŋ'), ('knowledge', 'nɑlɪdʒ'), ('comfortable', 'kʌmftɚbəl'),
                ('actually', 'æktʃuəli'), ('experience', 'ɪkspɪɹiəns')]
    rows = [{'id': str(i), 'english': word, 'textRevision': 1, 'expressions': [],
             'wordLookup': {'sourceEnglish': word, 'sourceTextRevision': 1,
                'tokens': [{'tokenId': 't0', 'surface': word, 'coreMeaningZh': '测试',
                            'pronunciationHint': '/' + ipa + '/'}]}}
            for i, (word, ipa) in enumerate(readings)]
    model = Path.home() / '.cache/eastudy-kokoro-v1.0/kokoro-v1.0.onnx'
    python = ROOT / 'tmp/voice-gpu-venv/Scripts/python.exe'
    report = {}
    with tempfile.TemporaryDirectory(prefix='eastudy-voice-throughput-', dir=ROOT / 'tmp') as folder:
        root = Path(folder)
        for provider in ('cuda', 'cpu'):
            config = {'modelPath': str(model), 'voicesPath': str(model.with_name('voices-v1.0.bin')),
                      'voice': 'af_heart', 'language': 'en-us', 'provider': provider,
                      'cacheDirectory': str(root / (provider + '-cache'))}
            started = time.monotonic()
            manifest = _generate_worker_voice('benchmark', '1', rows, root / provider,
                None, None, 300, 90, python, config)
            for item in manifest['items']:
                validate_audio(root / provider / item['storagePath'])
            elapsed = time.monotonic() - started
            report[provider] = {'seconds': round(elapsed, 3), 'ready': manifest['ready'],
                                'provider': manifest.get('inferenceProvider'),
                                'cpuFallback': manifest.get('cpuFallback', False),
                                'itemsPerMinute': round(len(readings) * 60 / elapsed, 2)}
    print(json.dumps(report))


if __name__ == '__main__':
    main()
