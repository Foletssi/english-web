"""Operator-run media-only replacement. No AI calls, R2 deletes or embedded secrets."""
import argparse
import json
import os
import shutil
import sqlite3
import threading
import time
import urllib.request
import uuid
from contextlib import closing
from contextlib import ExitStack
from pathlib import Path

from worker import (ApiError, EdgeClient, DEFAULT_ENDPOINT, download, heartbeat_loop,
                    report_failure, report_progress, selected_assets, upload_assets, worker_root)
from media_tools import probe, run, transcode
from local_intake_store import IntakeError, digest_file
from local_storage import source_access

PROJECT_URL = 'https://ehxqtgakjgqgmghhdmjg.supabase.co'
SITE_URL = 'https://english-web-lce.pages.dev'


def rpc(name, values):
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '').strip()
    if not key:
        raise RuntimeError('SUPABASE_SERVICE_ROLE_KEY is required for --apply')
    request = urllib.request.Request(PROJECT_URL + '/rest/v1/rpc/' + name,
        data=json.dumps(values).encode(), method='POST',
        headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def verified_local_source(descriptor):
    """Read the durable store without claiming the running intake server's writer lock."""
    if descriptor.get('protocolVersion') != 1:
        raise IntakeError('SOURCE_DECLARATION_CONFLICT')
    source_id = descriptor.get('sourceId', '')
    try:
        if str(uuid.UUID(source_id)) != source_id:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise IntakeError('SOURCE_ID_INVALID') from None
    root = (worker_root() / 'local-inputs-v1').resolve()
    directory = root / source_id
    source = directory / 'source.bin'
    if directory.is_symlink() or source.is_symlink() or not source.resolve().is_relative_to(root):
        raise IntakeError('SOURCE_PATH_INVALID')
    database = root / 'intakes.sqlite3'
    if not database.is_file() or database.is_symlink():
        raise IntakeError('LOCAL_SOURCE_MISSING')
    with closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=30)) as db:
        row = db.execute('SELECT state,declaration FROM inputs WHERE source_id=?', (source_id,)).fetchone()
    if not row or row[0] != 'READY':
        raise IntakeError('LOCAL_SOURCE_MISSING')
    declaration = json.loads(row[1])
    for key in ('sourceId', 'jobId', 'workerId', 'size', 'sha256', 'protocolVersion'):
        if declaration.get(key) != descriptor.get(key):
            raise IntakeError('SOURCE_DECLARATION_CONFLICT')
    if not source.is_file() or source.stat().st_size != descriptor['size']:
        raise IntakeError('LOCAL_SOURCE_MISSING')
    if digest_file(source) != descriptor['sha256']:
        raise IntakeError('LOCAL_SOURCE_SHA_MISMATCH')
    return source


def resolve_reencode_source(lease, original_job):
    descriptor = lease.get('inputSource')
    if 'inputSource' not in lease:
        # Compatibility with maintenance leases created before local-first intake existed.
        descriptor = {'kind': 'cloud_r2', 'key': lease['job']['source_key']}
    if not isinstance(descriptor, dict):
        raise IntakeError('SOURCE_DECLARATION_CONFLICT')
    if descriptor.get('kind') == 'local_file':
        return verified_local_source(descriptor)
    if descriptor.get('kind') != 'cloud_r2' or descriptor.get('key') != lease['job']['source_key']:
        raise IntakeError('SOURCE_DECLARATION_CONFLICT')
    target = worker_root() / original_job / 'source.mp4'
    download(lease['downloadUrl'], target, source_key=descriptor['key'])
    return target


