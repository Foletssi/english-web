"""Operator-run media-only replacement. No AI calls, R2 deletes or embedded secrets."""
import argparse
import json
import os
import shutil
import threading
import time
import urllib.request
from pathlib import Path

from worker import (ApiError, EdgeClient, DEFAULT_ENDPOINT, download, heartbeat_loop,
                    report_failure, report_progress, selected_assets, upload_assets, worker_root)
from media_tools import probe, run, transcode

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


def prepare(original_job, output, progress=None):
    source = worker_root() / original_job / 'source.mp4'
    if not source.is_file():
        raise RuntimeError('Verified local source is missing; use the cloud worker source cache')
    info = probe(source)
    variants = transcode(source, output, info, progress=progress)
    # Keep the exact existing cover, rather than select a new frame.
    cover = source.parent / 'output' / original_job / 'cover.webp'
    if not cover.is_file():
        raise RuntimeError('Existing cover cache is missing')
    output.mkdir(parents=True, exist_ok=True)
    shutil.copy2(cover, output / 'cover.webp')
    run(['ffmpeg', '-v', 'error', '-nostdin', '-i', str(output / '720p' / 'index.m3u8'), '-f', 'null', '-'], 7200)
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
                        {'ffmpeg': True, 'mediaProfile': 'balanced-720-v3'})
    stop, cancelled = threading.Event(), threading.Event()
    thread = threading.Thread(target=heartbeat_loop, args=(client, lease, stop, cancelled), daemon=True)
    thread.start()
    try:
        # HEAD/ETag+length revalidates the cached original against cloud storage.
        source = worker_root() / original_job / 'source.mp4'
        download(lease['downloadUrl'], source)
        last_report = [0.0]
        def progress(_index, _count, label, current, total):
            if cancelled.is_set():
                raise ApiError('JOB_LEASE_LOST_OR_CANCELLED')
            if time.monotonic() - last_report[0] < 5 and current < total:
                return
            last_report[0] = time.monotonic()
            report_progress(client, lease, 'TRANSCODE', min(95, 10 + int(85 * current / max(total, 1))),
                            '正在生成均衡720P，保留现有学习内容',
                            {'current': current, 'total': total, 'unit': 'media_seconds', 'substage': label})
        summary = prepare(original_job, output, progress)
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
