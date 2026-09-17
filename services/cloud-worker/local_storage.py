"""Explicit offline cleanup of completed application copies, never user originals."""
import argparse
import json
import os
from contextlib import contextmanager

from local_intake_store import IntakeError, LocalInputs


@contextmanager
def source_access(root, source_id):
    # Separate from intake ownership: maintenance readers also hold this lock.
    import uuid
    if str(uuid.UUID(source_id)) != source_id:
        raise IntakeError('SOURCE_ID_INVALID')
    path = root / (source_id + '.access.lock')
    if path.is_symlink():
        raise IntakeError('SOURCE_PATH_INVALID')
    with path.open('a+b') as stream:
        if os.name == 'nt':
            import msvcrt
            stream.seek(0)
            if not stream.read(1):
                stream.write(b'0')
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def cleanup_copy(store, source_id, authorize):
    # Store ownership proves the worker/intake writer is stopped. A separate
    # source lock prevents the standalone reencoder from reading during cleanup.
    with source_access(store.root, source_id):
        status = store.status(source_id)
        if status['state'] not in {'READY', 'MISSING'} or not authorize(status['source']):
            raise IntakeError('LOCAL_CLEANUP_NOT_COMPLETE')
        directory = store.directory(source_id)
        files = list(directory.iterdir())
        for path in files:
            if path.is_symlink() or not path.is_file() or path.resolve().parent != directory:
                raise IntakeError('SOURCE_PATH_INVALID')
        # Persist the recovery boundary before deletion; interruption is retryable.
        store.mark_missing(source_id)
        removed = 0
        for path in files:
            removed += path.stat().st_size
            path.unlink()
        with store.connect() as db:
            db.execute('DELETE FROM chunks WHERE source_id=?', (source_id,))
        return removed


def main():
    parser = argparse.ArgumentParser(description='查看本机占用或清理已完成原片副本；先停止处理服务。')
    parser.add_argument('--source-id', help='只处理这一个原片 ID')
    parser.add_argument('--confirm', action='store_true', help='确认清理应用副本；完成任务无法原位恢复原片，以后重做需重新选片建立新任务')
    args = parser.parse_args()
    from worker import EdgeClient, DEFAULT_ENDPOINT, default_worker_id, worker_root
    root = worker_root() / 'local-inputs-v1'
    store = LocalInputs(root)
    try:
        if not args.confirm:
            with store.connect() as db:
                copies = [{'sourceId': row[0], 'state': row[1], 'bytes': json.loads(row[2])['size']}
                          for row in db.execute('SELECT source_id,state,declaration FROM inputs')]
            print(json.dumps({'storage': store.storage_usage(), 'copies': copies}, ensure_ascii=False))
            return
        if not args.source_id:
            parser.error('--confirm requires --source-id')
        secret = os.getenv('EASTUDY_WORKER_SECRET', '').strip()
        if not secret:
            raise IntakeError('WORKER_SECRET_MISSING')
        client = EdgeClient(os.getenv('EASTUDY_PROCESSING_ENDPOINT', DEFAULT_ENDPOINT), secret,
                            os.getenv('EASTUDY_WORKER_ID', '').strip() or default_worker_id(), {})
        def authorize(source):
            result = client.call('worker-local-cleanup-status', sourceId=source['sourceId'])
            return result.get('cleanup', {}).get('allowed') is True
        removed = cleanup_copy(store, args.source_id, authorize)
        print(json.dumps({'removedBytes': removed, 'originalFileUntouched': True}))
    finally:
        store.close()


if __name__ == '__main__':
    main()
