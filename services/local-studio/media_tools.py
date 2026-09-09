import json
import math
import os
import shutil
import subprocess
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from contracts import StudioError


def require_tools():
    missing = [name for name in ('ffmpeg', 'ffprobe') if not shutil.which(name)]
    if missing:
        raise StudioError('FFMPEG_NOT_FOUND', '请先安装 FFmpeg，并确保 ffmpeg/ffprobe 在 PATH 中。')


def run(args, timeout=7200):
    require_tools()
    try:
        result = subprocess.run(args, check=True, capture_output=True, timeout=timeout)
        return result.stdout
    except subprocess.TimeoutExpired as error:
        raise StudioError('MEDIA_TIMEOUT', '视频处理超时。', True) from error
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode('utf-8', 'replace')[-1200:]
        raise StudioError('MEDIA_COMMAND_FAILED', detail or 'FFmpeg 处理失败。') from error


def run_progress(args, duration, progress=None, timeout=7200):
    require_tools()
    progress = progress or (lambda *_: None)
    command = list(args[:-1]) + ['-progress', 'pipe:1', '-stats_period', '1', '-nostats', args[-1]]
    errors, reader_errors, latest = deque(maxlen=80), [], [None]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding='utf-8', errors='replace')

    def stdout_reader():
        record = {}
        try:
            for line in process.stdout:
                key, separator, value = line.strip().partition('=')
                if not separator:
                    continue
                record[key] = value
                if key == 'progress':
                    raw = record.get('out_time_us')
                    if raw not in (None, 'N/A') and duration > 0:
                        current = min(duration, max(0.0, int(raw) / 1_000_000))
                        latest[0] = (current, duration)
                    record = {}
        except Exception as error:
            reader_errors.append(error)

    def stderr_reader():
        try:
            for line in process.stderr:
                errors.append(line.rstrip()[-2000:])
        except Exception as error:
            reader_errors.append(error)

    readers = [threading.Thread(target=stdout_reader, daemon=True),
               threading.Thread(target=stderr_reader, daemon=True)]
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + timeout
    last_report = 0.0
    try:
        while process.poll() is None:
            if time.monotonic() >= deadline:
                raise StudioError('MEDIA_TIMEOUT', '视频处理超时。', True)
            if reader_errors:
                raise StudioError('MEDIA_PROGRESS_FAILED', '无法读取视频处理进度。', True)
            now = time.monotonic()
            if latest[0] is not None and now - last_report >= 1:
                progress(*latest[0])
                last_report = now
            time.sleep(.1)
        for reader in readers:
            reader.join(timeout=2)
        if any(reader.is_alive() for reader in readers) or reader_errors:
            raise StudioError('MEDIA_PROGRESS_FAILED', '无法读取视频处理进度。', True)
        if process.returncode:
            raise StudioError('MEDIA_COMMAND_FAILED', '\n'.join(errors)[-1200:] or 'FFmpeg 处理失败。')
        if latest[0] is not None:
            progress(*latest[0])
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        for reader in readers:
            reader.join(timeout=2)
        process.stdout.close()
        process.stderr.close()


def probe(source):
    raw = run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(source)], 60)
    data = json.loads(raw)
    streams = data.get('streams', [])
    video = next((x for x in streams if x.get('codec_type') == 'video'), None)
    if not video:
        raise StudioError('NO_VIDEO_TRACK', '文件中没有视频轨道。')
    if not any(x.get('codec_type') == 'audio' for x in streams):
        raise StudioError('NO_AUDIO_TRACK', '文件中没有音轨，无法生成学习字幕。')
    duration = float(data.get('format', {}).get('duration', 0))
    if not math.isfinite(duration) or not 0 < duration <= 7200:
        raise StudioError('VIDEO_DURATION_INVALID', '视频必须在 2 小时以内。')
    width, height = int(video['width']), int(video['height'])
    rotation = next((x.get('rotation', 0) for x in video.get('side_data_list', []) if 'rotation' in x), 0)
    if round(abs(float(rotation))) % 180 == 90:
        width, height = height, width
    fps = 0.0
    for value in (video.get('avg_frame_rate'), video.get('r_frame_rate')):
        try:
            numerator, denominator = str(value).split('/', 1)
            fps = float(numerator) / float(denominator)
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if math.isfinite(fps) and fps > 0:
            break
    if not math.isfinite(fps) or fps <= 0:
        fps = 30.0
    return {'duration': duration, 'width': width, 'height': height, 'fps': fps}


