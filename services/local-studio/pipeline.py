from pathlib import Path

from ai_tools import enrich, transcribe
from contracts import StudioError
from media_tools import extract_audio, make_cover, probe, transcode


def public_media(base_url, job_id, name):
    return f"{base_url.rstrip('/')}/media/{job_id}/{name}"


def process_job(store, job_id, source_path, cover_path, ai_config, media_root,
                base_url='http://127.0.0.1:8788'):
    job = store.get(job_id)
    output = Path(media_root) / job_id
    output.mkdir(parents=True, exist_ok=True)

    def progress(step, percent, message):
        store.update(job_id, status='PROCESSING', currentStep=step,
                     progress=percent, message=message, error=None)

    try:
        progress('probe', 10, '正在检查视频和音轨')
        info = probe(source_path)
        progress('transcode', 18, '正在生成 480p / 720p / 1080p 自适应清晰度')
        variants = transcode(source_path, output, info)
        cover = make_cover(source_path, output / 'cover.webp', info['duration'], cover_path)
        progress('asr', 48, '正在提取英语音轨')
        audio = extract_audio(source_path, output / 'audio.wav')
        rows = transcribe(audio, job_id, info['duration'], progress=progress)
        word_count = sum(len(str(row['english']).split()) for row in rows)
        learning, metadata, provenance = enrich(rows, {
            'title': job['metadata'].get('title') or Path(job['sourceName']).stem,
            'creator': job['metadata'].get('creator', ''),
            'duration': info['duration'],
            'wordsPerMinute': round(word_count * 60 / info['duration']),
        }, ai_config, progress)
        playback_variants = [{**item, 'url': public_media(base_url, job_id, item['path'])}
                             for item in variants]
        title = job['metadata'].get('title') or Path(job['sourceName']).stem
        video = {
            'title': title, 'titleZh': metadata['titleZh'],
            'description': metadata['descriptionZh'], 'creator': job['metadata'].get('creator', ''),
            'level': metadata['level'], 'levelReason': metadata['levelReason'],
            'topicIds': metadata['topicIds'], 'goalIds': [row['goalId'] for row in metadata['goalMappings']],
            'goalMappings': metadata['goalMappings'], 'duration': info['duration'],
            'cover': public_media(base_url, job_id, 'cover.webp'),
            'mediaUrl': public_media(base_url, job_id, 'master.m3u8'),
            'playback': {'masterUrl': public_media(base_url, job_id, 'master.m3u8'),
                         'variants': playback_variants},
            'pipelineStatus': 'READY', 'status': 'REVIEW',
        }
        result = {'video': video, 'sentences': learning, 'evidence': {
            'asrEngine': 'faster-whisper', 'subtitleCount': len(learning),
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
