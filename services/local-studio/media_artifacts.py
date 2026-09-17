"""Verified media-only checkpoints. Source identity is part of their namespace."""
import json
import shutil
from pathlib import Path

from checkpoint import atomic_json, file_sha256


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
        for row in receipt['files']:
            relative = Path(row['path'])
            source = cache / relative
            if relative.is_absolute() or '..' in relative.parts or source.is_symlink() or not source.resolve().is_relative_to(cache.resolve()):
                return None
            if source.stat().st_size != row['size'] or file_sha256(source) != row['sha256']:
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
    for source in media_files(output):
        if not source.is_file() or source.stat().st_size <= 0:
            raise ValueError('MEDIA_CHECKPOINT_INCOMPLETE')
        relative = source.relative_to(output).as_posix()
        target = cache / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        rows.append({'path': relative, 'size': source.stat().st_size, 'sha256': file_sha256(source)})
    atomic_json(cache / 'receipt.json', {'key': key, 'files': rows, 'value': value})
