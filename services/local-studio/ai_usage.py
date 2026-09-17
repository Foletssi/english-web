"""Per-attempt usage receipts. Never persist prompts, responses or credentials."""
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import threading
import uuid

_context = ContextVar('ai_usage_context', default={})
_lock = threading.Lock()
_write_failures = 0


def job_usage_config(config, job_id, directory, run_id=None):
    result = dict(config or {})
    result.setdefault('jobId', job_id)
    result.setdefault('runId', run_id or uuid.uuid4().hex)
    result.setdefault('usageLogPath', str(Path(directory) / 'ai-usage.jsonl'))
    record_usage('run_started', result)
    return result


@contextmanager
def usage_scope(cache_dir, stage, key):
    token = _context.set({'path': str(Path(cache_dir) / 'ai-usage.jsonl') if cache_dir else None,
                          'stage': stage, 'operationKey': key, 'attemptId': uuid.uuid4().hex})
    try:
        yield
    finally:
        _context.reset(token)


def usage_fields(raw):
    raw = raw if isinstance(raw, dict) else {}
    result = {}
    fields = {'promptTokens': ('prompt_tokens',), 'completionTokens': ('completion_tokens',),
              'totalTokens': ('total_tokens',),
              'reasoningTokens': ('completion_tokens_details', 'reasoning_tokens'),
              'cachedPromptTokens': ('prompt_tokens_details', 'cached_tokens'),
              'cacheHitTokens': ('prompt_cache_hit_tokens',),
              'cacheMissTokens': ('prompt_cache_miss_tokens',)}
    for name, keys in fields.items():
        value = raw
        for key in keys:
            value = value.get(key) if isinstance(value, dict) else None
        if type(value) is int and value >= 0:
            result[name] = value
    return result


def record_usage(event, config=None, **fields):
    global _write_failures
    config = config or {}
    context = _context.get()
    path = config.get('usageLogPath') or context.get('path')
    if not path:
        return None
    # Strict allowlist: do not log provider error bodies, input text or config.
    record = {'schemaVersion': 1, 'event': event,
              'at': datetime.now(timezone.utc).isoformat(),
              'stage': context.get('stage', 'direct'),
              'operationKey': context.get('operationKey'),
              'attemptId': fields.get('attemptId') or context.get('attemptId') or uuid.uuid4().hex}
    for key in ('jobId', 'runId'):
        if config.get(key):
            record[key] = str(config[key])[:100]
    for key in ('model', 'configuredModel', 'requestId', 'errorCode', 'status', 'elapsedSeconds'):
        value = fields.get(key)
        if isinstance(value, str):
            record[key] = value[:160]
        elif type(value) in (int, float):
            record[key] = value
    if event == 'request':
        record['usage'] = usage_fields(fields.get('usage'))
        record['usageKnown'] = {'promptTokens', 'completionTokens'} <= record['usage'].keys()
    try:
        with _lock:
            target = Path(path)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(record, ensure_ascii=False, allow_nan=False) + '\n')
    except (OSError, ValueError, TypeError):
        # Logging failure cannot turn a completed paid call into an API retry.
        with _lock:
            _write_failures += 1
        print('[ai-usage] 用量记录写入失败；本次请求不会因此重复执行。', file=sys.stderr)
    return record['attemptId']


def summarize_usage(path, run_id=None):
    summary = {'requests': 0, 'failedRequests': 0, 'unknownUsageRequests': 0,
               'cacheHits': 0, 'validationFailures': 0, 'malformedRecords': 0,
               'preflightFailures': 0, 'usage': {}, 'stages': {},
               'ledgerWriteFailuresProcess': _write_failures, 'runObserved': False}
    try:
        with Path(path).open('rb') as stream:
            for line in stream:
                try:
                    record = json.loads(line.decode('utf-8'))
                    if not isinstance(record, dict):
                        raise ValueError('invalid receipt')
                except ValueError:
                    summary['malformedRecords'] += 1
                    continue
                if run_id is not None and record.get('runId') != run_id:
                    continue
                event = record.get('event')
                summary['runObserved'] = True
                if event == 'preflight_failed':
                    summary['preflightFailures'] += 1
                elif event == 'cache_hit':
                    summary['cacheHits'] += 1
                elif event == 'validation_failed':
                    summary['validationFailures'] += 1
                elif event == 'request':
                    summary['requests'] += 1
                    summary['failedRequests'] += record.get('status') != 'ok'
                    summary['unknownUsageRequests'] += not record.get('usageKnown', False)
                    name = record.get('stage', 'direct')
                    usage = record.get('usage', {})
                    if not isinstance(name, str) or not isinstance(usage, dict):
                        summary['malformedRecords'] += 1
                        continue
                    stage = summary['stages'].setdefault(name,
                                                         {'requests': 0, 'usage': {}})
                    stage['requests'] += 1
                    for key, value in usage.items():
                        if type(value) is int and value >= 0:
                            summary['usage'][key] = summary['usage'].get(key, 0) + value
                            stage['usage'][key] = stage['usage'].get(key, 0) + value
    except OSError:
        summary['ledgerUnavailable'] = True
    summary['complete'] = bool(summary['runObserved'] and not any((
        summary.get('ledgerUnavailable'), summary['unknownUsageRequests'],
        summary['malformedRecords'], summary['ledgerWriteFailuresProcess'])))
    return summary
