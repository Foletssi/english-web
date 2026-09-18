"""Durable commit recovery. Never regenerate teaching when a saved output is invalid."""
import copy
import hashlib
import json
from pathlib import Path

from checkpoint import atomic_json, file_sha256
from teaching_voice import collect_voice_items


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(',', ':'), allow_nan=False).encode('utf-8')).hexdigest()


def identity(job, source, cover):
    return {'jobId': job['id'], 'videoId': str(job['video_id']), 'sourceKey': job['source_key'],
            'inputHash': digest(job.get('input') or {}), 'sourceHash': file_sha256(source),
            'coverHash': file_sha256(cover) if cover else None}


def save_final_output(root, job, source, cover, output, result, manifest):
    root, output = Path(root).resolve(), Path(output).resolve()
    relative = output.relative_to(root).as_posix()
    if relative == '.':
        raise ValueError('FINAL_OUTPUT_PATH_INVALID')
    # Only the public result contract is persisted; never configuration or lease credentials.
    clean = {key: copy.deepcopy(result[key]) for key in ('video', 'sentences', 'evidence') if key in result}
    value = {'version': 1, 'identity': identity(job, source, cover), 'output': relative,
             'result': clean, 'manifest': manifest}
    atomic_json(root / 'final-output.json', {**value, 'checksum': digest(value)})


def rebind_voice(result, video_id, revision):
    voice = result['video'].get('voiceManifest') or {}
    if voice.get('status') != 'complete' or voice.get('videoId') != video_id or not revision:
        raise ValueError('FINAL_OUTPUT_VOICE_STALE')
    old = collect_voice_items(video_id, voice.get('contentRevision', ''), result['sentences'])
    items = voice.get('items', [])
    by_id = {item['itemId']: item for item in items}
    if len(by_id) != len(items) or set(by_id) != {item['itemId'] for item in old}:
        raise ValueError('FINAL_OUTPUT_VOICE_STALE')
    updated = collect_voice_items(video_id, revision, result['sentences'])
    rebound = []
    for expected, current in zip(old, updated):
        saved = by_id[expected['itemId']]
        # Generated manifests omit duplicated teaching text; the checkpoint checksum
        # protects the rows. Older expanded records must still match when present.
        required = {key: val for key, val in expected.items()
                    if key not in {'meaning', 'context'} or key in saved}
        if saved.get('status') != 'ready' or any(saved.get(key) != val for key, val in required.items()):
            raise ValueError('FINAL_OUTPUT_VOICE_STALE')
        item = {**saved, **{key: val for key, val in current.items()
                           if key not in {'meaning', 'context'} or key in saved}}
        for key in ('ownerJobId', 'runId', 'url'):
            item.pop(key, None)
        rebound.append(item)
    voice.update(contentRevision=revision, items=rebound)
    for key in ('ownerJobId', 'runId'):
        voice.pop(key, None)


def restore_final_output(root, job, source, cover, revision, select_assets):
    root = Path(root).resolve()
    checkpoint = root / 'final-output.json'
    if not checkpoint.exists():
        return None
    try:
        value = json.loads(checkpoint.read_text(encoding='utf-8'))
        checksum = value.pop('checksum')
        if value['version'] != 1 or digest(value) != checksum:
            raise ValueError('checksum')
        output = (root / value['output']).resolve()
        if not output.is_relative_to(root) or output == root:
            raise ValueError('path')
    except (ValueError, KeyError, TypeError, OSError) as error:
        raise ValueError('FINAL_OUTPUT_CHECKPOINT_INVALID') from error
    if value['identity'] != identity(job, source, cover):
        raise ValueError('FINAL_OUTPUT_IDENTITY_MISMATCH')
    result = value['result']
    assets = select_assets(output, result)
    actual = sorted((p.relative_to(output).as_posix(), p.stat().st_size, file_sha256(p)) for p in assets)
    expected = sorted((r['path'], r['size'], r['sha256']) for r in value['manifest'])
    if actual != expected:
        raise ValueError('FINAL_OUTPUT_ASSETS_MISMATCH')
    rebind_voice(result, str(job['video_id']), revision)
    result['video']['status'] = 'REVIEW'
    result.setdefault('evidence', {})['humanReviewRequired'] = True
    return output, result
