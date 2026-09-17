"""Verified media-only checkpoints. Source identity is part of their namespace."""
import json
import shutil
from pathlib import Path

from checkpoint import atomic_json, file_sha256


def contained(root, relative):
    root = Path(root)
    relative = Path(relative)
    target = root / relative
    if relative.is_absolute() or relative.drive or '..' in relative.parts or not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('MEDIA_CHECKPOINT_PATH_INVALID')
    component = root
    for part in relative.parts:
        component = component / part
        if component.is_symlink():
            raise ValueError('MEDIA_CHECKPOINT_PATH_INVALID')
    return target


def required_files(root, value):
    required = {'master.m3u8', 'cover.webp'}
    variants = value['variants']
    covers = value['coverImages']
    if not variants or not covers:
        raise ValueError('MEDIA_CHECKPOINT_INCOMPLETE')
    required.update(row['path'] for row in variants)
    required.update(row['path'] for row in covers)
    master = contained(root, 'master.m3u8').read_text(encoding='utf-8')
    referenced = {line.strip() for line in master.splitlines() if line.strip() and not line.strip().startswith('#')}
    if referenced != {row['path'] for row in variants}:
        raise ValueError('MEDIA_CHECKPOINT_PLAYLIST_MISMATCH')
    for row in variants:
        playlist = contained(root, row['path'])
        text = playlist.read_text(encoding='utf-8')
        if '#EXT-X-ENDLIST' not in text:
            raise ValueError('MEDIA_CHECKPOINT_NOT_FINAL')
        segments = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith('#')]
        if not segments:
            raise ValueError('MEDIA_CHECKPOINT_EMPTY')
        for segment in segments:
            relative = (Path(row['path']).parent / segment).as_posix()
            contained(root, relative)
            required.add(relative)
    return required


def media_files(output):
    output = Path(output)
    files = [output / 'master.m3u8', output / 'cover.webp']
    files.extend(output.glob('cover-*.webp'))
    files.extend(output.glob('*p/index.m3u8'))
    files.extend(output.glob('*p/*.ts'))
    return sorted(set(files))


def restore_media(cache, output, key):
    cache, output = Path(cache), Path(output)
    try:
        receipt = json.loads((cache / 'receipt.json').read_text(encoding='utf-8'))
        if receipt['key'] != key or not receipt['files']:
            return None
        paths = [row['path'] for row in receipt['files']]
        if len(paths) != len(set(paths)) or set(paths) != required_files(cache, receipt['value']):
            return None
        for row in receipt['files']:
            source = contained(cache, row['path'])
            contained(output, row['path'])
            if row['size'] <= 0 or source.stat().st_size != row['size'] or file_sha256(source) != row['sha256']:
                return None
        for row in receipt['files']:
            target = output / row['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(cache / row['path'], target)
        return receipt['value']
    except (OSError, ValueError, KeyError, TypeError):
        return None


def save_media(cache, output, key, value):
    cache, output = Path(cache), Path(output)
    cache.mkdir(parents=True, exist_ok=True)
    rows = []
    for relative in sorted(required_files(output, value)):
        source = contained(output, relative)
        if not source.is_file() or source.stat().st_size <= 0:
            raise ValueError('MEDIA_CHECKPOINT_INCOMPLETE')
        target = contained(cache, relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        rows.append({'path': relative, 'size': source.stat().st_size, 'sha256': file_sha256(source)})
    atomic_json(cache / 'receipt.json', {'key': key, 'files': rows, 'value': value})
