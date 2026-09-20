"""Small dependency scheduler: ready stages only, bounded resources, cancellation."""
import os
import subprocess
import threading
from collections import deque
from contextlib import contextmanager
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextvars import ContextVar, copy_context
from dataclasses import dataclass

active_stage = ContextVar('active_processing_stage', default=None)


def _configured_limit(name, default, maximum):
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return min(maximum, max(1, value))


class FairResourceGate:
    """Bounded FIFO admission shared by every concurrently processed job."""
    def __init__(self, capacity):
        self.capacity = max(1, int(capacity))
        self._active = 0
        self._waiters = deque()
        self._condition = threading.Condition()

    @contextmanager
    def slot(self, check):
        ticket = object()
        admitted = False
        with self._condition:
            self._waiters.append(ticket)
            try:
                while self._active >= self.capacity or self._waiters[0] is not ticket:
                    check()
                    self._condition.wait(.25)
                self._waiters.popleft()
                self._active += 1
                admitted = True
                self._condition.notify_all()
            except BaseException:
                if not admitted:
                    try:
                        self._waiters.remove(ticket)
                    except ValueError:
                        pass
                    self._condition.notify_all()
                raise
        try:
            check()
            yield
        finally:
            with self._condition:
                self._active -= 1
                self._condition.notify_all()


_resource_limits = {
    'cpu_media': FairResourceGate(1),
    'gpu': FairResourceGate(1),
    'ai': FairResourceGate(_configured_limit('EASTUDY_GLOBAL_AI_CONCURRENCY', 3, 4)),
    'network': FairResourceGate(_configured_limit('EASTUDY_GLOBAL_NETWORK_CONCURRENCY', 4, 8)),
    'voice_batch': FairResourceGate(_configured_limit('EASTUDY_GLOBAL_VOICE_BATCH_CONCURRENCY', 2, 2)),
}
_resource_held = threading.local()


@contextmanager
def resource_slot(resource, cancelled=None):
    held = getattr(_resource_held, 'names', set())
    gate = _resource_limits.get(resource)
    def check():
        if cancelled and cancelled.is_set():
            raise RuntimeError('JOB_LEASE_LOST_OR_CANCELLED')
    check()
    if gate is None or resource in held:
        yield
        return
    with gate.slot(check):
        _resource_held.names = held | {resource}
        try:
            yield
        finally:
            _resource_held.names = held


def execute_stage(stage, dependencies, cancelled=None):
    token = active_stage.set(stage.name)
    try:
        with resource_slot(stage.resource, cancelled):
            return stage.execute(dependencies)
    finally:
        active_stage.reset(token)


@dataclass(frozen=True)
class Stage:
    name: str
    needs: tuple
    resource: str
    execute: object


def parallel_workers():
    # Fail conservatively when the GPU budget cannot be measured. ASR and voice
    # still share one resource slot even on machines with ample free memory.
    if os.getenv('EASTUDY_SERIAL_PIPELINE') == '1' or (os.cpu_count() or 1) < 4:
        return 1
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.free', '--format=csv,noheader,nounits'],
            capture_output=True, text=True, check=True, timeout=3,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        free = [int(line.strip()) for line in result.stdout.splitlines() if line.strip()]
        return 3 if free and min(free) >= 4096 else 1
    except (OSError, ValueError, subprocess.SubprocessError):
        return 1


def run_stages(stages, cancelled=None, observe=None, workers=None):
    pending = {stage.name: stage for stage in stages}
    if len(pending) != len(stages):
        raise ValueError('DUPLICATE_STAGE')
    known = set()
    while len(known) < len(stages):
        ready = {s.name for s in stages if set(s.needs) <= known}
        if ready <= known:
            raise ValueError('INVALID_STAGE_DEPENDENCIES')
        known |= ready
    results, failures, blocked, running, occupied = {}, {}, set(), {}, set()
    limit = workers or parallel_workers()

    def event(name, state, **extra):
        if observe:
            observe(name, {'state': state, **extra})

    with ThreadPoolExecutor(max_workers=limit, thread_name_prefix='media-stage') as pool:
        while pending or running:
            if cancelled and cancelled.is_set():
                for future in running:
                    future.cancel()
                raise RuntimeError('JOB_LEASE_LOST_OR_CANCELLED')
            for name, stage in list(pending.items()):
                if set(stage.needs) & (set(failures) | blocked):
                    blocked.add(name)
                    del pending[name]
                    event(name, 'BLOCKED')
                    continue
                if len(running) >= limit or stage.resource in occupied or not set(stage.needs) <= results.keys():
                    continue
                event(name, 'RUNNING')
                deps = {key: results[key] for key in stage.needs}
                future = pool.submit(copy_context().run, execute_stage, stage, deps, cancelled)
                running[future] = stage
                occupied.add(stage.resource)
                del pending[name]
            if not running:
                continue
            finished, _ = wait(running, timeout=.25, return_when=FIRST_COMPLETED)
            for future in finished:
                stage = running.pop(future)
                occupied.remove(stage.resource)
                try:
                    results[stage.name] = future.result()
                except Exception as error:
                    failures[stage.name] = error
                    event(stage.name, 'ERROR', errorCode=str(getattr(error, 'code', type(error).__name__))[:120])
                else:
                    event(stage.name, 'DONE')
    if failures:
        raise next(iter(failures.values()))
    return results
