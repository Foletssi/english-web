"""Per-thread cancellation scope shared by media subprocesses and ASR."""
from contextlib import contextmanager
from contextvars import ContextVar
from contracts import StudioError

_cancelled = ContextVar('media_cancelled', default=None)


def check_cancelled():
    event = _cancelled.get()
    if event is not None and event.is_set():
        raise StudioError('JOB_LEASE_LOST_OR_CANCELLED', '任务已取消。')


@contextmanager
def cancellation_scope(event):
    token = _cancelled.set(event)
    try:
        check_cancelled()
        yield
    finally:
        _cancelled.reset(token)
