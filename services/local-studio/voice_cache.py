"""Validated local synthesis cache; cloud ownership remains per video/job."""
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

from checkpoint import atomic_json, file_sha256


def copy_audio(source, destination):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.part', delete=False) as stream:
        staging = Path(stream.name)
    try:
        shutil.copyfile(source, staging)
        os.replace(staging, destination)
    finally:
        staging.unlink(missing_ok=True)


def restore_audio(cache_root, fingerprint, destination):
    """Receipts are written only after full audio validation; recheck bytes/hash."""
    if not cache_root:
        return None
    root = Path(cache_root)
    source = root / f'{fingerprint}.mp3'
    staging = None
    try:
        receipt = json.loads((root / f'{fingerprint}.json').read_text(encoding='utf-8'))
        metadata = receipt['metadata']
        if (receipt['schemaVersion'] != 1 or receipt['fingerprint'] != fingerprint
                or not .08 <= metadata['duration'] <= 30
                or metadata['contentType'] != 'audio/mpeg'
                or not 500 <= metadata['bytes'] <= 1048576
                or source.stat().st_size != metadata['bytes']
                or file_sha256(source) != metadata['contentHash']):
            return None
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix='.part', delete=False) as stream:
            staging = Path(stream.name)
        copy_audio(source, staging)
        # Another worker may replace the source between verification and copy.
        # Only accept the bytes actually delivered to this job.
        if (staging.stat().st_size != metadata['bytes']
                or file_sha256(staging) != metadata['contentHash']):
            return None
        os.replace(staging, destination)
        try:
            os.utime(root / f'{fingerprint}.json', None)
        except OSError:
            pass  # Cache recency is optional; valid job audio is already delivered.
        return metadata
    except (OSError, ValueError, KeyError, TypeError):
        return None
    finally:
        if staging is not None:
            staging.unlink(missing_ok=True)


def store_audio(cache_root, fingerprint, source, metadata):
    if not cache_root:
        return
    root = Path(cache_root)
    copy_audio(source, root / f'{fingerprint}.mp3')
    atomic_json(root / f'{fingerprint}.json', {
        'schemaVersion': 1, 'fingerprint': fingerprint, 'metadata': metadata})


def prune_cache(cache_root, max_bytes=None):
    """Bound rebuildable audio only; never recurse into job outputs or follow links.

    Run at a batch boundary. Concurrent readers tolerate eviction as a cache miss;
    their independently copied job assets are never deleted here.
    """
    if not cache_root:
        return
    try:
        limit = max_bytes if max_bytes is not None else int(
            os.getenv('EASTUDY_VOICE_CACHE_MAX_BYTES', str(512 * 1024 * 1024)))
        if type(limit) is not int or limit < 0:
            return
        root = Path(cache_root)
        if root.is_symlink() or root.is_junction():
            return
        root = root.resolve()
        entries = []
        for receipt_path in root.glob('*.json'):
            if not re.fullmatch(r'[a-f0-9]{64}', receipt_path.stem):
                continue
            audio = receipt_path.with_suffix('.mp3')
            if receipt_path.is_symlink() or audio.is_symlink():
                continue
            try:
                receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
                if (not isinstance(receipt, dict) or receipt.get('schemaVersion') != 1
                        or receipt.get('fingerprint') != receipt_path.stem):
                    continue
                stat = receipt_path.stat()
                size = stat.st_size + audio.stat().st_size
                entries.append((stat.st_mtime_ns, size, receipt_path, audio))
            except (OSError, ValueError, TypeError):
                continue
        total = sum(entry[1] for entry in entries)
        for modified, size, receipt_path, audio in sorted(entries):
            if total <= limit:
                break
            try:
                # A fresh read/write since the scan protects this entry this pass.
                if (receipt_path.is_symlink() or audio.is_symlink()
                        or receipt_path.stat().st_mtime_ns != modified):
                    continue
                receipt_path.unlink()
                audio.unlink(missing_ok=True)
                total -= size
            except OSError:
                continue
    except (OSError, ValueError):
        pass  # Cache maintenance cannot fail teaching generation.
