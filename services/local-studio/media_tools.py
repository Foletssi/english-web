import json
import math
import os
import shutil
import subprocess
import threading
import time
import uuid
import wave
from collections import deque
from fractions import Fraction
from pathlib import Path
from contracts import StudioError
from media_cancellation import check_cancelled
from checkpoint import canonical_hash, file_sha256, read_valid_json, save_json_checkpoint


def require_tools():
    missing = [name for name in ('ffmpeg', 'ffprobe') if not shutil.which(name)]
    if missing:
        raise StudioError('FFMPEG_NOT_FOUND', '请先安装 FFmpeg，并确保 ffmpeg/ffprobe 在 PATH 中。')


def encoding_threads():
    ceiling = max(1, (os.cpu_count() or 1) // 2)
    try:
        requested = int(os.getenv('EASTUDY_FFMPEG_THREADS', str(ceiling)))
    except ValueError:
        requested = ceiling
    return max(1, min(ceiling, requested))


def run(args, timeout=7200):
    require_tools()
    check_cancelled()
    try:
        with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0) as process:
            deadline = time.monotonic() + timeout
            try:
                while True:
                    check_cancelled()
                    if time.monotonic() >= deadline:
                        raise subprocess.TimeoutExpired(args, timeout)
                    try:
                        stdout, stderr = process.communicate(timeout=.25)
                        break
                    except subprocess.TimeoutExpired:
                        continue
                if process.returncode:
                    raise subprocess.CalledProcessError(process.returncode, args, stdout, stderr)
                return stdout
            finally:
                if process.poll() is None:
                    process.kill()
                    process.communicate(timeout=5)
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
                               text=True, encoding='utf-8', errors='replace',
                               creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

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
            check_cancelled()
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


def _parse_json_output(raw, code, label):
    try:
        data = json.loads(raw)
    except (TypeError, UnicodeError, ValueError) as error:
        size = len(raw or b'') if isinstance(raw, (bytes, bytearray)) else len(str(raw or ''))
        raise StudioError(code, f'{label} 未返回有效 JSON（{size} bytes）。', True) from error
    if not isinstance(data, dict):
        raise StudioError(code, f'{label} 返回的数据结构无效。', True)
    return data


def _ffprobe_json(args, code, label, timeout=60):
    last = None
    for attempt in range(2):
        raw = run(args, timeout)
        try:
            return _parse_json_output(raw, code, label)
        except StudioError as error:
            last = error
            if attempt == 0:
                time.sleep(.25)
    raise last


def probe(source):
    data = _ffprobe_json(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(source)],
                         'MEDIA_PROBE_INVALID', 'ffprobe')
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
    try:
        sar = Fraction(str(video.get('sample_aspect_ratio', '1:1')).replace(':', '/'))
        if sar > 0:
            width = float(width * sar)
    except (ValueError, ZeroDivisionError):
        pass
    rotation = next((x.get('rotation', 0) for x in video.get('side_data_list', []) if 'rotation' in x), 0)
    if round(abs(float(rotation))) % 180 == 90:
        width, height = height, width
    fps = Fraction(0)
    for value in (video.get('avg_frame_rate'), video.get('r_frame_rate')):
        try:
            fps = Fraction(str(value))
        except (TypeError, ValueError, ZeroDivisionError):
            continue
        if math.isfinite(fps) and fps > 0:
            break
    if not math.isfinite(fps) or fps <= 0:
        fps = Fraction(30)
    return {'duration': duration, 'width': width, 'height': height,
            'fps': float(fps), 'fpsExpression': str(fps)}


def ladder(width, height, source_fps=30):
    scale = min(1, 540 / min(width, height), 960 / max(width, height))
    encoded_width = max(2, math.floor(width * scale / 2) * 2)
    encoded_height = max(2, math.floor(height * scale / 2) * 2)
    try:
        source_fps = Fraction(str(source_fps))
    except (TypeError, ValueError, ZeroDivisionError):
        source_fps = Fraction(30)
    if not math.isfinite(source_fps) or source_fps <= 0:
        source_fps = Fraction(30)
    fps = source_fps / max(1, math.ceil(source_fps / 30))
    return [{'label': '540p', 'size': min(encoded_width, encoded_height),
             'width': encoded_width, 'height': encoded_height, 'rateK': 800, 'crf': 25,
             'fps': float(fps), 'fpsExpression': str(fps), 'audioRateK': 96,
             'preset': 'medium', 'segmentSeconds': 4,
             'profileVersion': 'balanced-540-v1'}]


def _profile_signature(level):
    fps = level['fpsExpression']
    return (f"{level['profileVersion']}-h264-crf{level['crf']}-{level['label']}-{level['width']}x{level['height']}-"
            f"{fps}fps-v{level['rateK']}-a{level['audioRateK']}-"
            f"{level['preset']}-seg{level['segmentSeconds']}")


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


def _hls_bandwidth(folder):
    """Include TS/audio overhead and measured segment peaks, not codec limits."""
    duration, samples = None, []
    for line in (folder / 'index.m3u8').read_text(encoding='utf-8').splitlines():
        if line.startswith('#EXTINF:'):
            duration = float(line.split(':', 1)[1].split(',')[0])
        elif line and not line.startswith('#') and duration:
            samples.append(((folder / line).stat().st_size * 8, duration))
            duration = None
    if not samples:
        raise StudioError('HLS_OUTPUT_INVALID', '视频分片时长无效。')
    return (math.ceil(max(bits / seconds for bits, seconds in samples)),
            math.ceil(sum(bits for bits, _ in samples) / sum(seconds for _, seconds in samples)))


