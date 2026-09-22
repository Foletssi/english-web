import { json, readJson, requireAdmin } from '../../_lib/auth.js';
import { createOrImportJob, replaceJob, readJob, listJobs } from '../../_lib/r2-processing.js';
async function control(env, body) { const url = `${new URL(env.PROCESSING_CONTROL_URL || 'https://english-web-lce.pages.dev/api/processing/control')}`; const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-worker-secret': String(env.WORKER_SECRET || '') }, body: JSON.stringify(body) }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error || `CONTROL_${response.status}`); return payload; }
function id(value) { const v=String(value||''); if(!/^[0-9a-f-]{36}$/i.test(v)) throw new Error('JOB_ID_INVALID'); return v; }
export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env); if (auth.error) return auth.error;
  const url = new URL(request.url); const action = url.searchParams.get('action') || 'list';
  try {
    if (action === 'health') return json({ data: await control(env, { action: 'worker-health', workerId: 'admin-proxy', capabilities: {} }) });
    if (action === 'get') return json({ data: await readJob(env.VIDEO_BUCKET, id(url.searchParams.get('id'))) });
    if (action === 'history') return json({ rows: [], total: 0, page: 1, pageSize: 25 });
    const jobs = await listJobs(env.VIDEO_BUCKET, Number(url.searchParams.get('limit') || 500));
    return json({ rows: jobs, total: jobs.length, page: 1, pageSize: jobs.length || 1, summary: jobs.reduce((s, job) => { const key = job.status === 'REVIEW' ? 'review' : job.status === 'ERROR' ? 'failed' : ['RUNNING','QUEUED','WAITING'].includes(job.status) ? 'active' : 'completed'; s[key] += 1; s.total += 1; return s; }, { active: 0, failed: 0, review: 0, completed: 0, cancelled: 0, total: 0 }) });
  } catch (error) { return json({ error: error?.message || 'PROCESSING_CONTROL_READ_FAILED' }, 502); }
}
export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env); if (auth.error) return auth.error;
  try {
    const body = await readJson(request, 256 * 1024); const action = String(body.action || '');
    if (action === 'create') {
      const job = await createOrImportJob(env.VIDEO_BUCKET, { id: body.id, video_id: body.videoId, source_key: body.sourceKey, input: body.input, requested_by: auth.user?.id || null, idempotency_key: body.idempotencyKey, status: 'QUEUED', stage: body.input?.kind === 'local' ? 'LOCAL_UPLOAD' : 'LOCAL_DOWNLOAD' });
      return json({ data: job });
    }
    const jobId = id(body.id); const job = await readJob(env.VIDEO_BUCKET, jobId); if (!job) return json({ error: 'JOB_NOT_FOUND' }, 404);
    if (action === 'retry' || action === 'recover') { const next = { ...job, status: 'QUEUED', error: null, lease_until: null, lease_token_hash: null, updated_at: new Date().toISOString(), input: body.input || job.input }; await replaceJob(env.VIDEO_BUCKET, next); return json({ data: next }); }
    if (action === 'cancel') { const next = { ...job, status: 'CANCELLED', updated_at: new Date().toISOString(), completed_at: new Date().toISOString() }; await replaceJob(env.VIDEO_BUCKET, next); return json({ data: next }); }
    return json({ error: 'PROCESSING_ACTION_INVALID' }, 400);
  } catch (error) { return json({ error: error?.message || 'PROCESSING_CONTROL_WRITE_FAILED' }, 502); }
}

