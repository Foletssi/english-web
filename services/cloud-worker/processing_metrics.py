"""Bounded, real stage observations for the current lease, never estimated history."""
from datetime import datetime, timezone
from stage_scheduler import active_stage

STAGE_WEIGHTS = {'media': 20, 'asr': 20, 'teaching': 25, 'voice': 15,
                 'upload_media': 2, 'upload_voice': 2}


def parallel_progress(lease, fallback):
    stages = lease.get('_parallel_stages')
    if stages is None:
        return fallback
    # Only completed milestones contribute; per-stage measured units remain visible.
    return min(99, 15 + sum(weight for name, weight in STAGE_WEIGHTS.items()
                          if stages.get(name, {}).get('state') == 'DONE'))


def record_stage(lease, name, state):
    now = datetime.now(timezone.utc).isoformat()
    lease.setdefault('_parallel_stages', {})[name] = dict(state)
    row = lease.setdefault('_stage_history', {}).setdefault(name, {'observation': {}})
    row.update(state, lastProgressAt=now)
    if state['state'] == 'RUNNING':
        row.setdefault('stageStartedAt', now)
    elif state['state'] == 'DONE':
        row['completedAt'] = now

STEPS = {'LOCAL_DOWNLOAD': 'download', 'PROBE': 'probe', 'TRANSCODE': 'transcode',
         'ASR': 'asr', 'ENRICH': 'enrich', 'LOCAL_UPLOAD': 'output'}


def stage_metrics(lease, stage, metrics):
    metrics = dict(metrics or {})
    name = active_stage.get() or metrics.pop('stageName', None) or STEPS.get(stage)
    if not active_stage.get() and stage == 'ENRICH' and str(metrics.get('substage', '')).startswith('teaching-voice'):
        name = 'voice'
    if not name:
        return metrics
    history = lease.setdefault('_stage_history', {})
    now = datetime.now(timezone.utc).isoformat()
    prior = lease.get('_measured_step')
    if prior and prior != name and '_parallel_stages' not in lease:
        history[prior]['completedAt'] = now
    row = history.setdefault(name, {'stageStartedAt': now, 'lastProgressAt': now})
    observation = {key: metrics[key] for key in ('current', 'total', 'unit', 'substage') if key in metrics}
    if observation != row.get('observation'):
        row['lastProgressAt'] = now
    row['observation'] = observation
    lease['_measured_step'] = name
    return {**metrics, 'stepHistory': {key: {**value, **value['observation']}
                                      for key, value in history.items()}}
