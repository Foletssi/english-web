from pathlib import Path

from ai_tools import asr_profile, enrich, transcribe
from checkpoint import canonical_hash, file_sha256, read_valid_json, save_json_checkpoint
from contracts import StudioError, validate_transcript
from media_tools import extract_audio, make_cover, probe, transcode


def public_media(base_url, job_id, name):
    return f"{base_url.rstrip('/')}/media/{job_id}/{name}"


def process_job(store, job_id, source_path, cover_path, ai_config, media_root,
                base_url='http://127.0.0.1:8788'):
    job = store.get(job_id)
    output = Path(media_root) / job_id
    output.mkdir(parents=True, exist_ok=True)
    checkpoints = output / '_checkpoints'
    checkpoints.mkdir(exist_ok=True)

    def progress(step, percent, message, **telemetry):
        store.update(job_id, status='PROCESSING', currentStep=step,
                     progress=percent, message=message, error=None,
                     telemetry=telemetry or None)

    def transcode_progress(level_index, level_count, label, current, total):
        ratio = (level_index + min(1, current / max(total, .001))) / max(level_count, 1)
        progress('transcode', min(47, 18 + round(29 * ratio)),
                 f'正在生成 {label}（第 {level_index + 1}/{level_count} 档），已处理 {current:.0f}/{total:.0f} 秒',
                 substage=label, current=current, total=total, unit='media_seconds')

    try:
        source = Path(source_path)
        source_identity = file_sha256(source) if source.is_file() else canonical_hash(str(source))
        probe_key = canonical_hash({'source': source_identity, 'probeSchema': 1})
        info = read_valid_json(checkpoints / 'probe.json', probe_key,
                               lambda value: value if float(value['duration']) > 0 else None)
        if info is None:
            progress('probe', 10, '正在检查视频和音轨')
            info = probe(source_path)
            save_json_checkpoint(checkpoints / 'probe.json', probe_key, info)
        else:
            progress('probe', 10, '已复用素材检查结果')
        progress('transcode', 18, '正在生成节省空间的单档 720P 标准视频')
        variants = transcode(source_path, output, info, progress=transcode_progress)
        cover = make_cover(source_path, output / 'cover.webp', info['duration'], cover_path)
        progress('asr', 48, '正在提取英语音轨')
        audio = extract_audio(source_path, output / 'audio.wav')
        profile = asr_profile()
        transcript_key = canonical_hash({'source': source_identity, 'audio': 'pcm16k-mono-v1',
            'profile': profile, 'beamSize': 5, 'vad': True, 'wordTimestamps': True})
        rows = read_valid_json(checkpoints / 'transcript.json', transcript_key,
                               lambda value: validate_transcript(value, info['duration']))
        if rows is None:
            rows = transcribe(audio, job_id, info['duration'], progress=progress)
            save_json_checkpoint(checkpoints / 'transcript.json', transcript_key, rows)
        else:
            progress('asr', 70, f'已复用 {len(rows)} 句英文字幕')
        word_count = sum(len(str(row['english']).split()) for row in rows)
        learning, metadata, provenance = enrich(rows, {
            'title': job['metadata'].get('title') or Path(job['sourceName']).stem,
            'creator': job['metadata'].get('creator', ''),
            'duration': info['duration'],
            'wordsPerMinute': round(word_count * 60 / info['duration']),
        }, ai_config, progress, cache_dir=checkpoints / 'ai')
        playback_variants = [{**item, 'url': public_media(base_url, job_id, item['path'])}
                             for item in variants]
        playback_url = playback_variants[0]['url']
        title = job['metadata'].get('title') or Path(job['sourceName']).stem
        video = {
            'title': title, 'titleZh': metadata['titleZh'],
            'description': metadata['descriptionZh'], 'creator': job['metadata'].get('creator', ''),
            'level': metadata['level'], 'levelReason': metadata['levelReason'],
            'topicIds': metadata['topicIds'], 'tagIds': metadata['tagIds'],
            'tagAssignments': metadata['tagAssignments'],
            'goalIds': [],
            'goalMappings': metadata['goalMappings'], 'duration': info['duration'],
            'cover': public_media(base_url, job_id, 'cover.webp'),
            'mediaUrl': playback_url,
            'playback': {'policy': 'single-standard-v2',
                         'masterUrl': playback_url,
                         'variants': playback_variants},
            'pipelineStatus': 'READY', 'status': 'REVIEW',
        }
        result = {'video': video, 'sentences': learning, 'evidence': {
            'asrEngine': 'faster-whisper', 'subtitleCount': len(learning),
            'asrProfile': profile,
            'aiRequestCount': len(provenance), 'aiRequests': provenance,
            'mediaVariants': playback_variants, 'humanReviewRequired': True,
        }}
        return store.update(job_id, status='REVIEW', currentStep='review', progress=100,
                            message='真实处理已完成，请人工核对字幕和内容后发布',
                            retryable=False, error=None, result=result)
    except StudioError as error:
        return store.update(job_id, status='ERROR', progress=min(99, store.get(job_id)['progress']),
                            message=error.message, retryable=error.retryable,
                            error={'code': error.code, 'message': error.message,
                                   'retryable': error.retryable})
    except Exception as error:
        return store.update(job_id, status='ERROR', progress=min(99, store.get(job_id)['progress']),
                            message='后台处理发生异常，请查看本地服务窗口', retryable=True,
                            error={'code': 'PIPELINE_INTERNAL', 'message': str(error), 'retryable': True})
