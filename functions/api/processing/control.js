import { json, readJson } from '../../_lib/auth.js';
import { claimJob, updateJob, recordReceipts, createOrImportJob, health, listJobs, readJob } from '../../_lib/r2-processing.js';

function authorized(request, env) { const secret = String(env.WORKER_SECRET || '').trim(); return Boolean(secret && request.headers.get('x-worker-secret') === secret); }
function workerPayload(body) { const workerId = String(body.workerId || '').trim(); if (!/^[A-Za-z0-9._-]{3,80}$/.test(workerId)) throw new Error('WORKER_ID_INVALID'); return { workerId, capabilities: body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {} }; }
function requireIds(body) { const jobId = String(body.jobId || ''), runId = String(body.runId || ''), token = String(body.token || ''); if (!/^[0-9a-f-]{36}$/i.test(jobId) || (runId && !/^[0-9a-f-]{36}$/i.test(runId)) || token.length < 32 || token.length > 256) throw new Error('JOB_TOKEN_INVALID'); return { jobId, runId, token }; }

async function handleAction(request, env, body) {
  if (!env.VIDEO_BUCKET) throw new Error('R2_VIDEO_BUCKET_NOT_BOUND');
  const action = String(body.action || '');
  if (action === 'worker-health') return { health: await health(env.VIDEO_BUCKET) };
  if (action === 'worker-heartbeat') { const { workerId, capabilities } = workerPayload(body); return { worker: { workerId, capabilities, version: String(body.version || ''), heartbeatAt: new Date().toISOString() } }; }
  if (action === 'worker-claim' || action === 'worker-claim-local-v1') {
    const { workerId, capabilities } = workerPayload(body);
    const localOnly = action.endsWith('local-v1');
    const claimed = await claimJob(env.VIDEO_BUCKET, { workerId, capabilities, localOnly });
    if (!claimed.job) return { job: null };
    const base = new URL(request.url).origin;
    const inputSource = claimed.job.input?.kind === 'local' || claimed.job.input?.kind === 'LOCAL_UPLOAD' ? { kind: 'local', sourceId: claimed.job.input.sourceId || null } : { kind: 'cloud_r2', key: claimed.job.source_key };
    return { ...claimed, protocolVersion: 3, workerId, inputSource, downloadUrl: inputSource.kind === 'local' ? null : `${base}/api/processing/source?job=${claimed.job.id}&token=${claimed.token}`, outputUrl: `${base}/api/processing/output?job=${claimed.job.id}&token=${claimed.token}&run=${claimed.job.run_id}` };
  }
  if (action === 'processing-bootstrap') {
    if (request.headers.get('x-control-admin') !== String(env.PROCESSING_MIGRATION_SECRET || '')) throw new Error('UNAUTHORIZED');
    const jobs = Array.isArray(body.jobs) ? body.jobs : []; for (const input of jobs) await createOrImportJob(env.VIDEO_BUCKET, input); return { imported: jobs.length };
  }
  if (action === 'processing-list') { if (!authorized(request, env)) throw new Error('UNAUTHORIZED'); return { jobs: await listJobs(env.VIDEO_BUCKET, body.limit) }; }
  if (action === 'run') return { claimed: 0, mode: 'r2-control' };
  const { workerId } = workerPayload(body); const { jobId, runId, token } = requireIds(body);
  if (action === 'worker-job-heartbeat-v2' || action === 'worker-job-heartbeat') return { job: await updateJob(env.VIDEO_BUCKET, jobId, runId || null, token, workerId, { lease_until: new Date(Date.now() + 600000).toISOString(), heartbeat_at: new Date().toISOString() }) };
  if (action === 'worker-telemetry-v2' || action === 'worker-progress') return { job: await updateJob(env.VIDEO_BUCKET, jobId, runId || null, token, workerId, { stage: String(body.stage || ''), progress: Math.max(0, Math.min(100, Number(body.progress) || 0)), message: String(body.message || '').slice(0, 300), work: { ...(body.work || {}), resumePosition: body.resumePosition || body.work?.resumePosition || null }, lease_until: new Date(Date.now() + 600000).toISOString(), heartbeat_at: new Date().toISOString(), last_progress_at: new Date().toISOString() }) };
  if (action === 'worker-output-receipt-v2') return { receipt: await recordReceipts(env.VIDEO_BUCKET, { jobId, runId, token, workerId, receipts: [{ path: body.path, size: Number(body.size), sha256: body.sha256, etag: body.etag }] }) };
  if (action === 'worker-output-receipts-v3') return { receipt: await recordReceipts(env.VIDEO_BUCKET, { jobId, runId, token, workerId, receipts: body.receipts }) };
  if (action === 'worker-validate-teaching-v2') { const sentences = Array.isArray(body.sentences) ? body.sentences : []; if (!sentences.length) throw new Error('PROCESSING_RESULT_SENTENCES_INVALID'); return { validation: { ok: true, sentenceCount: sentences.length, reviewStatus: 'approved', source: 'ai' } }; }
  if (action === 'worker-finalization-status-v3') { const job = await readJob(env.VIDEO_BUCKET, jobId); return { finalization: { state: job?.status === 'REVIEW' ? 'COMMITTED' : job?.status === 'WAITING' ? 'DEFERRED' : 'PENDING' } }; }
  if (action === 'worker-defer-v3') return { finalization: await updateJob(env.VIDEO_BUCKET, jobId, runId, token, workerId, { stage: 'WAITING', status: 'WAITING', error: body.error || null }) };
  if (action === 'worker-fail-v3') return { job: await updateJob(env.VIDEO_BUCKET, jobId, runId, token, workerId, { status: body.retryable === false ? 'ERROR' : 'QUEUED', error: body.error || null, lease_until: null, lease_token_hash: null }) };
  if (action === 'worker-complete-v3' || action === 'worker-complete-learning-v4' || action === 'worker-complete-learning-v5') return { result: await updateJob(env.VIDEO_BUCKET, jobId, runId, token, workerId, { status: 'REVIEW', stage: 'REVIEW', progress: 100, result: body.result || null, output_run_id: runId, completed_at: new Date().toISOString(), finalization_state: 'COMMITTED', lease_until: new Date(Date.now() + 600000).toISOString() }) };
  throw new Error('ACTION_INVALID');
}

export async function onRequestGet({ env }) { if (!env.VIDEO_BUCKET) return json({ ok: false, ready: false, error: 'R2_VIDEO_BUCKET_NOT_BOUND' }, 503); return json({ ok: true, ...(await health(env.VIDEO_BUCKET)) }); }
export async function onRequestPost({ request, env }) {
  if (!authorized(request, env) && request.headers.get('x-control-admin') !== String(env.PROCESSING_MIGRATION_SECRET || '')) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
  try { const declared = Number(request.headers.get('Content-Length')) || 0; const body = await readJson(request, declared > 512 * 1024 ? 16 * 1024 * 1024 : 512 * 1024); return json({ ok: true, ...(await handleAction(request, env, body)) }); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); const status = /UNAUTHORIZED/.test(message) ? 401 : /NOT_FOUND|TOKEN|INVALID|MISMATCH/.test(message) ? 400 : /LEASE_LOST/.test(message) ? 409 : 500; return json({ ok: false, error: message }, status); }
}




