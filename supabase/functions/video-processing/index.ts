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
  if (!response.ok) throw new Error(`SUPABASE_${response.status}:${payload?.message || payload?.code || 'REQUEST_FAILED'}`);
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
  if (action === 'worker-claim') {
    await rpc('processing_worker_heartbeat', {
      p_worker_id: workerId, p_capabilities: capabilities, p_version: String(body.version || '').slice(0, 80) || null
    });
    const token = randomToken();
    const job = await rpc('processing_claim_local_job', {
      p_worker_id: workerId, p_token_hash: await sha256(token), p_lease_seconds: 240
    });
    if (!job) return { job: null };
    const base = required('PUBLIC_SOURCE_BASE_URL').replace(/\/$/, '');
    return {
      job, token, protocolVersion: job.run_id ? 2 : 1,
      downloadUrl: `${base}/api/processing/source?job=${encodeURIComponent(job.id)}&token=${encodeURIComponent(token)}`,
      outputUrl: `${base}/api/processing/output?job=${encodeURIComponent(job.id)}&token=${encodeURIComponent(token)}${job.run_id ? `&run=${encodeURIComponent(job.run_id)}` : ''}`
    };
  }
  const jobId = String(body.jobId || '');
  const token = String(body.token || '');
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || token.length < 32 || token.length > 256) throw new Error('JOB_TOKEN_INVALID');
  const runId = String(body.runId || '');
  const v2 = action.endsWith('-v2') || action.endsWith('-v4');
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
  if (action === 'worker-output-receipt-v2') {
    return { receipt: await rpc('processing_record_output_v2', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_path: String(body.path || ''), p_size: Number(body.size),
      p_sha256: String(body.sha256 || ''), p_etag: String(body.etag || '')
    }) };
  }
  if (action === 'worker-fail-v2') {
    return { job: await rpc('processing_fail_job_v2', {
      p_job_id: jobId, p_run_id: runId, p_token: token, p_worker_id: workerId,
      p_error: body.error || {}, p_retryable: body.retryable !== false
    }) };
  }
  if (action === 'worker-complete-v2') {
    return { result: await rpc('processing_commit_leased_result_v2', {
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
  if (action === 'worker-fail') {
    return { job: await rpc('processing_fail_job', {
      p_job_id: jobId, p_token: token, p_error: body.error || {}, p_retryable: body.retryable !== false
    }) };
  }
  if (action === 'worker-complete') {
    return { result: await rpc('processing_commit_leased_result', {
      p_job_id: jobId, p_token: token, p_result: body.result
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