def transcode(source, output, info, progress=None):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    master = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS']
    variants = []
    levels = ladder(info['width'], info['height'], info.get('fpsExpression', info.get('fps', 30)))
    for level_index, level in enumerate(levels):
        folder = output / level['label']
        scale = f"{level['width']}:{level['height']}"
        rate = level['rateK']
        audio_rate = level['audioRateK']
        fps = level['fpsExpression']
        segment_seconds = level['segmentSeconds']
        gop = max(1, round(level['fps'] * segment_seconds))
        profile_signature = _profile_signature(level)
        video = _valid_hls(folder, profile_signature)
        if video is None:
            partial = output / f".{level['label']}.{uuid.uuid4().hex}.partial"
            partial.mkdir()
            try:
                run_progress(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
             '-threads', str(encoding_threads()), '-filter_threads', str(encoding_threads()), '-i', str(source),
             '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn', '-vf', f'scale={scale}:flags=lanczos,setsar=1,fps={fps}',
             '-c:v', 'libx264', '-threads:v', str(encoding_threads()), '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-preset', level['preset'],
             '-crf', str(level['crf']), '-maxrate', f'{rate}k', '-bufsize', f'{rate * 2}k',
             '-g', str(gop), '-keyint_min', str(gop), '-sc_threshold', '0',
             '-force_key_frames', f'expr:gte(t,n_forced*{segment_seconds})',
             '-c:a', 'aac', '-b:a', f'{audio_rate}k', '-ar', '44100', '-ac', '2', '-f', 'hls',
             '-hls_time', str(segment_seconds),
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
        bandwidth, average_bandwidth = _hls_bandwidth(folder)
        master.extend([f'#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},AVERAGE-BANDWIDTH={average_bandwidth},RESOLUTION={width}x{height},FRAME-RATE={level["fps"]:.3f}',
                       f"{level['label']}/index.m3u8"])
        variants.append({'label': level['label'], 'path': f"{level['label']}/index.m3u8",
                         'width': width, 'height': height, 'bandwidth': bandwidth,
                         'frameRate': float(level['fps']), 'fpsExpression': fps,
                         'averageBandwidth': average_bandwidth, 'profileVersion': level['profileVersion']})
    (output / 'master.m3u8').write_text('\n'.join(master) + '\n', encoding='utf-8')
    return variants


def _valid_asr_audio(path):
    try:
        with wave.open(str(path), 'rb') as audio:
            if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getcomptype()) != (1, 2, 16000, 'NONE'):
                return False
            frames = audio.getnframes()
            if frames <= 0:
                return False
            size = 0
            while data := audio.readframes(65536):
                size += len(data)
            return size == frames * 2
    except (OSError, EOFError, wave.Error):
        return False


def extract_audio(source, target, source_identity=None):
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    key = canonical_hash({'source': source_identity or file_sha256(source), 'audio': 'pcm16k-mono-v1'})
    receipt = target.with_suffix('.receipt.json')

    def valid(value):
        return value if (target.is_file() and target.stat().st_size == value['size'] and
                         file_sha256(target) == value['sha256'] and _valid_asr_audio(target)) else None

    if read_valid_json(receipt, key, valid):
        return target
    temporary = target.with_name(f'.{target.stem}.{uuid.uuid4().hex}.wav')
    try:
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', str(source),
             '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(temporary)])
        if not _valid_asr_audio(temporary):
            raise StudioError('AUDIO_EMPTY', '提取出的音频不完整，请继续处理以重新提取。')
        with temporary.open('r+b') as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        save_json_checkpoint(receipt, key, {'size': target.stat().st_size, 'sha256': file_sha256(target)})
        return target
    finally:
        temporary.unlink(missing_ok=True)


def make_cover(source, target, duration, uploaded=None):
    from PIL import Image
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f'.{target.stem}.{uuid.uuid4().hex}.webp')
    input_file = Path(uploaded) if uploaded else Path(source)
    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
    if not uploaded:
        args.extend(['-ss', str(max(0.1, duration * .25))])
    args.extend(['-i', str(input_file), '-frames:v', '1', '-vf',
                 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
                 '-c:v', 'libwebp', '-quality', '85', str(temporary)])
    try:
        run(args, 120)
        with Image.open(temporary) as image:
            image.load()
        os.replace(temporary, target)
        return target
    finally:
        temporary.unlink(missing_ok=True)


def make_cover_variants(source, output):
    """Bounded WebP derivatives; never enlarge the input or change video output."""
    Path(output).mkdir(parents=True, exist_ok=True)
    rows = []
    for width, budget in ((320, 20 * 1024), (640, 45 * 1024), (960, 80 * 1024)):
        target = Path(output) / f'cover-{width}.webp'
        for quality in (75, 65, 55):
            run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                 '-i', str(source), '-frames:v', '1', '-vf',
                 f"scale=w='min({width},iw)':h='min({width * 9 // 16},ih)':force_original_aspect_ratio=decrease",
                 '-c:v', 'libwebp', '-quality', str(quality), str(target)], 120)
            if target.is_file() and 0 < target.stat().st_size <= budget:
                break
        if not target.is_file() or not 0 < target.stat().st_size <= budget:
            raise StudioError('COVER_INVALID', '缩略图生成失败。')
        # Width descriptors must match the encoded pixels, including small sources.
        measured_data = _ffprobe_json(['ffprobe', '-v', 'error',
            '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', str(target)],
            'COVER_PROBE_INVALID', '缩略图 ffprobe', 30)
        streams = measured_data.get('streams') or []
        if not streams or not isinstance(streams[0], dict):
            raise StudioError('COVER_PROBE_INVALID', '缩略图 ffprobe 未返回视频尺寸。', True)
        measured = streams[0]
        rows.append({'path': target.name, 'width': measured['width'], 'height': measured['height'],
                     'bytes': target.stat().st_size})
    return rows