def prepare(original_job, output, progress=None, cover=None, source=None):
    source = source or worker_root() / original_job / 'source.mp4'
    if not source.is_file():
        raise RuntimeError('Verified local source is missing; use the cloud worker source cache')
    info = probe(source)
    variants = transcode(source, output, info, progress=progress)
    # Keep the exact existing cover, rather than select a new frame.
    cover = cover or source.parent / 'output' / original_job / 'cover.webp'
    if not cover.is_file():
        raise RuntimeError('Existing cover cache is missing')
    output.mkdir(parents=True, exist_ok=True)
    shutil.copy2(cover, output / 'cover.webp')
    playlist = output / '540p' / 'index.m3u8'
    run(['ffmpeg', '-v', 'error', '-xerror', '-nostdin', '-i', str(playlist), '-f', 'null', '-'], 7200)
    encoded = probe(playlist)
    if abs(encoded['duration'] - info['duration']) > 0.15:
        raise RuntimeError('Encoded duration differs from source')
    if (min(encoded['width'], encoded['height']) > 540
            or max(encoded['width'], encoded['height']) > 960
            or not 0 < encoded['fps'] <= 30.001):
        raise RuntimeError('Encoded media does not meet the 540P profile')
    assets = selected_assets(output, {'video': {'playback': {'variants': variants}}})
    result = {'originalJobId': original_job, 'duration': info['duration'], 'variants': variants,
              'bytes': sum(path.stat().st_size for path in assets), 'assetCount': len(assets)}
    (output / 'verified.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result


def apply(original_job, output):
    secret = os.environ.get('EASTUDY_WORKER_SECRET', '').strip()
    if not secret:
        raise RuntimeError('EASTUDY_WORKER_SECRET is required')
    lease = rpc('service_begin_balanced_reencode', {'p_original_job_id': original_job})
    if lease.get('completed'):
        print(json.dumps(lease), flush=True)
        return
    job_id, run_id, token = lease['job']['id'], lease['job']['run_id'], lease['token']
    base = SITE_URL + '/api/processing/'
    lease['downloadUrl'] = base + f'source?job={job_id}&token={token}'
    lease['outputUrl'] = base + f'output?job={job_id}&token={token}&run={run_id}'
    client = EdgeClient(DEFAULT_ENDPOINT, secret, 'eastudy-media-maintenance',
                        {'ffmpeg': True, 'mediaProfile': 'balanced-540-v1'})
    stop, cancelled = threading.Event(), threading.Event()
    thread = threading.Thread(target=heartbeat_loop, args=(client, lease, stop, cancelled), daemon=True)
    thread.start()
    source_locks = ExitStack()
    try:
        if lease.get('inputSource', {}).get('kind') == 'local_file':
            source_locks.enter_context(source_access(worker_root() / 'local-inputs-v1', lease['inputSource']['sourceId']))
        source = resolve_reencode_source(lease, original_job)
        cover = output / 'reencode-cover.webp'
        download(lease['downloadUrl'] + '&asset=cover', cover)
        last_report = [0.0]
        def progress(_index, _count, label, current, total):
            if cancelled.is_set():
                raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
            if time.monotonic() - last_report[0] < 5 and current < total:
                return
            last_report[0] = time.monotonic()
            report_progress(client, lease, 'TRANSCODE', min(95, 10 + int(85 * current / max(total, 1))),
                            '正在生成均衡540P，保留现有学习内容',
                            {'current': current, 'total': total, 'unit': 'media_seconds', 'substage': label})
        summary = prepare(original_job, output, progress, cover=cover, source=source)
        if cancelled.is_set():
            raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
        assets = selected_assets(output, {'video': {'playback': {'variants': summary['variants']}}})
        manifest = upload_assets(client, lease, output, assets, cancelled)
        result = rpc('service_commit_balanced_reencode', {'p_job_id': job_id, 'p_run_id': run_id,
            'p_token': token, 'p_manifest': manifest, 'p_variant': summary['variants'][0]})
        (output / 'committed.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception as error:
        try:
            report_failure(client, lease, {'code': 'MEDIA_REENCODE_FAILED', 'message': type(error).__name__}, False)
        except Exception:
            pass
        raise
    finally:
        source_locks.close()
        stop.set()
        thread.join(timeout=20)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--original-job', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='Upload and atomically switch production media')
    args = parser.parse_args()
    import uuid
    original_job = str(uuid.UUID(args.original_job))
    output = args.output.resolve()
    if output == worker_root() or output.is_relative_to(worker_root()):
        raise RuntimeError('Output must be separate from existing source/checkpoint caches')
    output.mkdir(parents=True, exist_ok=True)
    if args.apply:
        apply(original_job, output)
    else:
        last_report = [0.0]
        def progress(_index, _count, _label, current, total):
            if time.monotonic() - last_report[0] >= 15 or current >= total:
                print(json.dumps({'encodedSeconds': round(current), 'totalSeconds': round(total)}), flush=True)
                last_report[0] = time.monotonic()
        print(json.dumps(prepare(original_job, output, progress)), flush=True)


if __name__ == '__main__':
    main()
