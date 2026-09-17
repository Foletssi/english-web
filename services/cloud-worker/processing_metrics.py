"""Bounded, real stage observations for the current lease, never estimated history."""
from datetime import datetime, timezone

STEPS = {'LOCAL_DOWNLOAD': 'download', 'PROBE': 'probe', 'TRANSCODE': 'transcode',
         'ASR': 'asr', 'ENRICH': 'enrich', 'LOCAL_UPLOAD': 'output'}


def stage_metrics(lease, stage, metrics):
    metrics = dict(metrics or {})
    name = STEPS.get(stage)
    if stage == 'ENRICH' and str(metrics.get('substage', '')).startswith('teaching-voice'):
        name = 'voice'
    if not name:
        return metrics
    history = lease.setdefault('_stage_history', {})
    now = datetime.now(timezone.utc).isoformat()
    prior = lease.get('_measured_step')
    if prior and prior != name:
        history[prior]['completedAt'] = now
    row = history.setdefault(name, {'stageStartedAt': now, 'lastProgressAt': now})
    observation = {key: metrics[key] for key in ('current', 'total', 'unit', 'substage') if key in metrics}
    if observation != row.get('observation'):
        row['lastProgressAt'] = now
    row['observation'] = observation
    lease['_measured_step'] = name
    return {**metrics, 'stepHistory': {key: {**value, **value['observation']}
                                      for key, value in history.items()}}
