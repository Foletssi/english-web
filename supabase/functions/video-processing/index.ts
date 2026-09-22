const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-cron-secret, x-worker-secret',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

const env = (name: string) => (Deno.env.get(name) || '').trim();
const required = (name: string) => { const value = env(name); if (!value) throw new Error(`CONFIG_${name}_MISSING`); return value; };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: cors });

async function supabase(path: string, init: RequestInit = {}) {
  const key = required('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(required('SUPABASE_URL') + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const transient: Record<string, string> = {
      '57014': 'DB_STATEMENT_TIMEOUT', '55P03': 'DB_LOCK_TIMEOUT',
      '40001': 'DB_SERIALIZATION_RETRY', '40P01': 'DB_DEADLOCK_RETRY'
    };
    // Keep business rejections distinct from retryable transaction failures.
    const retryCode = transient[String(payload?.code || '')];
    throw new Error(`SUPABASE_${retryCode ? 503 : response.status}:${retryCode || payload?.message || payload?.code || 'REQUEST_FAILED'}`);
  }
  return payload;
}

async function rpc(name: string, body: Record<string, unknown> = {}) {
  return supabase(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function workerAuthorized(request: Request) {
  const secret = env('WORKER_SECRET');
  return Boolean(secret && request.headers.get('x-worker-secret') === secret);
}

function workerPayload(value: any) {
  const workerId = String(value?.workerId || '').trim();
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(workerId)) throw new Error('WORKER_ID_INVALID');
  const capabilities = value?.capabilities && typeof value.capabilities === 'object' ? value.capabilities : {};
  return { workerId, capabilities };
}

async function handleWorker(action: string, body: any) {
  const { workerId, capabilities } = workerPayload(body);
  if (action === 'worker-heartbeat') {
    const worker = await rpc('processing_worker_heartbeat', {
      p_worker_id: workerId, p_capabilities: capabilities, p_version: String(body.version || '').slice(0, 80) || null
    });
    return { worker };
  }
  if (action === 'worker-local-challenge') {
    await rpc('processing_worker_heartbeat', { p_worker_id: workerId, p_capabilities: capabilities, p_version: String(body.version || '') });
    return { challenge: await rpc('processing_local_challenge_v1', {
      p_worker_id: workerId, p_challenge: body.challenge, p_origin: body.origin
    }) };
  }
  if (action === 'worker-local-ticket') return { intake: await rpc('processing_local_ticket_v1', {
    p_worker_id: workerId, p_ticket: body.ticket, p_origin: body.origin
  }) };
  if (action === 'worker-local-cleanup-status') return { cleanup: await rpc('processing_local_cleanup_status_v1', {
    p_worker_id: workerId, p_source_id: body.sourceId
  }) };
  if (action === 'worker-local-ready') return { input: await rpc('processing_local_ready_v1', {
    p_worker_id: workerId, p_source_id: body.sourceId, p_sha256: body.sha256
  }) };
  if (action === 'worker-local-missing') return { input: await rpc('processing_local_missing_v1', {
    p_worker_id: workerId, p_source_id: body.sourceId, p_sha256: body.sha256
  }) };
  if (action === 'worker-claim' || action === 'worker-claim-local-v1') {
    await rpc('processing_worker_heartbeat', {
      p_worker_id: workerId, p_capabilities: capabilities, p_version: String(body.version || '').slice(0, 80) || null
    });
    const token = randomToken();
    const job = await rpc(action === 'worker-claim-local-v1' ? 'processing_claim_local_input_v1' : 'processing_claim_local_job_v5', {
      p_worker_id: workerId, p_token_hash: await sha256(token), p_lease_seconds: 240
    });
    if (!job) return { job: null };
    const base = required('PUBLIC_SOURCE_BASE_URL').replace(/\/$/, '');
    return {
      job, token, protocolVersion: job.run_id ? 2 : 1, workerId,
      inputSource: job.inputSource || { kind: 'cloud_r2', key: job.source_key },
      downloadUrl: job.inputSource ? null : `${base}/api/processing/source?job=${encodeURIComponent(job.id)}&token=${encodeURIComponent(token)}`,
      outputUrl: `${base}/api/processing/output?job=${encodeURIComponent(job.id)}&token=${encodeURIComponent(token)}${job.run_id ? `&run=${encodeURIComponent(job.run_id)}` : ''}`
    };
  }
  const jobId = String(body.jobId || '');
  const token = String(body.token || '');
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || token.length < 32 || token.length > 256) throw new Error('JOB_TOKEN_INVALID');
  const runId = String(body.runId || '');
  const v2 = action.endsWith('-v2') || action.endsWith('-v3') || action.endsWith('-v4') || action.endsWith('-v5');
  if (v2 && !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('RUN_ID_INVALID');
  if (action === 'worker-job-heartbeat-v2') {
    return { job: await rpc('processing_heartbeat_job_v2', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_capabilities: capabilities, p_lease_seconds: 240
    }) };
  }
  if (action === 'worker-telemetry-v2') {
    return { job: await rpc('processing_report_job_v2', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_sequence: Number(body.sequence), p_stage: body.stage,
      p_progress: Number(body.progress), p_message: String(body.message || '').slice(0, 300),
      p_metrics: body.metrics && typeof body.metrics === 'object' ? body.metrics : {}
    }) };
  }
  if (action === 'worker-validate-teaching-v2') {
    return { validation: await rpc('processing_validate_teaching_v2', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId, p_sentences: body.sentences
    }) };
  }
  if (action === 'worker-output-receipt-v2') {
    return { receipt: await rpc('processing_record_output_v2', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_path: String(body.path || ''), p_size: Number(body.size),
      p_sha256: String(body.sha256 || ''), p_etag: String(body.etag || '')
    }) };
  }
  if (action === 'worker-output-receipts-v3') {
    return { receipt: await rpc('processing_record_outputs_v3', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_receipts: Array.isArray(body.receipts) ? body.receipts : []
    }) };
  }
  if (action === 'worker-finalization-status-v3') {
    return { finalization: await rpc('processing_finalization_status_v3', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId
    }) };
  }
  if (action === 'worker-defer-v3') {
    return { finalization: await rpc('processing_defer_job_v3', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_error: body.error || {}
    }) };
  }
  if (action === 'worker-fail-v3') {
    return { job: await rpc('processing_fail_job_v3', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_error: body.error || {}, p_retryable: body.retryable !== false
    }) };
  }
  if (action === 'worker-complete-v3') {
    return { result: await rpc('processing_commit_leased_result_v3', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_result: body.result, p_manifest: Array.isArray(body.manifest) ? body.manifest : []
    }) };
  }
  if (action === 'worker-complete-learning-v4') {
    return { result: await rpc('processing_commit_learning_repair_v4', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_result: body.result
    }) };
  }
  if (action === 'worker-complete-learning-v5') {
    return { result: await rpc('processing_commit_learning_repair_v5', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_result: body.result
    }) };
  }
  if (action === 'worker-job-heartbeat') {
    return { job: await rpc('processing_heartbeat_job', {
      p_job_id: jobId, p_token: token, p_worker_id: workerId, p_capabilities: capabilities, p_lease_seconds: 240
    }) };
  }
  if (action === 'worker-progress') {
    return { job: await rpc('processing_progress_job', {
      p_job_id: jobId, p_token: token, p_stage: body.stage,
      p_progress: Number(body.progress), p_message: String(body.message || '').slice(0, 300)
    }) };
  }
  throw new Error('ACTION_INVALID');
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method === 'GET') {
    try {
      const health = await rpc('processing_worker_health');
      return json({ ok: true, service: 'eastudy-local-cloud-worker', mode: 'local',
        configured: { worker: true, ffmpeg: Boolean(health?.capabilities?.ffmpeg),
          whisper: Boolean(health?.capabilities?.whisper), deepseek: Boolean(health?.capabilities?.deepseek) },
        worker: health, ready: Boolean(health?.ready) });
    } catch (error) {
      return json({ ok: false, ready: false, error: error instanceof Error ? error.message : String(error) }, 503);
    }
  }
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);
  let body: any;
  try { body = await request.json(); } catch { return json({ error: 'JSON_INVALID' }, 400); }
  const action = String(body?.action || '');
  if (action === 'run') {
    if (!env('CRON_SECRET') || request.headers.get('x-cron-secret') !== env('CRON_SECRET')) return json({ error: 'UNAUTHORIZED' }, 401);
    return json({ ok: true, mode: env('PROCESSING_MODE') || 'local', claimed: 0 });
  }
  if (!workerAuthorized(request)) return json({ error: 'UNAUTHORIZED' }, 401);
  try { return json({ ok: true, ...(await handleWorker(action, body)) }); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /INVALID|REQUIRED/.test(message) ? 400 : /LEASE_LOST|CANCELLED/.test(message) ? 409 : 500;
    return json({ ok: false, error: message }, status);
  }
});
