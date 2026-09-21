"""Local, context-bound pronunciation assets. No network requests or uploads.

The caller supplies approved teaching rows and publishes the manifest only when
status is complete. Files are shared by synthesis fingerprint; access rights
remain attached to each video/item registration, never to a public text API.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import time

from contracts import StudioError
from media_tools import run
from voice_cache import copy_audio, restore_audio, store_audio, prune_cache

LEGACY_VOICE_VERSION = 'kokoro-context-v1-20260916'
VOICE_VERSION = 'kokoro-input-v2-20260917'
PACKAGE_VERSION = '0.6.1'
AMBIGUOUS_WORDS = frozenset(('read', 'live', 'wind', 'lead', 'tear', 'bow',
                           'close', 'does', 'bass', 'minute', 'wound', 'record',
                           'present', 'object', 'subject', 'invalid', 'refuse',
                           'content', 'produce', 'permit', 'desert'))


def _hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(',', ':')).encode('utf-8')).hexdigest()


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _text(value, maximum=500):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum


def collect_voice_items(video_id, content_revision, rows):
    """Caller must have validated/approved rows; stale token maps are rejected."""
    if not _text(str(video_id), 128) or not _text(str(content_revision), 128):
        raise StudioError('VOICE_IDENTITY_INVALID', '发音内容版本缺失。')
    result, identities = [], set()
    for row in rows:
        lookup = row.get('wordLookup') or {}
        revision = max(1, int(row.get('textRevision') or 1))
        if (lookup.get('sourceTextRevision') != revision or
                lookup.get('sourceEnglish') != row.get('english')):
            raise StudioError('VOICE_SOURCE_STALE', '单词释义版本与原句不一致。')
        tokens = lookup.get('tokens', [])
        for kind, source in [('token', tokens), ('expression', row.get('expressions', []))]:
            for index, entry in enumerate(source):
                if kind == 'expression' and str(entry.get('reviewStatus', '')).upper() in {'REJECTED', 'DELETED'}:
                    continue
                text = entry.get('surface', '')
                meaning = entry.get('coreMeaningZh', '')
                if not _text(text, 160) or not _text(meaning, 500):
                    raise StudioError('VOICE_MEANING_MISSING', '发音项缺少原文或语境释义。')
                local_id = entry.get('tokenId') if kind == 'token' else entry.get('expressionId') or f'e{index}'
                if not _text(local_id, 128) or not _text(str(row.get('id', '')), 128):
                    raise StudioError('VOICE_ITEM_ID_INVALID', '发音项编号缺失。')
                identity = {'videoId': str(video_id), 'contentRevision': str(content_revision),
                    'sentenceId': str(row['id']), 'sourceTextRevision': revision,
                    'kind': kind, 'tokenId' if kind == 'token' else 'expressionId': local_id}
                item_id = _hash(identity)
                if item_id in identities:
                    raise StudioError('VOICE_DUPLICATE_ID', '发音项编号重复。')
                identities.add(item_id)
                # A one-word expression inherits the context decision for its token.
                hint = str(entry.get('pronunciationHint') or '').strip()
                if not hint and kind == 'expression':
                    matches = [t for t in tokens if t.get('surface', '').casefold() == text.casefold()]
                    if len(matches) == 1:
                        hint = str(matches[0].get('pronunciationHint') or '').strip()
                result.append({**identity, 'itemId': item_id, 'text': text,
                    'meaning': meaning, 'context': row['english'], 'pronunciationHint': hint})
    return result


def pronunciation_input(item):
    """Use explicit contextual IPA; never silently guess an ambiguous word."""
    hint = item['pronunciationHint']
    explicit = re.findall(r'/([^/\r\n]{1,160})/', hint)
    if explicit:
        if len(explicit) != 1:
            raise StudioError('VOICE_PRONUNCIATION_AMBIGUOUS', '发音提示包含多个读音。', True)
        phonemes = explicit[0].strip().replace('r', 'ɹ')
        phonemes = phonemes.replace('ɝ', 'ɜɹ').replace('ɚ', 'əɹ').replace('g', 'ɡ')
        # American dictionaries write an intervocalic flap as t plus the IPA
        # voicing diacritic. Kokoro supports the equivalent alveolar tap /ɾ/,
        # but silently drops the combining mark; normalize it explicitly so a
        # valid teaching hint cannot fail the whole voice batch.
        phonemes = phonemes.replace('t̬', 'ɾ')
        # Conventional dictionary /e/ maps to the model's DRESS vowel /ɛ/.
        if item['text'].casefold() == 'read' and phonemes in {'ɹed', 'ɹˈed'}:
            phonemes = phonemes.replace('e', 'ɛ')
        return phonemes, True
    words = set(re.findall(r'[a-z]+', item['text'].lower()))
    if words & AMBIGUOUS_WORDS:
        raise StudioError('VOICE_CONTEXT_REQUIRED', '多音词需要经语境确认的单一 IPA 读音。', True)
    return item['text'], False


def validate_audio(path):
    path = Path(path)
    if not path.is_file() or path.stat().st_size < 500:
        raise StudioError('VOICE_AUDIO_EMPTY', '发音音频为空。', True)
    data = json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams',
                          '-of', 'json', str(path)], 30))
    streams = data.get('streams', [])
    duration = float(data.get('format', {}).get('duration', 0))
    if (len(streams) != 1 or streams[0].get('codec_name') != 'mp3' or
            streams[0].get('channels') != 1 or not math.isfinite(duration) or
            not .08 <= duration <= 30 or int(streams[0].get('bit_rate', 0)) != 48000):
        raise StudioError('VOICE_AUDIO_INVALID', '发音音频格式或时长异常。', True)
    run(['ffmpeg', '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'], 30)
    return {'duration': round(duration, 4), 'bytes': path.stat().st_size,
            'contentHash': file_hash(path), 'contentType': 'audio/mpeg'}


def _synthesize(engine, item, path, voice, language):
    import numpy as np
    import soundfile as sf
    text, is_phonemes = pronunciation_input(item)
    if is_phonemes and engine.tokenizer.known(text) != text:
        raise StudioError('VOICE_PHONEMES_UNSUPPORTED', '发音提示包含模型不支持的音标。', True)
    samples, sample_rate = engine.create(text, voice=voice, speed=1.0,
        lang=language, is_phonemes=is_phonemes)
    samples = np.asarray(samples)
    if (samples.ndim != 1 or not len(samples) or not np.isfinite(samples).all() or
            np.max(np.abs(samples)) < .0001 or sample_rate <= 0):
        raise StudioError('VOICE_SYNTHESIS_EMPTY', '语音模型没有生成有效声音。', True)
    with tempfile.TemporaryDirectory(prefix='eastudy-voice-') as temporary:
        wav = Path(temporary) / 'source.wav'
        sf.write(wav, samples, sample_rate, subtype='PCM_16')
        staging = Path(temporary) / 'encoded.mp3'
        run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav), '-ac', '1', '-ar', '24000',
             '-codec:a', 'libmp3lame', '-b:a', '48k', '-map_metadata', '-1', str(staging)], 60)
        metadata = validate_audio(staging)
        # Copy to a sibling before replace: temp and output may be on different drives.
        with tempfile.NamedTemporaryFile(dir=path.parent, suffix='.part', delete=False) as target:
            temporary_path = Path(target.name)
            target.write(staging.read_bytes())
        try:
            os.replace(temporary_path, path)
        finally:
            temporary_path.unlink(missing_ok=True)
    return metadata


def _espeak_config():
    import espeakng_loader
    from kokoro_onnx.config import EspeakConfig
    data = Path(espeakng_loader.get_data_path())
    # The Windows native library cannot resolve its data in a Unicode checkout.
    # Preserve the installed package and copy only its immutable data to an ASCII
    # per-user cache. This is runtime data, not a global installation change.
    if os.name == 'nt' and not str(data).isascii():
        import shutil
        cache = Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir())) / 'Eastudy' / 'voice-runtime' / 'espeakng-0.2.4'
        if not str(cache).isascii():
            raise StudioError('VOICE_DATA_PATH', '语音运行目录需要使用英文路径。')
        target = cache / 'espeak-ng-data'
        if not (target / 'phontab').is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(data, target, dirs_exist_ok=True)
        data = target
    return EspeakConfig(data_path=str(data), lib_path=espeakng_loader.get_library_path())


def _load_engine(model, voices, prefer_cuda=False):
    from importlib.metadata import version as installed_version
    from kokoro_onnx import Kokoro
    import onnxruntime as ort
    if installed_version('kokoro-onnx') != PACKAGE_VERSION:
        raise StudioError('VOICE_RUNTIME_VERSION', '语音运行库版本不匹配。')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    from voice_provider import FallbackEngine, preload_cuda
    def build(cuda):
        if cuda:
            preload_cuda(ort)
        providers = [('CUDAExecutionProvider', {'gpu_mem_limit': 2 * 1024 ** 3,
            'arena_extend_strategy': 'kSameAsRequested', 'cudnn_conv_algo_search': 'HEURISTIC'}),
            'CPUExecutionProvider'] if cuda else ['CPUExecutionProvider']
        session = ort.InferenceSession(str(model), sess_options=options, providers=providers)
        return Kokoro.from_session(session, str(voices), espeak_config=_espeak_config()), session.get_providers()[0]
    return FallbackEngine(build, prefer_cuda)


def generate_voice_manifest(video_id, content_revision, rows, output_dir, config=None,
                            previous_manifest=None, progress=None, engine=None,
                            progress_details=None):
    """Generate approved rows with <=2 retries/unique input; caller persists manifest.

    config: modelPath, voicesPath, voice (af_heart), language (en-us), cacheDirectory.
    Reuse is keyed by resolved pronunciation and model configuration, while each
    record retains its own video/revision/item identity. previous_manifest is only
    failure evidence; it cannot turn a failed current item into a ready record.
    """
    config, progress = config or {}, progress or (lambda *_: None)
    items = collect_voice_items(video_id, content_revision, rows)
    root = Path(output_dir).resolve()
    voice_dir = root / 'voice'
    voice_dir.mkdir(parents=True, exist_ok=True)
    model = Path(config.get('modelPath') or os.environ.get('ZOSPEAK_TTS_MODEL_PATH', ''))
    voices = Path(config.get('voicesPath') or os.environ.get('ZOSPEAK_TTS_VOICES_PATH', ''))
    voice, language = config.get('voice', 'af_heart'), config.get('language', 'en-us')
    if not model.is_file() or not voices.is_file():
        raise StudioError('VOICE_MODEL_MISSING', '本地语音模型或音色文件尚未配置。')
    version = {'revision': VOICE_VERSION, 'packageVersion': PACKAGE_VERSION,
               'modelHash': file_hash(model), 'voicesHash': file_hash(voices),
               'voice': voice, 'language': language}
    # Resolve contextual pronunciation BEFORE deduplication. Distinct meanings can
    # share audio, but distinct pronunciations (read/read) must never be merged.
    prepared, legacy_paths = [], {}
    for item in items:
        try:
            text, phonemes = pronunciation_input(item)
            fingerprint = _hash({'input': text, 'isPhonemes': phonemes,
                'speed': 1.0, 'format': 'mp3-mono-24000-48k', **version})
            legacy = _hash({'text': item['text'], 'hint': item['pronunciationHint'],
                'meaning': item['meaning'], 'context': item['context'],
                **{**version, 'revision': LEGACY_VOICE_VERSION}})
            source = voice_dir / f'{legacy}.mp3'
            if source.is_file():
                legacy_paths.setdefault(fingerprint, []).append(source)
            prepared.append((fingerprint, None))
        except StudioError as error:
            prepared.append((None, error))
    unique_total = len({key for key, error in prepared if error is None})
    cache_root = config.get('cacheDirectory')
    previous = {x.get('itemId'): x for x in (previous_manifest or {}).get('items', [])}
    cached, failed_inputs, output = {}, {}, []
    # A failed engine initialization is batch-wide. Do not repeatedly load the
    # ONNX session for every distinct pronunciation when the runtime is broken.
    engine_load_error = None
    generated = reused_items = failed = cache_write_failures = 0
    started = time.monotonic()
    def emit(current, status):
        progress(current, len(items), status)
        if progress_details:
            progress_details({'event': 'progress', 'current': current, 'total': len(items),
                'status': status, 'uniqueTotal': unique_total, 'uniqueReady': len(cached),
                'generated': generated, 'reused': reused_items, 'failed': failed,
                'elapsedSeconds': round(time.monotonic() - started, 3),
                'cacheWriteFailures': cache_write_failures,
                'inferenceProvider': getattr(engine, 'provider', 'cache-only'),
                'cpuFallback': bool(getattr(engine, 'fallback', False))})
    emit(0, 'running')
    for index, item in enumerate(items):
        fingerprint, input_error = prepared[index]
        fingerprint = fingerprint or _hash({'invalidItem': item['itemId'], **version})
        relative = f'voice/{fingerprint}.mp3'
        destination = root / relative
        record = {k: v for k, v in item.items() if k not in {'meaning', 'context'}}
        record.update(fingerprint=fingerprint, **version)
        old = previous.get(item['itemId'], {})
        error = input_error or failed_inputs.get(fingerprint)
        attempts = 0
        for attempt in range(0 if error else 3):
            attempts = attempt + 1
            try:
                # This check precedes cache lookup: stale/ambiguous decisions cannot
                # become accepted just because a matching file happened to exist.
                pronunciation_input(item)
                metadata = cached.get(fingerprint)
                if metadata is None and destination.is_file():
                    try:
                        metadata = validate_audio(destination)
                    except StudioError:
                        metadata = None
                if metadata is None:
                    metadata = restore_audio(cache_root, fingerprint, destination)
                if metadata is None:
                    for source in legacy_paths.pop(fingerprint, []):
                        try:
                            legacy_metadata = validate_audio(source)
                            copy_audio(source, destination)
                            metadata = legacy_metadata
                            break
                        except (StudioError, OSError):
                            continue
                reused = metadata is not None
                if metadata is None:
                    if engine is None:
                        if engine_load_error is not None:
                            raise engine_load_error
                        try:
                            engine = _load_engine(model, voices, prefer_cuda=config.get('provider') == 'cuda')
                        except Exception as caught:
                            engine_load_error = caught
                            raise
                    metadata = _synthesize(engine, item, destination, voice, language)
                    generated += 1
                if fingerprint not in cached:
                    try:
                        store_audio(cache_root, fingerprint, destination, metadata)
                    except OSError:
                        # Cache availability must not invalidate an already
                        # validated job asset (e.g. a read-only cache volume).
                        cache_write_failures += 1
                cached[fingerprint] = metadata
                reused_items += int(reused)
                record.update(metadata, status='ready', storagePath=relative,
                              attempts=attempt + 1, reused=reused)
                error = None
                break
            except Exception as caught:
                error = caught
                if isinstance(caught, StudioError) and (
                        not caught.retryable or caught.code in {
                            'VOICE_CONTEXT_REQUIRED', 'VOICE_PRONUNCIATION_AMBIGUOUS',
                            'VOICE_PHONEMES_UNSUPPORTED'}):
                    break
        if error is not None:
            failed += 1
            failed_inputs[fingerprint] = error
            record.update(status='failed', attempts=attempts,
                          errorCode=getattr(error, 'code', 'VOICE_GENERATION_FAILED'))
            # Never retain a record for a different meaning/version as a success.
            if old.get('fingerprint') == fingerprint and old.get('status') == 'ready':
                record['previousValidRecord'] = old
        output.append(record)
        emit(index + 1, record['status'])
    ready = sum(x['status'] == 'ready' for x in output)
    prune_cache(cache_root)
    return {'schemaVersion': 1, 'videoId': str(video_id),
        'contentRevision': str(content_revision), **version, 'items': output,
        'status': 'complete' if ready == len(output) and output else 'incomplete',
        'ready': ready, 'total': len(output), 'uniqueFiles': len(cached),
        'uniqueTotal': unique_total, 'generated': generated, 'reused': reused_items,
        'failed': failed, 'cacheWriteFailures': cache_write_failures,
        'elapsedSeconds': round(time.monotonic() - started, 3),
        'inferenceProvider': getattr(engine, 'provider', 'cache-only'),
        'cpuFallback': bool(getattr(engine, 'fallback', False))}


def main(argv=None):
    """Isolated runtime entry: one JSON request, one sanitized JSON response.

    Request has videoId, contentRevision, rows, config and optional previousManifest.
    A complete manifest is atomically persisted even when some items fail, so the
    worker can expose exact progress without treating a failed batch as published.
    """
    import argparse
    import contextlib
    import sys
    parser = argparse.ArgumentParser(description='Generate context-bound teaching audio locally.')
    parser.add_argument('--request', default='-', help='JSON file or - for standard input')
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--manifest', required=True)
    args = parser.parse_args(argv)
    try:
        request = json.load(sys.stdin) if args.request == '-' else json.loads(
            Path(args.request).read_text(encoding='utf-8-sig'))
        if not isinstance(request, dict) or not isinstance(request.get('rows'), list):
            raise StudioError('VOICE_REQUEST_INVALID', '发音请求格式不正确。')
        def progress(event):
            print(json.dumps(event), file=sys.stderr, flush=True)
        with contextlib.redirect_stdout(sys.stderr):
            manifest = generate_voice_manifest(request.get('videoId', ''),
                request.get('contentRevision', ''), request['rows'], args.output_dir,
                request.get('config'), request.get('previousManifest'), progress_details=progress)
        destination = Path(args.manifest).resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(dir=destination.parent, mode='w',
                    encoding='utf-8', suffix='.part', delete=False) as stream:
                temporary_path = Path(stream.name)
                json.dump(manifest, stream, ensure_ascii=False)
            os.replace(temporary_path, destination)
        finally:
            if temporary_path:
                temporary_path.unlink(missing_ok=True)
        print(json.dumps({k: manifest[k] for k in
                          ('status', 'ready', 'total', 'uniqueFiles', 'elapsedSeconds')}), flush=True)
        return 0 if manifest['status'] == 'complete' else 2
    except Exception as error:
        print(json.dumps({'status': 'failed', 'errorCode': getattr(error, 'code',
                         'VOICE_RUNTIME_FAILED')}), flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