def ladder(width, height, source_fps=30):
    short = min(width, height)
    # The uploaded source remains available as the original-quality rendition.
    # Re-encoding the same 1080p input at a fixed 3.5 Mbps only duplicates it
    # (and can make it larger), so HLS is reserved for network fallback levels.
    # FormatFactory's space-saving profile also caps 480p at 24 fps. Keep H.264
    # here for browser-wide HLS support instead of copying its HEVC-only output.
    profiles = ((480, 900, 24, 64), (720, 1800, 30, 96))
    values = [(size, rate, fps, audio) for size, rate, fps, audio in profiles if size <= short]
    if not values:
        values = [(max(2, short // 2 * 2), 600, 24, 64)]
    try:
        source_fps = float(source_fps)
    except (TypeError, ValueError):
        source_fps = 30.0
    if not math.isfinite(source_fps) or source_fps <= 0:
        source_fps = 30.0
    return [{'label': f'{size}p', 'size': size, 'rateK': rate, 'crf': 23,
             'fps': min(source_fps, fps), 'audioRateK': audio}
            for size, rate, fps, audio in values]


def _profile_signature(level):
    fps = f"{level['fps']:.3f}".rstrip('0').rstrip('.')
    return (f"web-h264-crf{level['crf']}-{level['label']}-{fps}fps-"
            f"a{level['audioRateK']}-v1")


def _valid_hls(folder, expected_profile=None):
    playlist = Path(folder) / 'index.m3u8'
    try:
        text = playlist.read_text(encoding='utf-8')
        if expected_profile and f'#EASTUDY-PROFILE:{expected_profile}' not in text:
            return None
        names = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith('#')]
        if '#EXT-X-ENDLIST' not in text or not names or any('/' in name or '\\' in name for name in names):
            return None
        segments = [Path(folder) / name for name in names]
        if any(not item.is_file() or item.stat().st_size <= 0 for item in segments):
            return None
        sample = json.loads(run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(playlist)], 60))
        video = next((x for x in sample.get('streams', []) if x.get('codec_type') == 'video'), None)
        return video
    except (OSError, ValueError, StudioError):
        return None


def transcode(source, output, info, progress=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    vertical = info['height'] > info['width']
    master = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS']
    variants = []
    levels = ladder(info['width'], info['height'], info.get('fps', 30))
    for level_index, level in enumerate(levels):
        folder = output / level['label']
        scale = f"{level['size']}:-2" if vertical else f"-2:{level['size']}"
        rate = level['rateK']
        audio_rate = level['audioRateK']
        fps = f"{level['fps']:.3f}".rstrip('0').rstrip('.')
        gop = max(1, round(level['fps'] * 4))
        profile_signature = _profile_signature(level)
        video = _valid_hls(folder, profile_signature)
        if video is None:
            partial = output / f".{level['label']}.{uuid.uuid4().hex}.partial"
            partial.mkdir()
            try:
                run_progress(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(source),
             '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn', '-vf', f'scale={scale}:flags=lanczos,setsar=1,fps={fps}',
             '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
             '-crf', str(level['crf']), '-maxrate', f'{rate}k', '-bufsize', f'{rate * 2}k',
             '-g', str(gop), '-keyint_min', str(gop), '-sc_threshold', '0', '-force_key_frames', 'expr:gte(t,n_forced*4)',
             '-c:a', 'aac', '-b:a', f'{audio_rate}k', '-ar', '44100', '-ac', '2', '-f', 'hls', '-hls_time', '4',
             '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments', '-hls_list_size', '0',
             '-hls_segment_filename', str(partial / 'segment_%05d.ts'), str(partial / 'index.m3u8')],
             info['duration'], lambda current, total: progress and progress(
                 level_index, len(levels), level['label'], current, total))
                video = _valid_hls(partial)
                if not video:
                    raise StudioError('HLS_OUTPUT_INVALID', f"{level['label']} 转码产物无法解码。")
                playlist = partial / 'index.m3u8'
                text = playlist.read_text(encoding='utf-8')
                text = text.replace('#EXTM3U\n', f'#EXTM3U\n#EASTUDY-PROFILE:{profile_signature}\n', 1)
                playlist.write_text(text, encoding='utf-8')
                video = _valid_hls(partial, profile_signature)
                if not video:
                    raise StudioError('HLS_OUTPUT_INVALID', f"{level['label']} 转码配置校验失败。")
                if folder.exists():
                    shutil.rmtree(folder)
                os.replace(partial, folder)
            finally:
                if partial.exists():
                    shutil.rmtree(partial)
        elif progress:
            progress(level_index, len(levels), level['label'], info['duration'], info['duration'])
        if not video:
            raise StudioError('HLS_OUTPUT_INVALID', f"{level['label']} 无法解码。")
        width, height = int(video['width']), int(video['height'])
        bandwidth = (rate + audio_rate) * 1000
        master.extend([f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},RESOLUTION={width}x{height},FRAME-RATE={level["fps"]:.3f}',
                       f"{level['label']}/index.m3u8"])
        variants.append({'label': level['label'], 'path': f"{level['label']}/index.m3u8",
                         'width': width, 'height': height, 'bandwidth': bandwidth,
                         'frameRate': round(level['fps'], 3)})
    (output / 'master.m3u8').write_text('\n'.join(master) + '\n', encoding='utf-8')
    return variants


def extract_audio(source, target):
    if Path(target).is_file() and Path(target).stat().st_size > 44:
        return Path(target)
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(source),
         '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(target)])
    if not Path(target).is_file() or Path(target).stat().st_size <= 44:
        raise StudioError('AUDIO_EMPTY', '提取出的音频为空。')
    return Path(target)


def make_cover(source, target, duration, uploaded=None):
    if Path(target).is_file() and Path(target).stat().st_size > 0:
        return Path(target)
    input_file = Path(uploaded) if uploaded else Path(source)
    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
    if not uploaded:
        args.extend(['-ss', str(max(0.1, duration * .25))])
    args.extend(['-i', str(input_file), '-frames:v', '1', '-vf',
                 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
                 '-c:v', 'libwebp', '-quality', '85', str(target)])
    run(args, 120)
    if not Path(target).is_file() or Path(target).stat().st_size == 0:
        raise StudioError('COVER_INVALID', '封面图片无法读取。')
    return Path(target)
