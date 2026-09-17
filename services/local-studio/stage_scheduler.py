"""Small dependency scheduler: ready stages only, bounded resources, cancellation."""
import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextvars import ContextVar, copy_context
from dataclasses import dataclass

active_stage = ContextVar('active_processing_stage', default=None)


def execute_stage(stage, dependencies):
    token = active_stage.set(stage.name)
    try:
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
    # ASR/voice share one GPU; encoding is CPU-only. Small machines stay serial.
    return 1 if os.getenv('EASTUDY_SERIAL_PIPELINE') == '1' or (os.cpu_count() or 1) < 4 else 3


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
                future = pool.submit(copy_context().run, execute_stage, stage, deps)
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
                    event(stage.name, 'DONE')
                except Exception as error:
                    failures[stage.name] = error
                    event(stage.name, 'ERROR', errorCode=type(error).__name__)
    if failures:
        raise next(iter(failures.values()))
    return results
